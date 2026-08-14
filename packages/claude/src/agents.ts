/**
 * claude-mesh — background-agent lifecycle.
 *
 * The thin, account-explicit wrapper around `claude --bg`: spawn a background agent,
 * list/stop/tail agents, and read the local session registry to discover them. Every
 * call takes its account as an explicit `configDir` (there is no registry, no usage
 * cache, and no persisted state file here — see the decoupling notes below), so this
 * module is a pure function of its inputs plus the local `claude` CLI and filesystem.
 *
 * Decoupled from the orchestrator reference (src/mesh/pool.ts) on purpose:
 *   - No quota-aware placement. pool.ts ranked accounts by plan-window utilization,
 *     dropped logged-out / cooling-down / exhausted logins, and round-robined a batch
 *     across a healthy pool. Here the caller names the account, so there is nothing to
 *     rank and no usage/registry to read.
 *   - No mesh state file. pool.ts persisted a `workers[]` record set (spawnedAt, pid,
 *     role, …) and reconciled it (adopt/list/markStopped) under a read-modify-write of
 *     the whole state object. Here agents are discovered LIVE — `listAgents` shells the
 *     CLI, `listSessions` reads `<configDir>/sessions/` — so there is no durable record
 *     to keep, and no `adopt()`.
 *   - No model / frontier / overage gating. pool.ts refused unknown or frontier-tier
 *     models unless the operator opted in. This library passes the caller's model through.
 *   - Simpler name sequencing. pool.ts computed the next seq by scanning every candidate
 *     account's live registry AND the state file to survive a lost state file across
 *     accounts; here a module-level counter suffices because names are per-call and the
 *     caller may pass an explicit `name`.
 *   - Simpler pre-seed. pool.ts guarded its `.claude.json` edit with an O_EXCL lockfile
 *     and an in-lock re-read, because a long-lived gateway `claude -p` child was rewriting
 *     the same file on token refresh. This library ships no co-running gateway under the
 *     account, so `preseedProjectMcpTrust` is a single best-effort atomic tmp+rename with
 *     no lock (still never creating or clobbering-on-parse-failure the config).
 *   - stopAgent has no forced-SIGKILL fallback: it is exactly `claude stop <jobId>`.
 *
 * Zero runtime deps: node stdlib only, and imports restricted to ./types, ./protocol.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentHandle, AgentInfo, ClaudeEnv, SessionEntry, SpawnOptions } from './types';
import {
  accountConfigFile,
  agentName,
  applyProjectMcpTrust,
  isPidAlive,
  isPlainObject,
  parseSessionEntry,
  resolveConfigDir,
  sessionsDir,
} from './protocol';

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/** A `claude --bg` spawn must parse a job id AND exit 0 within this window (SIGKILL after). */
const SPAWN_TIMEOUT_MS = 30_000;
/** `claude stop <jobId>` budget before we report the clean path as failed. */
const STOP_TIMEOUT_MS = 15_000;
/** `claude agents --json --all` budget; a slow/hung CLI degrades to []. */
const LIST_TIMEOUT_MS = 15_000;
/** `claude logs <jobId>` budget. */
const LOGS_TIMEOUT_MS = 15_000;
/** Chars of captured output attached to a failure so the caller can triage without a flood. */
const OUTPUT_TAIL_CHARS = 600;
/** Default agent name label when the caller passes none (SpawnOptions has no `label`). */
const DEFAULT_LABEL = 'agent';
/** Default tool grant. Bash is deliberately absent — see SpawnOptions.allowedTools JSDoc. */
const DEFAULT_ALLOWED_TOOLS = 'ListAgents,SendMessage,Read,Write,Edit,Glob,Grep';
/** Default permission mode: `--bg` cannot use bypassPermissions without an interactive disclaimer. */
const DEFAULT_PERMISSION_MODE = 'acceptEdits';

/**
 * Substring the CLI prints when `--bg` refuses bypassPermissions because the one-time
 * INTERACTIVE disclaimer was never accepted. Its presence on a non-zero exit is the ONLY
 * trigger for the single acceptEdits retry in spawnAgent (verified live, 2026-08-10).
 */
const DISCLAIMER_MARKER = 'requires accepting the disclaimer';

