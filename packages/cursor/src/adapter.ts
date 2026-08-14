/**
 * CursorAdapter — drives Cursor's official `cursor-agent` CLI headlessly behind
 * the frozen agent-mesh {@link Adapter} contract.
 *
 * Runs `cursor-agent -p --output-format json` (one-shot), `--resume <id>` (revise
 * a conversation), and `-p --output-format stream-json --stream-partial-output`
 * (incremental events) under the user's own Cursor login. Introspection
 * (`authStatus`/`availableModels`) shells out to the CLI; `quota()` returns null
 * by design (Cursor exposes no verified usage endpoint).
 *
 * Every side-effecting seam — the run-to-completion exec, the line stream — is
 * injectable through the constructor, so the whole surface is testable with no
 * real CLI, no network, and no real home directory. No token or secret value
 * ever appears in a result, error, note, detail, or raw payload.
 *
 * Empirical ground truth this adapter is built on:
 * - The prompt is a trailing POSITIONAL and the CLI is commander-based, so a `--`
 *   fence before the prompt is MANDATORY: a prompt beginning with `--model` fails
 *   without it and succeeds behind it.
 * - The workspace-trust gate EXITS (does not hang) after ~21s; `--trust` skips it.
 * - `cursor-agent create-chat` mints a bare UUID; `--resume <id>` preserves context.
 * - A one-word answer takes ~30s — the slowest vendor in this repo.
 */
import {
  AdapterExecError,
  AgentMeshError,
  type Account,
  type Adapter,
  type AdapterCapabilities,
  type AuthStatus,
  type ModelInfo,
  type QuotaSnapshot,
  type ResumeOptions,
  type RunEvent,
  type RunResult,
  type RunStatus,
  type RunTask,
  type Vendor,
} from '@toragonite/agent-mesh';
import { nodeExec, nodeLineStream, type ExecFn, type LineStreamFn, type StreamEndMeta } from './exec.js';
import { curatedModels, cloneModel, parseModelsOutput } from './models.js';
import { isRecord, mapResultPayload, parseCursorJson, str, type MappedResult } from './parse.js';

const VENDOR: Vendor = 'cursor';

/** Max stderr bytes attached to an AdapterExecError, so a failure is diagnosable without a flood. */
const STDERR_CAP = 4_096;

/**
 * How many bytes of a stream's stdout head to retain for trust-refusal detection (A4). The
 * refusal is a pre-run gate that exits immediately with only the banner, so the head suffices
 * and the cap keeps a long normal stream from accumulating its whole output in memory.
 */
const TRUST_SCAN_CAP = 8_192;

export interface CursorAdapterOptions {
  /** Run-to-completion process seam. Default: {@link nodeExec}. */
  exec?: ExecFn;
  /** Streaming process seam for `stream()`. Default: {@link nodeLineStream}. */
  lineStream?: LineStreamFn;
  /** The cursor-agent executable path or command name. Default: `'cursor-agent'`. */
  binary?: string;
  /** Account used when a call passes none. */
  defaultAccount?: Account;
  /**
   * Environment seam and the base of the child env. Default: {@link process.env}.
   * Injecting it keeps introspection and execution resolving the same environment
   * and lets tests avoid mutating global `process.env`.
   */
  env?: Record<string, string | undefined>;
  /**
   * Whether to pass `--trust` (default TRUE). A library driving a headless agent
   * in a directory the CALLER chose must not stall ~21s per task on an interactive
   * trust prompt — choosing to run a coding agent in that cwd IS the trust
   * decision. `--force`/`--yolo` is a stronger, different grant (run everything);
   * this adapter NEVER passes it.
   */
  trust?: boolean;
  /** Short-circuit the live `cursor-agent models` read (hermetic tests / offline use). */
  models?: ModelInfo[];
  /** Wall-clock cap for the `authStatus()` CLI probe, in ms. Default: 20000. */
  authTimeoutMs?: number;
  /** Wall-clock cap for the `availableModels()` CLI probe, in ms. Default: 20000. */
  modelsTimeoutMs?: number;
  /**
   * How long a FAILED `cursor-agent models` probe caches the curated fallback, in
   * ms (default 60000). A successful read is memoized for the life of the instance;
   * a failure caches the fallback for this window so a transient failure can still
   * recover later but cannot spawn a subprocess on every routing decision (A3).
   */
  modelsCacheMs?: number;
}

