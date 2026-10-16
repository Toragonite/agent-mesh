/**
 * GeminiAdapter — drives Google Antigravity's official `agy` CLI headlessly behind
 * the frozen agent-mesh {@link Adapter} contract.
 *
 * Surface: one-shot `run()` (`agy --output-format json -p`), `resume()` by
 * conversation id (`agy --conversation <id> ...`), incremental `stream()`
 * (`--output-format stream-json`), plus introspection. Auth and the live model
 * list both go through the one probe Antigravity exposes — `agy models` — because
 * there is no readable local auth file and no status/login subcommand. Usage comes
 * from agy itself: `agy -p /usage --output-format json` (see quota.ts).
 *
 * Since 0.1.3 `run()` and `stream()` also drive the turn lane: `resumeId` →
 * `--conversation <id>` (agy SILENTLY starts a new conversation for an id it does not
 * know — the `session` event of a resumed `stream()` is how a caller notices), and
 * `elevated` → `--dangerously-skip-permissions`, the only flag under which agy print mode
 * calls MCP tools at all (the caller writes `<cwd>/.agents/mcp_config.json`).
 *
 * Every side-effecting seam (process exec, line streaming, env, file reads) is injectable
 * through the constructor with a real default, so the whole adapter is testable
 * with no real CLI, no network, and no real home directory. No token or secret
 * value ever appears in a result, note, detail, error, or raw payload — there are
 * no tokens on this path, but the rule holds regardless.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  AdapterExecError,
  AgentMeshError,
  type Account,
  type Adapter,
  type AdapterCapabilities,
  type AuthStatus,
  type McpAttachment,
  type ModelInfo,
  type QuotaSnapshot,
  type ResumeOptions,
  type RunEvent,
  type RunOptions,
  type RunResult,
  type RunTask,
  type Vendor,
} from '@toragonite/agent-mesh';
import {
  execOverLineStream,
  nodeExec,
  nodeLineStream,
  type ExecFn,
  type ExecRequest,
  type ExecResult,
  type LineStreamFn,
  type StreamEndMeta,
} from './exec.js';
import { isRecord, mapPayload, pickLastJsonObject, type MappedPayload } from './parse.js';
import { isKnownModel, parseModelsOutput, staticModels } from './models.js';
import { DEFAULT_QUOTA_CACHE_MS, DEFAULT_QUOTA_TIMEOUT_MS, readAgyUsage } from './quota.js';

const VENDOR: Vendor = 'gemini';

/** Max stderr bytes attached to an AdapterExecError, so a failure is diagnosable without a flood. */
const STDERR_CAP = 4_096;

/** The largest delay a Node timer honours; a longer one fires after 1 ms instead. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * How long a quota() caller waits past `quotaTimeoutMs` for the seam to settle before it
 * resolves `null` anyway: nodeExec needs up to its 5 s SIGTERM→SIGKILL grace, and a host
 * seam that ignores `timeoutMs` must not hang every later quota() behind the single flight.
 */
const QUOTA_SETTLE_GRACE_MS = 10_000;

/** The pre-spawn notes with fixed text. */
const ALLOWED_TOOLS_NOTE = 'allowedTools not supported by agy; ignored';
/**
 * The agy 1.3.5 binary contains no `AGY_HOME` string: the variable is set (so a later
 * agy that reads it gets it) but nothing reads it today, so every account runs on —
 * and quota() reports the usage of — agy's default login, whose keychain item is fixed.
 */
const AGY_HOME_NOTE =
  'account.configDir is passed as AGY_HOME, which agy 1.3.5 does not read; Antigravity account isolation is not provided: every account uses the default agy login';
/** The note for an explicit account whose config dir `options.env` displaces. */
const ENV_ACCOUNT_NOTE = 'account.configDir not applied: options.env is the complete child environment';
/** agy 1.3.6 print mode calls MCP tools only under --dangerously-skip-permissions. */
const MCP_NEEDS_ELEVATED_NOTE =
  'mcp: agy print mode calls MCP tools only with elevated (--dangerously-skip-permissions); without it the tools are not called';

/** `McpAttachment.name`: a lowercase identifier. */
const MCP_NAME = /^[a-z][a-z0-9_]{0,31}$/;
/** C0 control characters and DEL — never part of a path or a value handed to the CLI. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** The largest `appendSystemPromptFile` whose content is prefixed to a prompt. */
const APPEND_PROMPT_MAX_BYTES = 256 * 1024;

