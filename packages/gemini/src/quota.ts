/**
 * Antigravity quota read.
 *
 * IMPORTANT: this runs ONLY in the user's own runtime, under the user's own `agy`
 * login — it is never proxied through a server, and it touches no token. `agy`
 * (≥ 1.1.11) answers its OWN usage in print mode: `agy -p /usage --output-format
 * json` runs the `/usage` slash command — no agent turn (`num_turns: 0`), no quota
 * spent, all-zero `usage` — and prints ONE JSON object. agy fetches the numbers
 * with its own credential, so this module never reads, holds, or refreshes one.
 *
 * Body shape (verified live on agy 1.3.5; every bucket field optional):
 *
 *   { status: "SUCCESS", num_turns: 0, response, usage: {…all 0},
 *     command: { name: "usage", data: { description?, groups: [
 *       { name: "Gemini Models", description?, buckets: [
 *         { id: "gemini-weekly", name, description?, window: "weekly", disabled?,
 *           remaining_fraction: 0.99969…, remaining_amount?, reset_time: RFC 3339 } … ] },
 *       { name: "Claude and GPT models", buckets: [ … ] } ] } } }
 *
 * Every failure path — the private working directory cannot be made, a spawn error,
 * a non-zero exit, the deadline, more than {@link MAX_USAGE_STDOUT_BYTES} of stdout,
 * an `AGY_ERROR:` / `error:` line, a body of another shape, no usable bucket —
 * resolves `null`, the honest "headroom unknown" signal. Nothing here throws.
 *
 * The process is started through the adapter's {@link ExecFn} seam and nowhere else:
 * a host injects that seam to see (and register) every child before it exists, so a
 * direct child_process call here would start a process the host cannot track.
 */
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { QuotaSnapshot, QuotaWindow } from '@toragonite/agent-mesh';
import type { ExecFn } from './exec.js';
import { isRecord, pickLastJsonObject } from './parse.js';

/** The argv of the usage read, verbatim. The slash command is the VALUE of `-p`. */
export const USAGE_ARGS: readonly string[] = ['-p', '/usage', '--output-format', 'json'];

/**
 * The PREFIX of the private working directory's name under the OS temp dir. Since 0.1.4 the
 * directory itself is per user — see {@link usageDirName} — so another local user who creates
 * the shared name in a shared `/tmp` first (or simply ran their own reads) no longer blocks
 * this user's usage reads.
 */
export const USAGE_DIR_NAME = 'agent-mesh-agy-usage';

/** The longest username suffix kept on a platform without `process.getuid` (Windows). */
const MAX_USER_SUFFIX_CHARS = 64;

/**
 * The private working directory's name for THIS user (since 0.1.4):
 * `agent-mesh-agy-usage-<uid>` where `process.getuid` exists (POSIX); elsewhere
 * `agent-mesh-agy-usage-<username>`, the OS username with every character outside
 * `[A-Za-z0-9._-]` replaced by `_` and cut to 64 characters — `user` when it is unavailable
 * or blank. Always a single path component. Never throws.
 */