function isNonEmpty(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

function truncate(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) : s;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Verbatim extra CLI args from `extra.args`, keeping only strings and reporting
 * how many non-string entries were dropped so the caller can surface a note (U5).
 */
function extraArgs(extra: Record<string, unknown> | undefined): { args: string[]; dropped: number } {
  const raw = extra?.args;
  if (!Array.isArray(raw)) return { args: [], dropped: 0 };
  const args = raw.filter((a): a is string => typeof a === 'string');
  return { args, dropped: raw.length - args.length };
}

/**
 * True when combined output signals the workspace-trust refusal (ground truth B).
 * The CLI exits non-zero with `⚠ Workspace Trust Required` / `Pass --trust, --yolo,
 * or -f ...`. Matched generically so it is caught whether or not `--trust` was sent.
 */
function isTrustRefusal(exitCode: number | null, combined: string): boolean {
  if ((exitCode ?? 0) === 0) return false;
  return /workspace trust required/i.test(combined) || /pass --trust/i.test(combined);
}

/** Remediation message for a trust refusal; names the cwd and points at the `trust` option. */
function trustMessage(cwd: string | undefined): string {
  const where = cwd ?? 'the current working directory';
  return (
    `cursor-agent refused to run: workspace trust is required for ${where}. ` +
    `Pass { trust: true } (the default) to send --trust, or trust the directory in Cursor.`
  );
}

/** Notes accumulated before/around a run; assembled into RunResult.note joined with '; '. */
function joinNotes(notes: string[]): string | undefined {
  return notes.length > 0 ? notes.join('; ') : undefined;
}

interface MapContext {
  cwd?: string;
  timeoutMs?: number;
  /** Model override from the request (task.model / opts.model); never the payload's display name. */
  modelOverride?: string;
  /** Fall back to this id when the payload echoes no session (resume only). */
  fallbackId?: string;
  notes: string[];
}

export class CursorAdapter implements Adapter {
  readonly vendor: Vendor = VENDOR;
  readonly capabilities: AdapterCapabilities = {
    resume: true,
    steer: 'turn',
    peerMesh: false,
    quota: false,
    stream: true,
  };

  private readonly exec: ExecFn;
  private readonly lineStream: LineStreamFn;
  private readonly binary: string;
  private readonly defaultAccount?: Account;
  private readonly env: Record<string, string | undefined>;
  private readonly trust: boolean;
  private readonly modelsOption?: ModelInfo[];
  private readonly authTimeoutMs: number;
  private readonly modelsTimeoutMs: number;
  private readonly modelsCacheMs: number;

  /** Memoized live model catalog; resolved once per instance and shared by design (see M24). */
  private modelsCache?: ModelInfo[];
  /** Curated fallback cached after a FAILED probe, valid until {@link fallbackCacheUntil} (A3). */
  private fallbackCache?: ModelInfo[];
  /** Epoch-ms after which a failed-probe fallback expires and a re-probe is allowed (A3). */
  private fallbackCacheUntil = 0;

  constructor(opts: CursorAdapterOptions = {}) {
    this.exec = opts.exec ?? nodeExec;
    this.lineStream = opts.lineStream ?? nodeLineStream;
    this.binary = opts.binary ?? 'cursor-agent';
    this.defaultAccount = opts.defaultAccount;
    this.env = opts.env ?? process.env;
    this.trust = opts.trust ?? true;
    this.modelsOption = opts.models;
    this.authTimeoutMs = opts.authTimeoutMs ?? 20_000;
    this.modelsTimeoutMs = opts.modelsTimeoutMs ?? 20_000;
    this.modelsCacheMs = opts.modelsCacheMs ?? 60_000;
  }

  /* ----------------------------------------------------------------------- *
   * Introspection
   * ----------------------------------------------------------------------- */

  /**
   * Login state via `cursor-agent status`, never exposing a token. Exit 0 with
   * `Logged in as <id>` → logged in with `<id>` as detail; exit 0 but unparseable
   * → logged in with no detail; a non-zero exit, ENOENT, or timeout → logged out.
   * `~/.cursor/cli-config.json` holds no auth state (ground truth G), so this MUST
   * shell out. Never throws.
   */
  async authStatus(_account?: Account): Promise<AuthStatus> {
    let res;
    try {
      res = await this.exec({
        cmd: this.binary,
        args: ['status'],
        env: { ...this.env },
        timeoutMs: this.authTimeoutMs,
      });
    } catch {
      return { loggedIn: false };
    }
    if (res.timedOut || (res.exitCode ?? 0) !== 0) {
      return { loggedIn: false };
    }
    const combined = `${res.stdout}\n${res.stderr}`;
    const identifier = /logged in as\s+(\S+)/i.exec(combined)?.[1];
    if (identifier) {
      return { loggedIn: true, mode: 'cursor', detail: identifier };
    }
    return { loggedIn: true, mode: 'cursor' };
  }

  /**
   * The models selectable under the current login, read LIVE from `cursor-agent
   * models` and MEMOIZED on the instance so repeated `Fleet.route()` calls do not
   * re-spawn. The `models` constructor option short-circuits the subprocess
   * entirely. On ANY failure (spawn error, timeout, empty/garbage output) this
   * falls back to a small curated static list so the method NEVER throws and
   * routing still works offline. A fresh array each call — callers cannot mutate
   * the memo.
   */
  async availableModels(_account?: Account): Promise<ModelInfo[]> {
    if (this.modelsOption) {
      return this.modelsOption.map(cloneModel);
    }
    if (this.modelsCache) {
      return this.modelsCache.map(cloneModel);
    }
    // A failed probe's curated fallback is cached for modelsCacheMs so a transient
    // failure recovers later but cannot spawn a subprocess on every routing decision (A3).
    if (this.fallbackCache && Date.now() < this.fallbackCacheUntil) {
      return this.fallbackCache.map(cloneModel);
    }
    const resolved = await this.probeModels();
    if (resolved) {
      this.modelsCache = resolved;
      return resolved.map(cloneModel);
    }
    // Probe failed — cache the curated fallback for modelsCacheMs. The fallback is a
    // TINY list, so it deliberately does NOT feed the unknown-model note (see resolvedCatalog).
    const fallback = curatedModels();
    this.fallbackCache = fallback;
    this.fallbackCacheUntil = Date.now() + this.modelsCacheMs;
    return fallback.map(cloneModel);
  }

  /** Run `cursor-agent models` and parse it; undefined on any failure or empty parse. */
  private async probeModels(): Promise<ModelInfo[] | undefined> {
    try {
      const res = await this.exec({
        cmd: this.binary,
        args: ['models'],
        env: { ...this.env },
        timeoutMs: this.modelsTimeoutMs,
      });
      if (res.timedOut || (res.exitCode ?? 0) !== 0) return undefined;
      const parsed = parseModelsOutput(res.stdout);
      return parsed.length > 0 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Cursor exposes no verified usage endpoint, so quota is unconditionally `null`
   * (and `capabilities.quota` is false). Fabricating `{allowed:true, windows:[]}`
   * would tell the router an exhausted account has full headroom; null is the
   * honest "headroom unknown" signal. Never throws.
   */
  async quota(_account?: Account): Promise<QuotaSnapshot | null> {
    return null;
  }

  /* ----------------------------------------------------------------------- *
   * Worker lifecycle
   * ----------------------------------------------------------------------- */

  /**
   * Start a headless run. Argv order: `-p` → `--output-format json` → `--trust`
   * (when trust resolves true) → `--model` → `--sandbox` → `extra.args` → `--` →
   * prompt. The `--` fence is mandatory (ground truth A) and the prompt is ALWAYS
   * the final argv element. A blank prompt throws before spawning; a timeout
   * resolves an `incomplete` result (never throws); a trust refusal or a non-zero
   * exit with no parseable payload throws AdapterExecError.
   */
  async run(task: RunTask): Promise<RunResult> {
    if (!isNonEmpty(task.prompt)) {
      throw new AgentMeshError('cursor run requires a non-empty prompt', VENDOR);
    }
    // U2: a provided-but-blank model is ABSENT (no flag, no note); a real value is trimmed and verbatim.
    const model = task.model?.trim() || undefined;
    const { args: extras, dropped } = extraArgs(task.extra);
    const notes = this.collectNotes({
      allowedTools: task.allowedTools,
      account: task.account,
      model,
      permissionMode: task.permissionMode,
      droppedArgs: dropped,
    });
    const args = ['-p', '--output-format', 'json'];
    if (this.trust) args.push('--trust');
    if (model) args.push('--model', model);
    if (isNonEmpty(task.permissionMode)) args.push('--sandbox', task.permissionMode);
    args.push(...extras);
    args.push('--', task.prompt); // prompt is ALWAYS the final argv element

    return this.execAndMap(args, {
      cwd: task.cwd,
      timeoutMs: task.timeoutMs,
      modelOverride: model,
      notes,
    });
  }

  /**
   * Continue an existing conversation. Argv: `-p` → `--output-format json` →
   * `--trust` (when true) → `--resume <id>` → `--model` (from opts) → `extra.args`
   * → `--` → message. A blank id or message throws before spawning; a flag-shaped
   * id (leading `-`) throws before spawning, so a corrupted id can never be parsed
   * as a CLI flag and redirect the run. Same result/timeout/failure semantics as run().
   */
  async resume(conversationId: string, message: string, opts?: ResumeOptions): Promise<RunResult> {
    // U1: trim FIRST, then validate the trimmed value; the CLI only ever sees the trimmed id.
    const id = conversationId.trim();
    if (id === '') {
      throw new AgentMeshError('cursor resume requires a non-empty conversationId', VENDOR);
    }
    if (id.startsWith('-')) {
      throw new AgentMeshError(
        'cursor resume conversationId must not start with "-" (would parse as a CLI flag)',
        VENDOR,
      );
    }
    if (!isNonEmpty(message)) {
      throw new AgentMeshError('cursor resume requires a non-empty message', VENDOR);
    }
    // U2: a provided-but-blank model is ABSENT (no flag, no note); a real value is trimmed and verbatim.
    const model = opts?.model?.trim() || undefined;
    const { args: extras, dropped } = extraArgs(opts?.extra);
    const notes = this.collectNotes({
      account: opts?.account,
      model,
      droppedArgs: dropped,
    });
    const args = ['-p', '--output-format', 'json'];
    if (this.trust) args.push('--trust');
    args.push('--resume', id);
    if (model) args.push('--model', model);
    args.push(...extras);
    args.push('--', message); // message is ALWAYS the final argv element

    // U6: ResumeOptions has no cwd field and core is frozen; honour opts.extra.cwd so a resume
    // binds to the conversation's directory, not the process's. Non-string → inherit as today.
    const cwd = typeof opts?.extra?.cwd === 'string' ? opts.extra.cwd : undefined;

    return this.execAndMap(args, {
      cwd,
      timeoutMs: opts?.timeoutMs,
      modelOverride: model,
      fallbackId: id,
      notes,
    });
  }

  /**
   * Incremental events over `-p --output-format stream-json --stream-partial-output`.
   * The prompt is validated EAGERLY at call time (a plain method that throws, then
   * returns the generator), so a blank prompt throws before spawn.
   *
   * Event mapping mirrors the run() semantics:
   * - `system`/`init` records the session id and emits nothing; `user` and
   *   `thinking` events emit nothing (RunEvent has no thinking channel — see README);
   * - `assistant` text blocks become `text` events, EXCEPT the final full-answer
   *   repeat, suppressed by the vendor's OWN discriminator ONLY: it is the one
   *   assistant event with no `timestamp_ms` (ground truth E: the deltas "RAW","-C"
   *   must not concatenate with a trailing full "RAW-C" into "RAW-CRAW-C"). A
   *   text-equality guard is deliberately NOT used — it would swallow a legitimate
   *   repeated delta such as "abc"+"abc" → "abcabc" (A1);
   * - `result` emits a `usage` event (when usage mapped) then a `done` event.
   *
   * Failure fidelity: a TIMEOUT emits a `done`/`incomplete` with the accumulated
   * partials (never an error); a non-zero exit with no result emits an `error`
   * with the exit code and stderr tail; a trust refusal emits an `error` carrying
   * the same remediation as the run() path.
   */
  stream(task: RunTask): AsyncGenerator<RunEvent> {
    if (!isNonEmpty(task.prompt)) {
      throw new AgentMeshError('cursor run requires a non-empty prompt', VENDOR);
    }
    return this.streamEvents(task);
  }

  private async *streamEvents(task: RunTask): AsyncGenerator<RunEvent> {
    // U2: a provided-but-blank model is ABSENT; a real value is trimmed and verbatim.
    const model = task.model?.trim() || undefined;
    const { args: extras, dropped } = extraArgs(task.extra);
    // A5/U7: the stream's done result must carry EVERY note run() would attach.
    const notes = this.collectNotes({
      allowedTools: task.allowedTools,
      account: task.account,
      model,
      permissionMode: task.permissionMode,
      droppedArgs: dropped,
    });

    const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output'];
    if (this.trust) args.push('--trust');
    if (model) args.push('--model', model);
    if (isNonEmpty(task.permissionMode)) args.push('--sandbox', task.permissionMode);
    args.push(...extras);
    args.push('--', task.prompt);

    let sessionId = '';
    let textSoFar = '';
    let emittedDone = false;
    let endMeta: StreamEndMeta | undefined;
    // A4: the trust refusal is printed on STDOUT, so scan a bounded head of the stream's
    // own output (plus the stderr tail) — not the stderr tail alone — to detect it.
    let outputHead = '';
    try {
      for await (const line of this.lineStream(
        {
          cmd: this.binary,
          args,
          cwd: task.cwd,
          env: { ...this.env },
          timeoutMs: task.timeoutMs,
        },
        (meta) => {
          endMeta = meta;
        },
      )) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (outputHead.length < TRUST_SCAN_CAP) {
          outputHead = (outputHead + trimmed + '\n').slice(0, TRUST_SCAN_CAP);
        }
        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue; // non-JSON line — skip
        }
        if (!isRecord(event)) continue;

        const sid = str(event, 'session_id');
        if (sid) sessionId = sid;

        const type = event.type;
        if (type === 'system' || type === 'user' || type === 'thinking') {
          continue; // session id already captured; these carry no emittable content
        }

        if (type === 'assistant') {
          // A1: suppress ONLY on the vendor's own discriminator — the final full-answer repeat
          // is the one assistant event that carries no timestamp_ms. Any timestamped assistant
          // event is a legitimate delta, even if its text equals what came before (e.g. "abc"
          // + "abc" → "abcabc"); a text-equality guard here would swallow that second delta.
          if (typeof event.timestamp_ms !== 'number') continue;
          const messageObj = isRecord(event.message) ? event.message : undefined;
          const content = messageObj?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (!isRecord(block)) continue;
              if (block.type === 'text' && typeof block.text === 'string') {
                textSoFar += block.text;
                yield { type: 'text', text: block.text };
              }
            }
          }
          continue;
        }

        if (type === 'result') {
          const mapped = mapResultPayload(event);
          if (mapped.usage) yield { type: 'usage', usage: mapped.usage };
          emittedDone = true;
          yield { type: 'done', result: this.streamDone(mapped, sessionId, model, notes) };
          continue;
        }
      }
    } catch (e) {
      yield { type: 'error', message: errorMessage(e) };
      return;
    }

    if (emittedDone) return;

    // Stream ended with no `result` event — mirror run()'s degraded outcomes.
    if (endMeta?.timedOut) {
      const done: RunResult = {
        vendor: VENDOR,
        conversationId: sessionId,
        text: textSoFar,
        status: 'incomplete',
      };
      if (model) done.model = model;
      const note = joinNotes([...notes, `timed out after ${task.timeoutMs}ms`]);
      if (note) done.note = note;
      yield { type: 'done', result: done };
      return;
    }

    const code = endMeta?.exitCode ?? null;
    const tail = endMeta?.stderrTail ?? '';
    // A4: the refusal banner is on stdout — detect it over the stream's own output AND the
    // stderr tail, so an untrusted-directory stream yields the same remediation run() gives.
    const combined = `${outputHead}\n${tail}`;
    if (isTrustRefusal(code, combined)) {
      const codePart = code !== null ? ` (exit ${code})` : '';
      yield { type: 'error', message: `${trustMessage(task.cwd)}${codePart}` };
      return;
    }
    const codePart = code !== null ? ` (exit ${code})` : '';
    const tailPart = tail.trim() ? `: ${tail.trim()}` : '';
    yield {
      type: 'error',
      message: `cursor-agent stream ended without a result event${codePart}${tailPart}`,
    };
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

  /**
   * The config dir this call resolves to, or undefined for a fully ambient login.
   * A passed `account` is AUTHORITATIVE: an account with no `configDir` means
   * AMBIENT and does NOT fall back to `defaultAccount`; only `account === undefined`
   * falls back. cursor-agent has no documented config-dir env var, so a resolved
   * dir only drives the "ignored" note — it never changes the child env.
   */
  private resolveConfigDir(account?: Account | null): string | undefined {
    // U4: a null or otherwise non-object account is ABSENT — fall back to defaultAccount,
    // never a raw TypeError. A real account object is authoritative: a missing/blank
    // configDir means AMBIENT and does NOT inherit defaultAccount.configDir.
    if (isRecord(account)) {
      return typeof account.configDir === 'string' ? account.configDir : undefined;
    }
    return this.defaultAccount?.configDir;
  }

  /**
   * The model catalog IFF it is already available WITHOUT spawning (A2): the `models`
   * constructor option or a previously memoized SUCCESSFUL read. Deliberately excludes
   * the failed-probe fallback (a tiny curated list that would wrongly mark most models
   * off-catalog). Returns undefined when no catalog is resolved, so the unknown-model
   * note is simply skipped rather than blocking a run on an out-of-band subprocess.
   */
  private resolvedCatalog(): ModelInfo[] | undefined {
    return this.modelsOption ?? this.modelsCache;
  }

  /**
   * Pre-spawn notes shared by run/resume/stream (U7 stable order): `allowedTools` has no
   * cursor-agent equivalent; `account.configDir` is unsupported; a non-empty `model` outside
   * an ALREADY-RESOLVED catalog runs anyway with a note (never spawns — A2); a non-empty
   * `permissionMode` outside cursor's `--sandbox` vocabulary is passed through anyway with a
   * note (the vendor stays the authority — U9); and dropped non-string `extra.args` entries
   * are reported (U5). Pure and synchronous — never blocks a run.
   */
  private collectNotes(opts: {
    allowedTools?: string[];
    account?: Account | null;
    model?: string;
    permissionMode?: string;
    droppedArgs: number;
  }): string[] {
    const notes: string[] = [];
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      notes.push('allowedTools not supported by cursor-agent; ignored');
    }
    if (this.resolveConfigDir(opts.account)) {
      notes.push('account.configDir is not supported by cursor-agent; ignored');
    }
    if (opts.model) {
      const catalog = this.resolvedCatalog();
      // Best-effort: only when a catalog is already known. Parameterized forms
      // (e.g. 'claude-opus-4-8[context=1m]') never match an id — noted, never blocked.
      if (catalog && !catalog.some((m) => m.id === opts.model)) {
        notes.push(`model ${opts.model} not in known catalog`);
      }
    }
    // U9: `--sandbox` is declared with .choices(["enabled","disabled"]); any other value —
    // including the sibling adapters' modes (Codex's 'workspace-write', Claude's 'acceptEdits')
    // — makes cursor-agent exit 1. A whitespace-only value is ABSENT (matches the model rule and
    // the isNonEmpty guard on the argv). We do NOT remap onto --force/--yolo (a silent privilege
    // escalation this adapter forbids): the value is passed through to --sandbox verbatim, exactly
    // as today, and only the CALLER is told. Built here — beside the other pre-spawn notes — so it
    // is produced even when the run subsequently fails on that same value.
    if (opts.permissionMode) {
      const mode = opts.permissionMode.trim();
      if (mode !== '' && mode !== 'enabled' && mode !== 'disabled') {
        notes.push(
          `permissionMode '${mode}' is not a cursor sandbox mode ` +
            `(expected 'enabled' or 'disabled'); passed through`,
        );
      }
    }
    if (opts.droppedArgs > 0) {
      const noun = opts.droppedArgs === 1 ? 'entry' : 'entries';
      notes.push(`extra.args contained ${opts.droppedArgs} non-string ${noun}; dropped`);
    }
    return notes;
  }

  /** Assemble the stream's terminal `done` RunResult from a mapped result event. */
  private streamDone(
    mapped: MappedResult,
    sessionId: string,
    model: string | undefined,
    notes: string[],
  ): RunResult {
    const result: RunResult = {
      vendor: VENDOR,
      conversationId: mapped.conversationId || sessionId,
      text: mapped.text,
      status: mapped.status,
    };
    // Never promote the stream's system/init model (a DISPLAY NAME) into model.
    if (isNonEmpty(model)) result.model = model;
    if (mapped.usage) result.usage = mapped.usage;
    const note = joinNotes(notes);
    if (note) result.note = note;
    result.raw = mapped.raw;
    return result;
  }

  /** Spawn the CLI with the built argv, then map stdout/exit into a RunResult. */
  private async execAndMap(args: string[], ctx: MapContext): Promise<RunResult> {
    let res;
    try {
      res = await this.exec({
        cmd: this.binary,
        args,
        cwd: ctx.cwd,
        // cursor-agent has no config-dir env var; the child env is just the base seam.
        env: { ...this.env },
        timeoutMs: ctx.timeoutMs,
      });
    } catch (err) {
      throw new AdapterExecError(`cursor-agent failed to start: ${errorMessage(err)}`, VENDOR, {
        stderr: truncate(errorMessage(err), STDERR_CAP),
      });
    }

    const notes = [...ctx.notes];
    const parsed = parseCursorJson(res.stdout);

    const assemble = (fields: {
      conversationId: string;
      text: string;
      status: RunStatus;
      usage?: MappedResult['usage'];
      raw?: Record<string, unknown>;
    }): RunResult => {
      const conversationId = ctx.fallbackId
        ? fields.conversationId || ctx.fallbackId
        : fields.conversationId;
      const result: RunResult = {
        vendor: VENDOR,
        conversationId,
        text: fields.text,
        status: fields.status,
      };
      if (isNonEmpty(ctx.modelOverride)) result.model = ctx.modelOverride;
      if (fields.usage) result.usage = fields.usage;
      const note = joinNotes(notes);
      if (note) result.note = note;
      if (fields.raw !== undefined) result.raw = fields.raw;
      return result;
    };

    // Precedence: timeout → trust refusal → parsed payload → non-zero exit → incomplete.
    if (res.timedOut) {
      notes.push(`timed out after ${ctx.timeoutMs}ms`);
      if (parsed) {
        const m = mapResultPayload(parsed);
        return assemble({
          conversationId: m.conversationId,
          text: m.text,
          status: 'incomplete',
          usage: m.usage,
          raw: m.raw,
        });
      }
      return assemble({ conversationId: '', text: '', status: 'incomplete' });
    }

    const combined = `${res.stdout}\n${res.stderr}`;
    if (isTrustRefusal(res.exitCode, combined)) {
      throw new AdapterExecError(trustMessage(ctx.cwd), VENDOR, {
        ...(typeof res.exitCode === 'number' ? { exitCode: res.exitCode } : {}),
        stderr: truncate(res.stderr, STDERR_CAP),
      });
    }

    if (parsed) {
      const m = mapResultPayload(parsed);
      return assemble(m);
    }

    if ((res.exitCode ?? 0) !== 0) {
      throw new AdapterExecError(`cursor-agent exited with code ${res.exitCode}`, VENDOR, {
        ...(typeof res.exitCode === 'number' ? { exitCode: res.exitCode } : {}),
        stderr: truncate(res.stderr, STDERR_CAP),
      });
    }

    // Zero exit, nothing parsed.
    return assemble({ conversationId: '', text: '', status: 'incomplete' });
  }
}

export interface CreateChatOptions {
  /** Process-exec seam. Default: {@link nodeExec}. */
  exec?: ExecFn;
  /** The cursor-agent executable path or command name. Default: `'cursor-agent'`. */
  binary?: string;
  /** Wall-clock cap in ms. */
  timeoutMs?: number;
}

/**
 * Pre-allocate a conversation id by running `cursor-agent create-chat`, which
 * prints a bare UUID on stdout (ground truth C). Returns the trimmed id, or
 * `null` on any failure (timeout, non-zero exit, empty output, spawn error).
 * Never throws — a null result simply means "mint the id on the first run instead".
 */
export async function createChat(opts: CreateChatOptions = {}): Promise<string | null> {
  const exec = opts.exec ?? nodeExec;
  const binary = opts.binary ?? 'cursor-agent';
  try {
    const res = await exec({ cmd: binary, args: ['create-chat'], timeoutMs: opts.timeoutMs });
    if (res.timedOut || (res.exitCode ?? 0) !== 0) return null;
    const id = res.stdout.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