export interface GeminiAdapterOptions {
  /** Run-to-completion process seam. Default: {@link nodeExec}. */
  exec?: ExecFn;
  /** Streaming process seam for `stream()`. Default: {@link nodeLineStream}. */
  lineStream?: LineStreamFn;
  /** The `agy` executable path or command name. Default: `'agy'`. */
  binary?: string;
  /**
   * Account used when a call passes none. Its `configDir` sets `AGY_HOME` — which agy
   * 1.3.5 does not read, so it does not select a different login (see `AGY_HOME_NOTE`).
   */
  defaultAccount?: Account;
  /**
   * Environment seam — the base of every child env and every env read. Default:
   * {@link process.env}. Injecting it keeps introspection and execution resolving
   * the same account and lets tests avoid mutating global `process.env`.
   */
  env?: Record<string, string | undefined>;
  /** Wall-clock cap for the `agy models` auth probe. Default: 20000. */
  authTimeoutMs?: number;
  /**
   * Wall-clock cap for one `agy -p /usage` read behind `quota()`, in ms (default 90000).
   * The seam kills the child's whole process group at it and the read resolves `null`.
   * A non-positive or non-finite value means the default — the read is never unbounded.
   */
  quotaTimeoutMs?: number;
  /**
   * How long one read's outcome — the snapshot OR `null` — is reused for the same
   * account, in ms (default 60000; 0 disables the cache). Either way at most one read
   * per account is in flight per adapter instance: a concurrent caller awaits it.
   */
  quotaCacheMs?: number;
  /**
   * Since 0.1.3: reads a text file (the `appendSystemPromptFile` of a task), resolving
   * `null` when it is absent or unreadable. Default: an fs read.
   */
  readTextFile?: (path: string) => Promise<string | null>;
}

/** Default file reader: contents as utf-8, or null on any read failure (e.g. ENOENT). */
async function defaultReadTextFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** A positive finite timeout (capped to what a Node timer honours), else the default. */
function positiveMs(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.min(x, MAX_TIMER_MS) : fallback;
}

/** A caller-owned copy: the cached snapshot's windows can never be mutated through a result. */
function cloneSnapshot(s: QuotaSnapshot | null): QuotaSnapshot | null {
  return s ? { ...s, windows: s.windows.map((w) => ({ ...w })) } : null;
}

/**
 * `pending`, or `null` once `ms` pass first. The timer is armed at once (before the
 * caller awaits anything) and cleared as soon as `pending` settles.
 */