/** Note attached to a handle when the disclaimer retry rescued the spawn. */
const DOWNGRADE_NOTE =
  'permission mode downgraded to acceptEdits (bypassPermissions needs an interactive disclaimer)';

/**
 * The `--bg` line reports the job id between two U+00B7 middle dots:
 * `backgrounded · <jobId> · <name>`. The `·` is written explicitly (U+00B7) so the
 * pattern cannot silently rot into an ASCII look-alike in an editor. A parsed job id is
 * a HARD requirement for success — a clean exit with no id is still a spawn failure.
 */
const JOB_ID_RE = /backgrounded\s+·\s+([0-9a-f]+)\s+·\s+/;

/**
 * Per-process monotonic sequence for auto-derived agent names. Starts at 1 so the first
 * auto-named agent gets seq 1. Deliberately time-free and counter-only: names stay stable
 * and reproducible within a run, and the workspace hash in `agentName` already keeps two
 * workspaces from colliding. Callers needing cross-process uniqueness pass an explicit `name`.
 */
let spawnSeq = 1;

/* ------------------------------------------------------------------------- *
 * Internal process runner
 * ------------------------------------------------------------------------- */

/** What a child process settled to. `code` is null on a spawn error or a signal kill. */
interface ProcOutcome {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Signal the child's WHOLE process group, not just the direct child (A2; mirrors exec.ts).
 *
 * A `claude` invocation spawns helpers that inherit our stdout/stderr pipe FDs. Killing only the
 * direct child leaves those grandchildren holding the pipes open, so the child's `'close'` event
 * — which waits for all stdio to drain — does not fire until a grandchild exits on its own
 * (observed ~30s). Because the child is spawned `detached:true` (POSIX group; macOS/Linux),
 * `-child.pid` addresses the whole group, reaping the grandchildren too. Falls back to a direct
 * `child.kill` when the group send fails (pid gone) or the pid is unknown.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // group already gone (or not permitted) — fall through to a direct kill
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/**
 * Run a child to completion, collecting stdout+stderr into one `output` buffer. NEVER
 * rejects: a synchronous spawn throw, an async 'error', a non-zero exit, and a timeout
 * all resolve a ProcOutcome the caller classifies. On timeout the child is SIGKILLed and
 * we settle from the subsequent 'close'. No shell — argv only, so a prompt or flag value
 * has no interpolation surface to break out of.
 *
 * Modeled on pool.ts's runProcess, minus its `spawnError` flag: a spawn failure here is
 * simply `code: null` with the error text folded into `output`, which every caller's
 * `code === 0` success test already rejects.
 *
 * A2: the child is spawned `detached:true` so a timeout can reap its WHOLE process group (see
 * {@link killGroup}); killing only the direct child would leave pipe-inheriting grandchildren
 * holding stdout/stderr open and defer the settling `'close'` for ~30s. As a belt-and-braces, the
 * child's read ends are destroyed on `'exit'` once a timeout has tripped so `'close'` fires
 * promptly even if an inherited FD outlives the group kill. Exported for its regression test.
 */
export function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ProcOutcome> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    const done = (o: ProcOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };
    let child: ChildProcess;
    try {
      // Own process group so a timeout kill can reap the whole tree (see killGroup).
      child = spawn(cmd, args, { cwd, env, detached: true });
    } catch (e) {
      resolve({ code: null, output: `spawn threw: ${(e as Error).message}`, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      // Signal the whole group, not just the direct child, so inherited-pipe grandchildren die too.
      killGroup(child, 'SIGKILL');
    }, timeoutMs);
    // Streaming-safe UTF-8 decoding (A1): a multi-byte character split across a pipe chunk is held
    // over the boundary by the StringDecoder instead of each half decoding to U+FFFD.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      output += d;
    });
    child.stderr?.on('data', (d: string) => {
      output += d;
    });
    // Once a timeout has tripped, drop our read ends as soon as the direct child exits so `'close'`
    // fires promptly even if some inherited FD outlives the group kill.
    child.on('exit', () => {
      if (timedOut) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    });
    child.on('error', (e) => done({ code: null, output: `${output}\nspawn error: ${e.message}`, timedOut }));
    child.on('close', (code) => done({ code, output, timedOut }));
  });
}