export function usageDirName(): string {
  if (typeof process.getuid === 'function') {
    try {
      const uid = process.getuid();
      if (Number.isSafeInteger(uid) && uid >= 0) return `${USAGE_DIR_NAME}-${uid}`;
    } catch {
      // fall through to the username
    }
  }
  let name = '';
  try {
    name = userInfo().username;
  } catch {
    name = '';
  }
  const safe = (typeof name === 'string' ? name : '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, MAX_USER_SUFFIX_CHARS);
  // A name of dots only ('.', '..') is a real path component of its own; keep the suffix opaque.
  const suffix = safe === '' || /^\.+$/.test(safe) ? 'user' : safe;
  return `${USAGE_DIR_NAME}-${suffix}`;
}

/**
 * Stdout cap. The real answer is well under 4 KiB; anything past 1 MiB is not a usage
 * answer, and the cap keeps a runaway child from growing the parent's memory.
 */
export const MAX_USAGE_STDOUT_BYTES = 1_048_576;

/** Default wall-clock cap for one read — each call boots agy's language server (a few seconds). */
export const DEFAULT_QUOTA_TIMEOUT_MS = 90_000;

/** Default per-account cache of a read's outcome (snapshot OR null), in ms. */
export const DEFAULT_QUOTA_CACHE_MS = 60_000;

/**
 * How far above 1 a `remaining_fraction` may be and still count as a fraction. The
 * value travels as a float32 (0.93780001), so 1 can arrive a hair high; a value well
 * above 1 is not a fraction of the window at all (a percentage, say) — see mapBucket.
 */
const FRACTION_SLACK = 1e-6;

/** RFC 3339 date-time, as agy sends `reset_time` (`2026-10-20T07:57:54Z`). */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * A line in which agy reports a failed command: its structured `AGY_ERROR: {…}` line, or
 * a plain `error:` / `Error:` line (e.g. "Error: authentication required. Run '…' to log
 * in."). A reading printed alongside either is not trusted. Matched at a line start only,
 * so a word inside a JSON string (where newlines are escaped) can never match.
 */
const ERROR_LINE = /^\s*(AGY_ERROR:|error:)/im;

/** The per-user private working directory: `<os tmpdir>/agent-mesh-agy-usage-<uid>` ({@link usageDirName}). */
export function usageCwd(): string {
  return join(tmpdir(), usageDirName());
}

/**
 * Make `dir` (0700) if absent, then make sure it is PRIVATE before agy runs in it.
 *
 * agy treats its working directory as a workspace, and on Linux the OS temp dir is the
 * shared `/tmp`: another local user could create this path first and fill it with
 * workspace configuration. (The per-user name means no OTHER user's own reads ever create
 * it; a user who pre-creates it deliberately still only makes this user's read refuse.) So the directory is used only when it is a real directory
 * (not a symlink), owned by this process's user, with mode exactly 0700 — a directory
 * we own with other bits (0755, say) is set to 0700; anything else resolves false and the
 * read resolves `null` without spawning. (Ownership and mode bits are not consulted on
 * Windows, where they do not carry this meaning.) Never throws.
 */
export async function ensurePrivateDir(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (process.platform === 'win32') return true;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && st.uid !== uid) return false;
    // Exactly 0700: no group/other bits, and full owner access even under an odd umask.
    if ((st.mode & 0o777) === 0o700) return true;
    await chmod(dir, 0o700);
    return ((await lstat(dir)).mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

/** A trimmed non-blank string, or undefined. */
function nonBlank(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined;
  const t = x.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * `reset_time` as an ISO instant, or undefined. Only an RFC 3339 date-time counts —
 * `Date.parse` alone would read "1" as the year 2001 — and an instant at or before
 * the Unix epoch is an unset field (an empty Go `time.Time` prints as year 1), not a
 * reset, so it reads as absent.
 */
function resetIso(x: unknown): string | undefined {
  if (typeof x !== 'string' || !RFC3339.test(x)) return undefined;
  const ms = Date.parse(x);
  if (Number.isNaN(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

/**
 * `(1 − fraction) × 100`, rounded to one decimal and clamped to 0..100, or undefined
 * when there is no usable fraction. Rounding absorbs the float32 noise (0.93780001 →
 * 6.2). A fraction below 0 is an over-consumed window and clamps to 100. A fraction
 * above 1 (past {@link FRACTION_SLACK}) is NOT clamped to 0: that would report a value
 * of another unit — a percentage, say — as full headroom, so it reads as unknown.
 */
function usedPercentOf(fraction: unknown): number | undefined {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return undefined;
  if (fraction > 1 + FRACTION_SLACK) return undefined;
  const rounded = Math.round((1 - fraction) * 1000) / 10;
  return Math.min(100, Math.max(0, rounded)); // Math.max(0, -0) is +0
}

/**
 * One bucket → one window, or undefined when the bucket is disabled or has no
 * percentage.
 *
 * Only `remaining_fraction` yields a percentage. A bucket with `remaining_amount`
 * alone is skipped: the payload carries no limit to divide the amount by, so any
 * percentage would be invented. A bucket with neither is skipped too — and agy's
 * types print `remaining_amount: 0` when the server sent neither, so an amount of 0
 * with no fraction is UNKNOWN, never "exhausted".
 *
 * Label: the bucket `id` when non-blank, else `<group name> <window>` (whichever of
 * the two are non-blank), else the bucket `name`, else `usage`.
 */
function mapBucket(groupName: string | undefined, bucket: unknown): QuotaWindow | undefined {
  if (!isRecord(bucket)) return undefined;
  if (bucket.disabled === true) return undefined;
  const usedPercent = usedPercentOf(bucket.remaining_fraction);
  if (usedPercent === undefined) return undefined;
  const composed = [groupName, nonBlank(bucket.window)].filter((s): s is string => s !== undefined).join(' ');
  const label = nonBlank(bucket.id) ?? (composed || undefined) ?? nonBlank(bucket.name) ?? 'usage';
  const window: QuotaWindow = { label, usedPercent };
  const resetAt = resetIso(bucket.reset_time);
  if (resetAt) window.resetAt = resetAt;
  return window;
}

/**
 * Map the `/usage` payload to a QuotaSnapshot, or null when it is not a successful
 * usage answer with at least one usable window.
 *
 * Required: `status === "SUCCESS"`, `command.name === "usage"` (a payload naming any
 * other command is not this answer, whatever its shape), and `command.data.groups` an
 * array. Windows come one per enabled bucket with a percentage, groups in order then
 * buckets in order. agy states no gate of its own, so `allowed` is derived PER GROUP: a
 * group is a model family ("Gemini Models", "Claude and GPT models") whose own windows gate
 * it, and the account can still take work while ANY group has every one of its windows
 * under 100% — an exhausted Claude/GPT limit must not shut out Gemini work. (Which group a
 * given dispatch draws on depends on its model, which this snapshot does not know; a caller
 * that does can read the windows.) `raw` is the `command.data` object. Never throws.
 */
export function mapUsagePayload(payload: Record<string, unknown>): QuotaSnapshot | null {
  if (payload.status !== 'SUCCESS') return null;
  const command = payload.command;
  if (!isRecord(command) || command.name !== 'usage') return null;
  const data = command.data;
  if (!isRecord(data) || !Array.isArray(data.groups)) return null;
  const windows: QuotaWindow[] = [];
  let anyGroupOpen = false;
  for (const group of data.groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const groupName = nonBlank(group.name);
    const groupWindows: QuotaWindow[] = [];
    for (const bucket of group.buckets) {
      const window = mapBucket(groupName, bucket);
      if (window) groupWindows.push(window);
    }
    if (groupWindows.length > 0 && !groupWindows.some((w) => w.usedPercent >= 100)) anyGroupOpen = true;
    windows.push(...groupWindows);
  }
  if (windows.length === 0) return null;
  const allowed = anyGroupOpen;
  return { vendor: 'gemini', windows, allowed, raw: data };
}

/**
 * The payload object from stdout: the whole (trimmed) stdout when it is one JSON
 * document, else the last line that parses as a JSON object (tolerating a stray
 * banner line, as run() does). Undefined when there is none.
 */
function parseUsageStdout(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const whole: unknown = JSON.parse(trimmed);
    return isRecord(whole) ? whole : undefined;
  } catch {
    return pickLastJsonObject(stdout);
  }
}

/** Everything one usage read needs; the adapter supplies each from its own seams. */
export interface UsageReadRequest {
  /** The adapter's process seam — the ONLY way this read starts a process. */
  exec: ExecFn;
  /** The configured agy binary. */
  binary: string;
  /** The account's child env, exactly as run() builds it. */
  env: Record<string, string | undefined>;
  /** Wall-clock cap passed to the seam (it kills the whole process group at it). */
  timeoutMs: number;
}

/**
 * Run `agy -p /usage --output-format json` once through the seam and map its answer.
 * stdin is the null device, the cwd is the private {@link usageCwd}, stdout is capped
 * at {@link MAX_USAGE_STDOUT_BYTES} (re-checked here, since a host's own seam may not
 * honour `maxStdoutBytes`). Resolves the snapshot or `null`; never rejects.
 */
export async function readAgyUsage(req: UsageReadRequest): Promise<QuotaSnapshot | null> {
  try {
    const cwd = usageCwd();
    if (!(await ensurePrivateDir(cwd))) return null;
    const res = await req.exec({
      cmd: req.binary,
      args: [...USAGE_ARGS],
      cwd,
      env: req.env,
      timeoutMs: req.timeoutMs,
      ignoreStdin: true,
      maxStdoutBytes: MAX_USAGE_STDOUT_BYTES,
    });
    if (res.timedOut) return null;
    if (res.stdoutOverflow === true) return null;
    const stdout = typeof res.stdout === 'string' ? res.stdout : '';
    const stderr = typeof res.stderr === 'string' ? res.stderr : '';
    if (Buffer.byteLength(stdout, 'utf8') > MAX_USAGE_STDOUT_BYTES) return null;
    if (res.exitCode !== 0) return null; // includes null: killed by a signal
    if (ERROR_LINE.test(stdout) || ERROR_LINE.test(stderr)) return null;
    const payload = parseUsageStdout(stdout);
    return payload ? mapUsagePayload(payload) : null;
  } catch {
    return null; // a spawn failure (ENOENT: agy not installed) or a seam that threw
  }
}