function withDeadline(pending: Promise<QuotaSnapshot | null>, ms: number): Promise<QuotaSnapshot | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([pending, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
 * Verbatim extra CLI args from `extra.args`: keep the strings, count the dropped
 * non-string entries so the caller can surface a note rather than dropping silently.
 */
function extraArgs(extra: Record<string, unknown> | undefined): { args: string[]; dropped: number } {
  const raw = extra?.args;
  if (!Array.isArray(raw)) return { args: [], dropped: 0 };
  const args = raw.filter((a): a is string => typeof a === 'string');
  return { args, dropped: raw.length - args.length };
}

function unknownModelNote(model: string): string {
  return `model ${model} not in known catalog`;
}

/** Note surfaced when non-string `extra.args` entries were dropped (singular/plural). */
function droppedArgsNote(n: number): string {
  return `extra.args contained ${n} non-string ${n === 1 ? 'entry' : 'entries'}; dropped`;
}

/** The trimmed, non-empty model, or undefined when the model is absent or blank. */
function resolveModel(model: string | undefined): string | undefined {
  const m = model?.trim();
  return m ? m : undefined;
}

/**
 * Split off exactly ONE trailing newline (`\r\n` or `\n`) as `[body, trailing]`.
 * Interior newlines are untouched; used to hold a delta's trailing newline back so
 * concatenated stream deltas equal the newline-normalized final text.
 */
function splitTrailingNewline(s: string): [string, string] {
  if (s.endsWith('\r\n')) return [s.slice(0, -2), '\r\n'];
  if (s.endsWith('\n')) return [s.slice(0, -1), '\n'];
  return [s, ''];
}

/* ------------------------------------------------------------------------- *
 * The turn-lane fields of a task (0.1.3) — validated BEFORE anything spawns.
 * ------------------------------------------------------------------------- */

/** The validated turn-lane plan of one run()/stream() call. */
interface TurnPlan {
  /** Continue this conversation (`--conversation <id>`). */
  resumeId?: string;
  mcp?: McpAttachment;
  appendSystemPromptFile?: string;
  /** Pass `--dangerously-skip-permissions`. */
  elevated: boolean;
  /** Notes for the fields this adapter ignores, in their stable order. */
  notes: string[];
}

/** A conversation id field: trimmed; blank or `-`-leading throws. `undefined` stays absent. */
function conversationIdField(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (id === '') {
    throw new AgentMeshError(`agy ${field} must be a non-empty conversation id`, VENDOR);
  }
  if (id.startsWith('-')) {
    throw new AgentMeshError(`agy ${field} must not start with "-" (would parse as a CLI flag)`, VENDOR);
  }
  return id;
}

/** An absolute-path field (no control characters). `undefined` stays absent; anything else throws. */
function absolutePathField(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !path.isAbsolute(raw) || CONTROL_CHARS.test(raw)) {
    throw new AgentMeshError(`agy ${field} must be an absolute path`, VENDOR);
  }
  return raw;
}

/** Validate an {@link McpAttachment}: every field is checked by value; a bad one throws. */
function mcpField(raw: unknown): McpAttachment {
  if (!isRecord(raw)) {
    throw new AgentMeshError('agy mcp must be an object { name, command, args, configFile }', VENDOR);
  }
  const { name, command, args } = raw;
  if (typeof name !== 'string' || !MCP_NAME.test(name)) {
    throw new AgentMeshError('agy mcp.name must match /^[a-z][a-z0-9_]{0,31}$/', VENDOR);
  }
  if (typeof command !== 'string' || command.trim() === '' || CONTROL_CHARS.test(command)) {
    throw new AgentMeshError('agy mcp.command must be a non-empty string without control characters', VENDOR);
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string' && !CONTROL_CHARS.test(a))) {
    throw new AgentMeshError('agy mcp.args must be an array of strings without control characters', VENDOR);
  }
  const configFile = absolutePathField(raw.configFile, 'mcp.configFile');
  if (configFile === undefined) {
    throw new AgentMeshError('agy mcp.configFile must be an absolute path', VENDOR);
  }
  const projectConfigFile = absolutePathField(raw.projectConfigFile, 'mcp.projectConfigFile');
  return {
    name,
    command,
    args: args.map((a) => String(a)),
    configFile,
    ...(projectConfigFile !== undefined ? { projectConfigFile } : {}),
  };
}

/** A tool-name list field: must be an array when present; returns whether it names any tool. */
function namesAnyTool(raw: unknown, field: string): boolean {
  if (raw === undefined) return false;
  if (!Array.isArray(raw)) {
    throw new AgentMeshError(`agy ${field} must be an array of tool names`, VENDOR);
  }
  return raw.some((t) => typeof t === 'string' && t.trim() !== '');
}

/**
 * Validate the turn-lane fields of `task` (synchronously — so `stream()` throws at call time).
 * Throws AgentMeshError for: a blank or flag-shaped `resumeId`; `resumeId` together with
 * `sessionId`; a relative `appendSystemPromptFile`; an invalid `mcp`; a non-array `disallowedTools`.
 */
function planTurn(task: RunTask): TurnPlan {
  const notes: string[] = [];
  const resumeId = conversationIdField(task.resumeId, 'resumeId');
  if (task.sessionId !== undefined) {
    if (resumeId !== undefined) {
      throw new AgentMeshError(
        'agy sessionId and resumeId are mutually exclusive: sessionId starts a conversation, resumeId continues one',
        VENDOR,
      );
    }
    notes.push('sessionId not supported by agy (the id comes from the init event); ignored');
  }
  const appendSystemPromptFile = absolutePathField(task.appendSystemPromptFile, 'appendSystemPromptFile');
  const mcp = task.mcp === undefined ? undefined : mcpField(task.mcp);
  const elevated = task.elevated === true;
  if (mcp !== undefined && !elevated) {
    notes.push(MCP_NEEDS_ELEVATED_NOTE);
  }
  if (namesAnyTool(task.disallowedTools, 'disallowedTools')) {
    notes.push('disallowedTools not supported by agy; ignored');
  }
  if (isNonEmpty(task.settingSources)) {
    notes.push('settingSources not supported by agy; ignored');
  }
  if (mcp?.projectConfigFile !== undefined) {
    notes.push('mcp.projectConfigFile is not supported by agy; ignored');
  }
  return {
    ...(resumeId !== undefined ? { resumeId } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
    ...(appendSystemPromptFile !== undefined ? { appendSystemPromptFile } : {}),
    elevated,
    notes,
  };
}

/** Everything execAndMap needs from a run()/resume() call, contract-neutral. */
interface ExecContext {
  account?: Account;
  cwd?: string;
  timeoutMs?: number;
  /** Model override from the request (task.model / opts.model); the payload carries none. */
  modelOverride?: string;
  /** Notes accumulated before spawn (allowedTools ignored, unknown model). */
  notes: string[];
  /**
   * resume() and a resumed run() ONLY: the trimmed conversation id the caller passed, used as
   * a fallback when the payload echoes no non-empty id. A fresh run() leaves this unset so a
   * genuinely empty id stays empty and the error path never fabricates one.
   */
  fallbackConversationId?: string;
}

export class GeminiAdapter implements Adapter {
  readonly vendor: Vendor = VENDOR;
  readonly capabilities: AdapterCapabilities = {
    resume: true,
    steer: 'turn',
    peerMesh: false,
    quota: true,
    stream: true,
  };

  private readonly exec: ExecFn;
  private readonly lineStream: LineStreamFn;
  private readonly binary: string;
  private readonly defaultAccount?: Account;
  private readonly env: Record<string, string | undefined>;
  private readonly authTimeoutMs: number;
  private readonly quotaTimeoutMs: number;
  private readonly quotaCacheMs: number;
  private readonly readTextFile: (path: string) => Promise<string | null>;

  /** Per account key (see {@link quotaKey}): the last read's outcome and when it arrived. */
  private readonly quotaCache = new Map<string, { at: number; value: QuotaSnapshot | null }>();
  /**
   * Per account key: the read in flight. It is removed only when the read itself settles
   * — not when a caller's deadline gives up on it — so a second agy is never started for
   * an account while the first is still running.
   */
  private readonly quotaInFlight = new Map<string, Promise<QuotaSnapshot | null>>();

  constructor(opts: GeminiAdapterOptions = {}) {
    this.exec = opts.exec ?? nodeExec;
    this.lineStream = opts.lineStream ?? nodeLineStream;
    this.binary = opts.binary ?? 'agy';
    this.defaultAccount = opts.defaultAccount;
    this.env = opts.env ?? process.env;
    this.authTimeoutMs = opts.authTimeoutMs ?? 20_000;
    this.quotaTimeoutMs = positiveMs(opts.quotaTimeoutMs, DEFAULT_QUOTA_TIMEOUT_MS);
    const cacheMs = opts.quotaCacheMs;
    this.quotaCacheMs =
      typeof cacheMs === 'number' && !Number.isNaN(cacheMs) && cacheMs >= 0 ? cacheMs : DEFAULT_QUOTA_CACHE_MS;
    this.readTextFile = opts.readTextFile ?? defaultReadTextFile;
  }

  /* ----------------------------------------------------------------------- *
   * Introspection
   * ----------------------------------------------------------------------- */

  /**
   * Login state via the only probe Antigravity exposes — `agy models`. Exit 0 with
   * at least one parseable `id\tlabel` line reads as logged in under Google auth;
   * anything else (non-zero exit, ENOENT, timeout, unparseable) reads as logged out.
   * Never throws. There is no `detail` — the CLI exposes no account identifier.
   *
   * This costs a network round-trip and is deliberately NOT on the routing path.
   */
  async authStatus(account?: Account): Promise<AuthStatus> {
    const env = this.childEnv(account).env;
    let res;
    try {
      res = await this.exec({ cmd: this.binary, args: ['models'], env, timeoutMs: this.authTimeoutMs });
    } catch {
      return { loggedIn: false };
    }
    if (res.timedOut || (res.exitCode ?? 0) !== 0) return { loggedIn: false };
    return parseModelsOutput(res.stdout).length > 0
      ? { loggedIn: true, mode: 'google' }
      : { loggedIn: false };
  }

  /**
   * The FAST, static catalog — a fresh array each call so callers cannot mutate the
   * shared list. Spawns NOTHING: `Fleet.route()` calls this on the routing hot path.
   * The authoritative-but-slow counterpart is the exported {@link fetchLiveModels}.
   */
  async availableModels(_account?: Account): Promise<ModelInfo[]> {
    return staticModels();
  }

  /**
   * The account's usage, as agy reports it itself: `agy -p /usage --output-format
   * json`, which agy (≥ 1.1.11) answers in print mode without an agent turn and
   * without spending quota. One window per enabled bucket (`gemini-weekly`,
   * `gemini-5h`, `3p-weekly`, `3p-5h` on agy 1.3.5); see quota.ts for the mapping.
   * Any failure resolves `null`, the honest "headroom unknown" signal — never a
   * fabricated `{allowed:true, windows:[]}`. Never throws.
   *
   * The child is started through the `exec` seam (as run() is), with the account's env
   * exactly as run() builds it, stdin on the null device, and a private cwd. Each read
   * boots agy's language server, so per adapter instance and per account there is at
   * most ONE read in flight (a concurrent caller awaits it), and its outcome is reused
   * for `quotaCacheMs`. A caller never waits past `quotaTimeoutMs` plus a settle grace,
   * even through a seam that ignores the timeout.
   *
   * Which login: the account's `configDir` reaches agy as `AGY_HOME`, which agy 1.3.5
   * does not read — so every account reports agy's DEFAULT login's usage.
   */
  async quota(account?: Account): Promise<QuotaSnapshot | null> {
    try {
      const { env } = this.childEnv(account);
      const key = this.quotaKey(env);
      const cached = this.quotaCache.get(key);
      if (cached && Date.now() - cached.at < this.quotaCacheMs) return cloneSnapshot(cached.value);
      let pending = this.quotaInFlight.get(key);
      if (!pending) {
        pending = readAgyUsage({ exec: this.exec, binary: this.binary, env, timeoutMs: this.quotaTimeoutMs })
          .catch(() => null) // readAgyUsage never rejects; belt-and-braces
          .then((value) => {
            if (this.quotaCacheMs > 0) this.quotaCache.set(key, { at: Date.now(), value });
            return value;
          })
          .finally(() => this.quotaInFlight.delete(key));
        this.quotaInFlight.set(key, pending);
      }
      const deadlineMs = Math.min(this.quotaTimeoutMs + QUOTA_SETTLE_GRACE_MS, MAX_TIMER_MS);
      return cloneSnapshot(await withDeadline(pending, deadlineMs));
    } catch {
      return null;
    }
  }

  /* ----------------------------------------------------------------------- *
   * Worker lifecycle
   * ----------------------------------------------------------------------- */

  /**
   * Start a headless run. Argv order is fixed: `--conversation <id>` (with `resumeId`), then
   * `--output-format json`, then optional `--model` / `--mode` / `--dangerously-skip-permissions`
   * (ONLY with `elevated`), then `extra.args` verbatim, then `-p` and the prompt ALWAYS last.
   * There is no `--` fence — the prompt is the VALUE of `-p`, so a flag-shaped prompt
   * round-trips as one argv element (verified live). A blank prompt or an invalid turn-lane
   * field throws before spawn; a timeout resolves `incomplete` (never throws); a spawn failure
   * or a non-zero exit with no parseable payload throws AdapterExecError. `opts.lineStream`
   * (since 0.1.3) is then the only seam the run spawns through, and `opts.env` the child's
   * whole environment.
   */
  async run(task: RunTask, opts?: RunOptions): Promise<RunResult> {
    if (!isNonEmpty(task.prompt)) {
      throw new AgentMeshError('run: prompt must be a non-empty string', VENDOR);
    }
    const plan = planTurn(task);
    const notes: string[] = [];
    if (task.allowedTools && task.allowedTools.length > 0) notes.push(ALLOWED_TOOLS_NOTE);
    const model = resolveModel(task.model);
    if (model && !isKnownModel(model)) notes.push(unknownModelNote(model));
    const extra = extraArgs(task.extra);
    if (extra.dropped > 0) notes.push(droppedArgsNote(extra.dropped));
    notes.push(...plan.notes);
    const prompt = await this.composePrompt(task.prompt, plan.appendSystemPromptFile, notes);

    const args = this.buildRunArgs(task, 'json', model, extra.args, plan, prompt);
    return this.execAndMap(
      args,
      {
        account: task.account,
        cwd: task.cwd,
        timeoutMs: task.timeoutMs,
        modelOverride: model,
        notes,
        ...(plan.resumeId !== undefined ? { fallbackConversationId: plan.resumeId } : {}),
      },
      opts,
    );
  }

  /**
   * Continue an existing conversation. The id is TRIMMED first, then validated: a blank
   * id or message throws before spawn, and a flag-shaped id (leading `-` after trimming)
   * throws so a hostile/corrupted id can never be parsed as a CLI flag. Argv leads with
   * `--conversation <trimmed-id>`, then `--output-format json`, optional `--model`,
   * `extra.args` verbatim, and the message as the final `-p` value. A string `extra.cwd`
   * sets the child's working directory (ResumeOptions has no `cwd` field). Unlike
   * {@link run}, when the vendor echoes an empty `conversation_id` the result falls back
   * to the trimmed id the caller passed, since that conversation is still resumable. Same
   * result/timeout/failure semantics as {@link run} otherwise.
   */
  async resume(conversationId: string, message: string, opts?: ResumeOptions): Promise<RunResult> {
    const id = conversationId.trim();
    if (id === '') {
      throw new AgentMeshError('resume: conversationId must be a non-empty string', VENDOR);
    }
    if (id.startsWith('-')) {
      throw new AgentMeshError(
        `resume: conversationId must not start with '-' (looks like a CLI flag): ${conversationId}`,
        VENDOR,
      );
    }
    if (!isNonEmpty(message)) {
      throw new AgentMeshError('resume: message must be a non-empty string', VENDOR);
    }
    const notes: string[] = [];
    const model = resolveModel(opts?.model);
    if (model && !isKnownModel(model)) notes.push(unknownModelNote(model));
    const extra = extraArgs(opts?.extra);
    if (extra.dropped > 0) notes.push(droppedArgsNote(extra.dropped));

    const args = ['--conversation', id, '--output-format', 'json']; // the TRIMMED id reaches the CLI
    if (model) args.push('--model', model);
    args.push(...extra.args);
    args.push('-p', message); // message is ALWAYS the final argv element

    // ResumeOptions has no cwd field and core is frozen, so honour a string extra.cwd.
    const cwd = typeof opts?.extra?.cwd === 'string' ? opts.extra.cwd : undefined;
    return this.execAndMap(args, {
      account: opts?.account,
      cwd,
      timeoutMs: opts?.timeoutMs,
      modelOverride: model,
      notes,
      fallbackConversationId: id,
    });
  }

  /**
   * Incremental events over `--output-format stream-json`. The prompt and every turn-lane
   * field are validated EAGERLY here (a plain method that throws, then returns the
   * generator), so an invalid task throws at call time — not deferred to the first `next()`.
   *
   * Session (since 0.1.3): agy's first line is `{"event":"init","conversation_id":…}`; its id
   * — the CLI's own report, never `task.resumeId` echoed back — emits a `session` event, and a
   * later different id (a step's, or the terminal payload's) emits another. For an id it does
   * not know, agy prints `warning: conversation "…" not found` and SILENTLY starts a new
   * conversation (measured on agy 1.3.6): the `session` id then differs from `resumeId`.
   *
   * Turn lane (since 0.1.3), argv: `[--conversation <id>] --output-format stream-json
   * [--model <m>] [--mode <mode>] [--dangerously-skip-permissions] [extra.args] -p <prompt>` —
   * `--mode` again on every turn, the prompt directly after `-p`, and
   * `--dangerously-skip-permissions` ONLY with `elevated` (agy print mode calls MCP tools only
   * under it; it also approves every shell command). Measured on agy 1.3.6.
   */
  stream(task: RunTask, opts?: RunOptions): AsyncGenerator<RunEvent> {
    if (!isNonEmpty(task.prompt)) {
      throw new AgentMeshError('run: prompt must be a non-empty string', VENDOR);
    }
    const plan = planTurn(task);
    return this.streamEvents(task, plan, opts);
  }

  /** Antigravity has no interactive take-over in this release. */
  interactiveResume(_conversationId: string, _account?: Account): undefined {
    return undefined;
  }

  /**
   * The generator behind {@link stream}; the task is already validated.
   *
   * `init` records the conversation id. `step_update` emits a `text` event ONLY for a
   * `step_type` of `agent_response` with a non-empty `text_delta` — every other step type
   * (`user_input`, `checkpoint`, ...) is skipped because RunEvent has no semantics for it and
   * per-step usage is partial. A delta's single trailing newline is held back and emitted only
   * when more text follows (and dropped at end of stream), so concatenated `text` events equal
   * the newline-normalized `done.text`. A terminal payload — the `result` event OR a bare
   * object carrying `status`/`response` (the error path / older CLI generations) — emits a
   * `usage` event (when usage mapped) then a `done` event built by the single
   * {@link mapPayload} mapper. Non-JSON lines are skipped. Nothing follows the terminal event:
   * later lines are drained but emit nothing.
   *
   * Failure fidelity mirrors run(): a TIMEOUT with no `result` event emits a `done`
   * with `status:'incomplete'`, the timeout note, the accumulated partial text and any
   * conversation id seen — never an `error` event. A non-zero EXIT with no `result`
   * event emits an `error` whose message carries the exit code and the stderr tail.
   */
  private async *streamEvents(task: RunTask, plan: TurnPlan, opts?: RunOptions): AsyncGenerator<RunEvent> {
    const notes: string[] = [];
    if (task.allowedTools && task.allowedTools.length > 0) notes.push(ALLOWED_TOOLS_NOTE);
    const model = resolveModel(task.model);
    if (model && !isKnownModel(model)) notes.push(unknownModelNote(model));
    const extra = extraArgs(task.extra);
    if (extra.dropped > 0) notes.push(droppedArgsNote(extra.dropped));
    notes.push(...plan.notes);
    let prompt: string;
    try {
      prompt = await this.composePrompt(task.prompt, plan.appendSystemPromptFile, notes);
    } catch (e) {
      yield { type: 'error', message: errorMessage(e) };
      return;
    }

    const args = this.buildRunArgs(task, 'stream-json', model, extra.args, plan, prompt);
    const { env, note: envNote } = this.childEnv(task.account, opts);
    if (envNote) notes.push(envNote);
    // A per-run seam (RunOptions.lineStream) is the ONLY seam this run spawns through.
    const lineStream: LineStreamFn = opts?.lineStream ?? this.lineStream;
    // The id a resumed run falls back to when the CLI reports none (as resume() does).
    const fallbackId = plan.resumeId ?? '';

    let conversationId = '';
    let reportedId = '';
    let textSoFar = '';
    // A held-back trailing newline (see splitTrailingNewline): buffered so it is emitted
    // only when more text follows, and dropped at end of stream — so concatenated deltas
    // equal the newline-normalized done.text.
    let heldNewline = '';
    let emittedDone = false;
    let endMeta: StreamEndMeta | undefined;
    try {
      for await (const line of lineStream(
        { cmd: this.binary, args, cwd: task.cwd, env, timeoutMs: task.timeoutMs },
        (meta) => {
          endMeta = meta;
        },
      )) {
        if (emittedDone) continue; // drain: nothing follows the terminal event
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue; // stray prose / progress line — skip
        }
        if (!isRecord(event)) continue;
        const kind = typeof event.event === 'string' ? event.event : '';

        // The conversation id as agy reports it: init's (any), a step's (until one is known).
        if (kind === 'init') {
          const id = event.conversation_id;
          if (typeof id === 'string' && id.length > 0) conversationId = id;
        } else if (kind === 'step_update' && conversationId.length === 0) {
          const step = isRecord(event.step_update) ? event.step_update : undefined;
          const cid = step?.conversation_id;
          if (typeof cid === 'string' && cid.length > 0) conversationId = cid;
        }
        if (conversationId.length > 0 && conversationId !== reportedId) {
          reportedId = conversationId;
          yield { type: 'session', conversationId };
        }

        if (kind === 'init') {
          continue;
        } else if (kind === 'step_update') {
          const su = isRecord(event.step_update) ? event.step_update : undefined;
          if (!su) continue;
          if (su.step_type === 'agent_response' && typeof su.text_delta === 'string' && su.text_delta.length > 0) {
            // Hold a single trailing newline back; interior newlines are content.
            const [body, trailing] = splitTrailingNewline(heldNewline + su.text_delta);
            heldNewline = trailing;
            if (body.length > 0) {
              textSoFar += body;
              yield { type: 'text', text: body };
            }
          }
        } else {
          // A terminal `result` event, OR a bare payload object (error path / older CLI
          // generations) carrying `status`/`response` — both mapped by the SAME mapper run() uses.
          const payload =
            kind === 'result'
              ? isRecord(event.result)
                ? event.result
                : undefined
              : 'status' in event || 'response' in event
                ? event
                : undefined;
          if (!payload) continue;
          const mapped = mapPayload(payload);
          if (mapped.conversationId.length > 0 && mapped.conversationId !== reportedId) {
            reportedId = mapped.conversationId;
            yield { type: 'session', conversationId: mapped.conversationId };
          }
          if (mapped.usage) yield { type: 'usage', usage: mapped.usage };
          const doneNotes = [...notes];
          if (mapped.errorNote) doneNotes.push(mapped.errorNote);
          emittedDone = true;
          yield {
            type: 'done',
            result: this.assemble(
              { ...mapped, conversationId: mapped.conversationId || fallbackId },
              doneNotes,
              model,
              payload,
            ),
          };
        }
      }
    } catch (e) {
      if (!emittedDone) yield { type: 'error', message: errorMessage(e) };
      return;
    }
    if (emittedDone) return;

    // Stream ended with no `result` event: mirror run()'s degraded outcomes.
    if (endMeta?.timedOut) {
      const doneNotes = [...notes, `timed out after ${task.timeoutMs}ms`];
      yield {
        type: 'done',
        result: this.assemble(
          { conversationId: conversationId || fallbackId, text: textSoFar, status: 'incomplete' },
          doneNotes,
          model,
          undefined,
        ),
      };
      return;
    }
    const code = endMeta?.exitCode;
    const codePart = code !== undefined && code !== null ? ` (exit ${code})` : '';
    const tail = endMeta?.stderrTail?.trim() ? `: ${endMeta.stderrTail.trim()}` : '';
    yield { type: 'error', message: `agy stream ended without a result event${codePart}${tail}` };
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

  /**
   * Build the argv shared by run() and stream(): `--conversation <id>` (with `resumeId`), then
   * `--output-format <format>`, then optional `--model` / `--mode` (permissionMode passed
   * through verbatim) / `--dangerously-skip-permissions` (ONLY with `elevated`), then
   * `extra.args`, then `-p` and the prompt LAST. No `--` fence (see run()). With no turn-lane
   * field it is exactly the 0.1.2 argv.
   */
  private buildRunArgs(
    task: RunTask,
    format: 'json' | 'stream-json',
    model: string | undefined,
    extraStrArgs: string[],
    plan: TurnPlan,
    prompt: string,
  ): string[] {
    const args: string[] = [];
    if (plan.resumeId !== undefined) args.push('--conversation', plan.resumeId);
    args.push('--output-format', format);
    if (model) args.push('--model', model); // already trimmed/resolved by the caller
    if (isNonEmpty(task.permissionMode)) args.push('--mode', task.permissionMode);
    if (plan.elevated) args.push('--dangerously-skip-permissions');
    args.push(...extraStrArgs);
    args.push('-p', prompt); // prompt is ALWAYS the final argv element, directly after -p
    return args;
  }

  /**
   * The prompt for this run (since 0.1.3): with `appendSystemPromptFile`, the file's content
   * (trimmed), a blank line, then the prompt — agy has no system-prompt flag — and a note saying
   * so. An unreadable file, or one over 256 KiB, throws.
   */
  private async composePrompt(prompt: string, file: string | undefined, notes: string[]): Promise<string> {
    if (file === undefined) return prompt;
    let text: string | null;
    try {
      text = await this.readTextFile(file);
    } catch {
      text = null;
    }
    if (text === null) {
      throw new AgentMeshError(`agy appendSystemPromptFile could not be read: ${file}`, VENDOR);
    }
    if (Buffer.byteLength(text, 'utf8') > APPEND_PROMPT_MAX_BYTES) {
      throw new AgentMeshError(
        `agy appendSystemPromptFile is larger than ${APPEND_PROMPT_MAX_BYTES} bytes: ${file}`,
        VENDOR,
      );
    }
    const content = text.trim();
    if (content === '') {
      notes.push('appendSystemPromptFile is empty; nothing was prefixed');
      return prompt;
    }
    notes.push('appendSystemPromptFile: agy has no system-prompt flag; its content was prefixed to the prompt');
    return `${content}\n\n${prompt}`;
  }

  /**
   * The quota cache / single-flight key for a resolved child env: the `AGY_HOME` the child
   * would see ('' for none). Two calls key alike exactly when run() would hand agy the same
   * account directory — today agy reads none of them (see `AGY_HOME_NOTE`).
   */
  private quotaKey(env: Record<string, string | undefined>): string {
    return env.AGY_HOME ?? '';
  }

  /**
   * Compose the fully resolved child env for a call, plus the note that applies. With
   * `opts.env` (0.1.3) that env is used VERBATIM (a copy) — no `AGY_HOME` of the adapter's own —
   * and an explicit `account.configDir` it displaces is noted. Otherwise, account precedence: an
   * explicitly passed `account` is authoritative — with no `configDir` it means AMBIENT and does
   * NOT fall back to `defaultAccount.configDir`; only `account === undefined` falls back to the
   * default account. When a config dir resolves, it is set as `AGY_HOME` — which agy 1.3.5 does
   * not read, hence the note.
   */
  private childEnv(
    account?: unknown,
    opts?: RunOptions,
  ): { env: Record<string, string | undefined>; note?: string } {
    // A null/malformed account is ABSENT (falls back to defaultAccount); a real account
    // object with no configDir is AMBIENT and does NOT inherit defaultAccount.configDir.
    const acct = isRecord(account) ? account : undefined;
    if (opts?.env) {
      const explicit = acct !== undefined && typeof acct.configDir === 'string' && acct.configDir !== '';
      return { env: { ...opts.env }, ...(explicit ? { note: ENV_ACCOUNT_NOTE } : {}) };
    }
    const configDir = acct
      ? typeof acct.configDir === 'string'
        ? acct.configDir
        : undefined
      : this.defaultAccount?.configDir;
    const env: Record<string, string | undefined> = { ...this.env };
    if (configDir) {
      env.AGY_HOME = configDir;
      return { env, note: AGY_HOME_NOTE };
    }
    return { env };
  }

  /** Spawn the CLI with the built argv, then map stdout/exit into a RunResult. */
  private async execAndMap(args: string[], ctx: ExecContext, opts?: RunOptions): Promise<RunResult> {
    const { env, note: envNote } = this.childEnv(ctx.account, opts);
    const notes = [...ctx.notes];
    if (envNote) notes.push(envNote);
    // resume() and a resumed run() ONLY: substitute the caller's trimmed id when the payload
    // echoes none. A fresh run() leaves fallbackConversationId unset, so '' stays '' — never fabricated.
    const withFallbackId = (id: string): string =>
      id.length === 0 && ctx.fallbackConversationId ? ctx.fallbackConversationId : id;

    let res: ExecResult;
    try {
      const req: ExecRequest = { cmd: this.binary, args, cwd: ctx.cwd, env, timeoutMs: ctx.timeoutMs };
      // A per-run seam (RunOptions.lineStream) is the ONLY seam this run spawns through.
      res = opts?.lineStream ? await execOverLineStream(opts.lineStream, req) : await this.exec(req);
    } catch (err) {
      // Spawn-level failure (e.g. ENOENT: agy not installed).
      throw new AdapterExecError(`agy failed to start: ${errorMessage(err)}`, VENDOR, {
        stderr: truncate(errorMessage(err), STDERR_CAP),
      });
    }

    const payload = pickLastJsonObject(res.stdout);

    // Timeout never throws — resolve 'incomplete' with best-effort partials (M6).
    if (res.timedOut) {
      notes.push(`timed out after ${ctx.timeoutMs}ms`);
      if (payload) {
        const mapped = mapPayload(payload);
        return this.assemble(
          { conversationId: withFallbackId(mapped.conversationId), text: mapped.text, status: 'incomplete', ...(mapped.usage ? { usage: mapped.usage } : {}) },
          notes,
          ctx.modelOverride,
          payload,
        );
      }
      return this.assemble({ conversationId: withFallbackId(''), text: '', status: 'incomplete' }, notes, ctx.modelOverride, undefined);
    }

    // A parsed payload maps directly — this covers the ground-truth case of exit 1
    // WITH an ERROR payload (status:'ERROR' → 'error'), which must NOT throw.
    if (payload) {
      const mapped = mapPayload(payload);
      if (mapped.errorNote) notes.push(mapped.errorNote);
      return this.assemble({ ...mapped, conversationId: withFallbackId(mapped.conversationId) }, notes, ctx.modelOverride, payload);
    }

    // Non-zero exit with nothing parseable → hard failure.
    if ((res.exitCode ?? 0) !== 0) {
      throw new AdapterExecError(`agy exited with code ${res.exitCode}`, VENDOR, {
        ...(typeof res.exitCode === 'number' ? { exitCode: res.exitCode } : {}),
        stderr: truncate(res.stderr, STDERR_CAP),
      });
    }

    // Zero exit, nothing parsed.
    return this.assemble({ conversationId: withFallbackId(''), text: '', status: 'incomplete' }, notes, ctx.modelOverride, undefined);
  }

  /** Build the final RunResult from a mapped payload, composed notes, model, and raw. */
  private assemble(
    mapped: Omit<MappedPayload, 'errorNote'>,
    notes: string[],
    modelOverride: string | undefined,
    raw: unknown,
  ): RunResult {
    const result: RunResult = {
      vendor: VENDOR,
      conversationId: mapped.conversationId,
      text: mapped.text,
      status: mapped.status,
    };
    if (modelOverride) result.model = modelOverride;
    if (mapped.usage) result.usage = mapped.usage;
    if (notes.length > 0) result.note = notes.join('; ');
    if (raw !== undefined) result.raw = raw;
    return result;
  }
}