/** Last `n` non-blank chars of `s`, ellipsized — enough context for a failure without a flood. */
function tail(s: string, n: number = OUTPUT_TAIL_CHARS): string {
  const trimmed = s.trim();
  return trimmed.length > n ? `…${trimmed.slice(-n)}` : trimmed;
}

/** One-line cause of a non-successful ProcOutcome for an error message. */
function describeFailure(o: ProcOutcome): string {
  if (o.timedOut) {
    return 'did not exit within the timeout';
  }
  if (o.code === null) {
    return 'spawn error';
  }
  if (o.code !== 0) {
    return `exited with code ${o.code}`;
  }
  return 'no job id in output';
}

/** The env a `claude` invocation runs under: inherited env plus the pinned config dir. */
function claudeChildEnv(configDir: string): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_CONFIG_DIR: configDir };
}

/* ------------------------------------------------------------------------- *
 * Spawn
 * ------------------------------------------------------------------------- */

/**
 * Spawn one `claude --bg` background agent under an explicit account and return a handle.
 *
 * ARGV ORDER IS LOAD-BEARING. `--allowedTools` is a VARIADIC option (it accepts a
 * comma-OR-space-separated list), so any positional placed immediately after its value is
 * swallowed into the tool list. That exact footgun once made the prompt vanish and agents
 * boot promptless (pool.ts scenario-B, 2026-08-10). The bounded `--name <value>` pair is
 * therefore pinned LAST before the prompt positional, fencing the variadic off from it.
 *
 * DISCLAIMER FALLBACK. `claude --bg` under bypassPermissions demands a one-time
 * interactive disclaimer it cannot show headless, so it exits non-zero with
 * DISCLAIMER_MARKER in its output. On that exact signal we retry ONCE with acceptEdits
 * (same name, same argv otherwise) and, on success, report the downgrade via `note`. The
 * first attempt writes no durable state, so reusing the name is safe.
 *
 * SUCCESS = a parsed job id (JOB_ID_RE) AND a clean exit 0 within SPAWN_TIMEOUT_MS. A
 * hang (SIGKILLed → timedOut), a spawn error, a non-zero exit, or a clean exit with no
 * job id are all failures, with the output tail attached for triage.
 */
export async function spawnAgent(opts: SpawnOptions): Promise<AgentHandle> {
  const configDir = resolveConfigDir(opts.configDir);
  const cwd = opts.cwd ?? process.cwd();
  const claudePath = opts.claudePath ?? 'claude';
  const model = opts.model;
  const permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const allowedTools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const name = opts.name ?? agentName(cwd, DEFAULT_LABEL, spawnSeq++);

  // Best-effort pre-seed so a project's `.mcp.json` cannot raise an un-answerable trust
  // prompt that blocks the agent at boot. Any failure is swallowed — the spawn proceeds
  // and either boots or fails visibly, which beats surfacing a pre-seed error.
  if (opts.preseedMcpTrust) {
    try {
      preseedProjectMcpTrust(cwd, configDir);
    } catch {
      // swallow — pre-seed is an optimization, never a precondition
    }
  }

  const env = claudeChildEnv(configDir);

  // One attempt against a given permission mode; the retry reuses this verbatim with only
  // the mode swapped, so there is a single spawn code path.
  const attempt = (mode: string): Promise<ProcOutcome> => {
    const args: string[] = [
      '--bg',
      ...(model ? ['--model', model] : []),
      '--permission-mode',
      mode,
      // strictMcpConfig defaults TRUE: only load servers from an explicit --mcp-config so a
      // project `.mcp.json` cannot raise a boot-blocking trust prompt. It is a valueless
      // boolean flag; add nothing only when the caller explicitly passes false.
      ...(opts.strictMcpConfig !== false ? ['--strict-mcp-config'] : []),
      '--allowedTools',
      allowedTools,
      // `--name` MUST be the last option before the prompt — see the ARGV ORDER note above.
      '--name',
      name,
      opts.prompt,
    ];
    return runProcess(claudePath, args, cwd, env, SPAWN_TIMEOUT_MS);
  };

  let outcome = await attempt(permissionMode);
  let note: string | undefined;
  // Retry ONLY the disclaimer failure: a real non-zero exit (not a timeout, not a spawn
  // error) whose combined output names the interactive disclaimer. Every other failure
  // falls straight through to the failure return below, unretried.
  if (!outcome.timedOut && outcome.code !== 0 && outcome.output.includes(DISCLAIMER_MARKER)) {
    outcome = await attempt(DEFAULT_PERMISSION_MODE);
    note = DOWNGRADE_NOTE;
  }

  const jobId = JOB_ID_RE.exec(outcome.output)?.[1];
  if (outcome.timedOut || outcome.code !== 0 || !jobId) {
    return {
      ok: false,
      name,
      configDir,
      error: `spawn failed: ${describeFailure(outcome)}. output: ${tail(outcome.output)}`,
    };
  }
  return {
    ok: true,
    name,
    jobId,
    configDir,
    model,
    attachCommand: attachCommand(jobId, configDir, claudePath),
    ...(note ? { note } : {}),
  };
}

/* ------------------------------------------------------------------------- *
 * List / stop / logs
 * ------------------------------------------------------------------------- */

/**
 * List the account's background agents via `claude agents --json --all`. Returns [] on
 * ANY failure (bad exit, timeout, unparseable output).
 *
 * NOTE: runProcess merges stdout+stderr, so a diagnostic line on stderr could sit around
 * the JSON payload. We first try to parse the whole buffer, then fall back to isolating
 * the outermost `[...]` / `{...}` span before giving up — a cheap tolerance for that
 * merge without a full brace-matcher.
 */
export async function listAgents(env?: ClaudeEnv): Promise<AgentInfo[]> {
  const configDir = resolveConfigDir(env?.configDir);
  const claudePath = env?.claudePath ?? 'claude';
  const outcome = await runProcess(
    claudePath,
    ['agents', '--json', '--all'],
    process.cwd(),
    claudeChildEnv(configDir),
    LIST_TIMEOUT_MS,
  );
  if (outcome.timedOut || outcome.code !== 0) {
    return [];
  }
  const parsed = parseLooseJson(outcome.output);
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray(parsed.agents)
      ? parsed.agents
      : [];
  const out: AgentInfo[] = [];
  for (const row of rows) {
    if (!isPlainObject(row) || typeof row.id !== 'string') {
      continue;
    }
    out.push({
      jobId: row.id,
      name: typeof row.name === 'string' ? row.name : undefined,
      sessionId: typeof row.sessionId === 'string' ? row.sessionId : undefined,
      cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
      state: typeof row.state === 'string' ? row.state : undefined,
      startedAt: typeof row.startedAt === 'number' ? row.startedAt : undefined,
    });
  }
  return out;
}

/**
 * Parse JSON that may be padded by stderr noise on either side. Tries the whole trimmed
 * buffer first, then the outermost bracketed span. Returns undefined when nothing parses.
 */
function parseLooseJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to the bracketed-span attempt
  }
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Stop a background agent by job id: `claude stop <jobId>` under its account's config dir
 * (a job id is only meaningful to the config dir that spawned it). ok on a clean exit 0.
 */
export async function stopAgent(jobId: string, env?: ClaudeEnv): Promise<{ ok: boolean; error?: string }> {
  const configDir = resolveConfigDir(env?.configDir);
  const claudePath = env?.claudePath ?? 'claude';
  const outcome = await runProcess(
    claudePath,
    ['stop', jobId],
    process.cwd(),
    claudeChildEnv(configDir),
    STOP_TIMEOUT_MS,
  );
  if (!outcome.timedOut && outcome.code === 0) {
    return { ok: true };
  }
  return { ok: false, error: `claude stop failed: ${describeFailure(outcome)}. output: ${tail(outcome.output)}` };
}

/**
 * Tail a background agent's log via `claude logs <jobId>`. Returns the combined output;
 * on a spawn/timeout failure the error text (which runProcess folds into `output`) is
 * returned instead, so callers always get a string.
 */
export async function agentLogs(jobId: string, env?: ClaudeEnv): Promise<string> {
  const configDir = resolveConfigDir(env?.configDir);
  const claudePath = env?.claudePath ?? 'claude';
  const outcome = await runProcess(
    claudePath,
    ['logs', jobId],
    process.cwd(),
    claudeChildEnv(configDir),
    LOGS_TIMEOUT_MS,
  );
  return outcome.output;
}

/**
 * A copy-pasteable attach command. The config dir is SINGLE-QUOTED so a path containing
 * spaces stays one shell token when a human pastes it into a terminal.
 */
export function attachCommand(jobId: string, configDir?: string, claudePath = 'claude'): string {
  return `CLAUDE_CONFIG_DIR='${resolveConfigDir(configDir)}' ${claudePath} attach ${jobId}`;
}

/* ------------------------------------------------------------------------- *
 * Project MCP-trust pre-seed
 * ------------------------------------------------------------------------- */

/**
 * Pre-seed an account's `.claude.json` so a `--bg` agent in a project that ships a
 * `.mcp.json` boots unattended instead of halting on the un-answerable "New MCP server
 * found … Use this server?" trust prompt. Returns true only when it actually wrote a
 * change. TOTALLY BEST-EFFORT — every path is guarded and any error yields false.
 *
 * Contract, in order:
 *   1. Read `<cwd>/.mcp.json` for its `mcpServers` keys — [] if absent/unparseable
 *      (never throws; pre-seed then only records folder trust).
 *   2. If `<configDir>/.claude.json` does NOT exist, return false — never CREATE a config
 *      for a never-logged-in account.
 *   3. Read + JSON.parse it; on a parse failure return false WITHOUT writing — never
 *      overwrite a config we could not read.
 *   4. applyProjectMcpTrust decides the edit (folder trust + servers disabled = least
 *      privilege). If it reports no change, return false (idempotent).
 *   5. Otherwise write ATOMICALLY: serialize to a tmp file in the SAME directory (so the
 *      rename is atomic on one filesystem), then renameSync over the original — a reader
 *      never sees a torn file, and applyProjectMcpTrust mutates in place so unmodeled keys
 *      ride through untouched.
 */
export function preseedProjectMcpTrust(cwd: string, configDir?: string): boolean {
  try {
    let names: string[] = [];
    try {
      const rawMcp: unknown = JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8'));
      const servers = isPlainObject(rawMcp) ? rawMcp.mcpServers : undefined;
      if (isPlainObject(servers)) {
        names = Object.keys(servers);
      }
    } catch {
      // missing or unparseable .mcp.json — no project servers to pre-decide
    }

    const configPath = accountConfigFile(resolveConfigDir(configDir));
    if (!fs.existsSync(configPath)) {
      return false; // never create a config for an account that has none
    }
    let config: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!isPlainObject(parsed)) {
        return false;
      }
      config = parsed;
    } catch {
      return false; // never overwrite a config we could not parse
    }

    const { changed } = applyProjectMcpTrust(config, cwd, names);
    if (!changed) {
      return false;
    }
    const tmpPath = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------- *
 * Session discovery (reads the local registry directly)
 * ------------------------------------------------------------------------- */

/**
 * Every well-formed session-registry entry under `<configDir>/sessions/`. A missing dir,
 * a non-`.json` file, and a single unreadable/corrupt/invalid entry are all skipped —
 * never fatal — so one bad file cannot blind the caller to the rest of the mesh.
 */
export function listSessions(configDir?: string): SessionEntry[] {
  const dir = sessionsDir(resolveConfigDir(configDir));
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return []; // no sessions dir yet
  }
  const out: SessionEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) {
      continue;
    }
    try {
      const entry = parseSessionEntry(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      if (entry) {
        out.push(entry);
      }
    } catch {
      // one unreadable/corrupt entry must not hide the rest of the dir
    }
  }
  return out;
}

/** The first LIVE session (by pid) whose name matches, or undefined. */
export function findSession(name: string, configDir?: string): SessionEntry | undefined {
  return listSessions(configDir).find((e) => e.name === name && isPidAlive(e.pid));
}

/** True when the entry's process is still alive and signalable by us (EPERM counts as alive). */
export function isSessionAlive(entry: SessionEntry): boolean {
  return isPidAlive(entry.pid);
}
