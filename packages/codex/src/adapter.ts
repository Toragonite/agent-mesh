/**
 * CodexAdapter — drives the official OpenAI `codex` CLI headlessly behind the
 * frozen agent-mesh Adapter contract.
 *
 * Since 0.1.3 it also streams (`stream()` reads `codex exec --json` line by line) and drives
 * the turn lane: `task.resumeId` continues a thread with `codex exec resume <id>` — which
 * REQUIRES a model — and `task.mcp` attaches one MCP server for the run through `-c` overrides.
 *
 * Every external seam (process exec, line stream, file reads, network fetch) is injectable
 * with a real default, so the whole adapter is testable without a CLI, a home
 * directory, or a network. No token or secret ever appears in a result, note,
 * detail, error, or raw payload.
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
  type RunStatus,
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
import { CodexEventParser, parseCodexEvents, type ParsedRun } from './parse.js';
import {
  DEFAULT_LIVE_MODELS_TIMEOUT_MS,
  STATIC_MODELS,
  catalogNote,
  cloneModel,
  fetchLiveModels,
  gateList,
  gateModel,
} from './models.js';
import { resolveAuthStatus, resolveCodexHome, type ReadTextFile } from './auth.js';
import { readQuota } from './quota.js';

export interface CodexAdapterOptions {
  /** Process-exec seam. Defaults to a real child_process spawner. */
  exec?: ExecFn;
  /** Line-streaming seam for `stream()` (since 0.1.3). Defaults to a real line streamer. */
  lineStream?: LineStreamFn;
  /** CLI binary name/path. Defaults to `codex`. */
  binary?: string;
  /** Account used when a task/call names none. */
  defaultAccount?: Account;
  /** File-read seam returning file contents or null when absent. Defaults to fs. */
  readTextFile?: ReadTextFile;
  /** Fetch seam for the quota endpoint. Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /**
   * Deadline for the quota fetch, in milliseconds (default 10000). The request is
   * aborted at this deadline so a hung endpoint cannot stall `Fleet.route()`; an
   * abort resolves `null`, like every other quota failure.
   */
  quotaTimeoutMs?: number;
  /**
   * Environment seam (defaults to process.env). Additive to the pinned public
   * seams — present so auth/quota/env-merge are fully hermetic in tests.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Deadline for the `codex app-server` model listing behind `availableModels()`, in
   * ms (default 15000). The app-server must answer AND exit by itself within it, or
   * its process group is killed and the static list is returned.
   */
  modelsTimeoutMs?: number;
  /**
   * How long a FAILED listing keeps returning the static list before the CLI is asked
   * again, in ms (default 60000), per account home. A successful listing is memoized
   * per account home for the life of the instance. Either way a routing decision
   * never spawns a process on every call.
   */
  modelsCacheMs?: number;
  /**
   * Since 0.1.3: pass `--skip-git-repo-check` on every run that STARTS a thread (never on a
   * resume), so codex runs in a directory that is not a git checkout. Default false.
   */
  skipGitRepoCheck?: boolean;
}

const VENDOR: Vendor = 'codex';
const STDERR_CAP = 4096;
const DEFAULT_QUOTA_TIMEOUT_MS = 10_000;
const DEFAULT_MODELS_CACHE_MS = 60_000;

/** `McpAttachment.name`: a lowercase identifier — it is a bare key of the `-c mcp_servers.<name>` path. */
const MCP_NAME = /^[a-z][a-z0-9_]{0,31}$/;
/** C0 control characters and DEL — never part of a path, a TOML basic string, or a CLI value. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** The largest `appendSystemPromptFile` whose content is prefixed to a prompt. */
const APPEND_PROMPT_MAX_BYTES = 256 * 1024;
/** The note for an explicit account whose config dir `options.env` displaces. */
const ENV_ACCOUNT_NOTE = 'account.configDir not applied: options.env is the complete child environment';
/** The refusal for a resumed run without a model (measured on codex-cli 0.162.1). */
const RESUME_NEEDS_MODEL =
  'Codex resume needs a model (-m): codex exec resume otherwise runs the model named in config.toml, ' +
  'which may no longer exist — pass task.model with resumeId';

/** Default file reader: contents as utf-8, or null on any read failure (e.g. ENOENT). */
const defaultReadTextFile: ReadTextFile = async (path) => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

function isNonEmpty(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Coerce an account argument to a real Account or undefined. A null, array, or
 * any non-object value is treated as ABSENT (falls back to the default account),
 * never a raw TypeError. An object with no `configDir` is still a valid account
 * meaning "ambient login" — it is returned as-is, not normalized away.
 */
function asAccount(x: unknown): Account | undefined {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Account) : undefined;
}

/** The composed note for dropped `extra.args` entries, pluralized. */
function droppedArgsNote(n: number): string {
  return `extra.args contained ${n} non-string ${n === 1 ? 'entry' : 'entries'}; dropped`;
}

function truncate(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) : s;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Verbatim extra CLI args from `extra.args`, keeping only strings and reporting
 * how many non-string entries were dropped so the caller can surface a note.
 */
function extraArgs(extra: Record<string, unknown> | undefined): { args: string[]; dropped: number } {
  const raw = extra?.args;
  if (!Array.isArray(raw)) return { args: [], dropped: 0 };
  const args = raw.filter((a): a is string => typeof a === 'string');
  return { args, dropped: raw.length - args.length };
}

/** A TOML basic string: `\` and `"` escaped. Control characters are refused before this is called. */
function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A TOML array of basic strings, with no spaces: `["a","b"]`. */
function tomlArray(items: readonly string[]): string {
  return `[${items.map(tomlString).join(',')}]`;
}

/**
 * The `-c` overrides that attach one MCP server to this run only (codex-cli 0.162.1): its command,
 * its args, and `default_tools_approval_mode="approve"` — without which every tool call is
 * refused ("MCP tool call requires approval, but approval policy is never"). No `env` table: a
 * codex MCP child gets a filtered environment, so the server's identity travels in `args`.
 */
function mcpArgs(mcp: McpAttachment): string[] {
  const key = `mcp_servers.${mcp.name}`;
  return [
    '-c',
    `${key}.command=${tomlString(mcp.command)}`,
    '-c',
    `${key}.args=${tomlArray(mcp.args)}`,
    '-c',
    `${key}.default_tools_approval_mode="approve"`,
  ];
}

/* ------------------------------------------------------------------------- *
 * The turn-lane fields of a task (0.1.3) — validated BEFORE anything spawns.
 * ------------------------------------------------------------------------- */

/** A conversation id field: trimmed; blank or `-`-leading throws. `undefined` stays absent. */
function conversationIdField(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (id === '') {
    throw new AgentMeshError(`codex ${field} must be a non-empty conversation id`, VENDOR);
  }
  if (id.startsWith('-')) {
    throw new AgentMeshError(`codex ${field} must not start with "-" (would parse as a CLI flag)`, VENDOR);
  }
  return id;
}

/** An absolute-path field (no control characters). `undefined` stays absent; anything else throws. */
function absolutePathField(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !path.isAbsolute(raw) || CONTROL_CHARS.test(raw)) {
    throw new AgentMeshError(`codex ${field} must be an absolute path`, VENDOR);
  }
  return raw;
}

/** Validate an {@link McpAttachment}: every field is checked by value; a bad one throws. */
function mcpField(raw: unknown): McpAttachment {
  if (!isRecord(raw)) {
    throw new AgentMeshError('codex mcp must be an object { name, command, args, configFile }', VENDOR);
  }
  const { name, command, args } = raw;
  if (typeof name !== 'string' || !MCP_NAME.test(name)) {
    throw new AgentMeshError('codex mcp.name must match /^[a-z][a-z0-9_]{0,31}$/', VENDOR);
  }
  if (typeof command !== 'string' || command.trim() === '' || CONTROL_CHARS.test(command)) {
    throw new AgentMeshError('codex mcp.command must be a non-empty string without control characters', VENDOR);
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string' && !CONTROL_CHARS.test(a))) {
    throw new AgentMeshError('codex mcp.args must be an array of strings without control characters', VENDOR);
  }
  const configFile = absolutePathField(raw.configFile, 'mcp.configFile');
  if (configFile === undefined) {
    throw new AgentMeshError('codex mcp.configFile must be an absolute path', VENDOR);
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
    throw new AgentMeshError(`codex ${field} must be an array of tool names`, VENDOR);
  }
  return raw.some((t) => typeof t === 'string' && t.trim() !== '');
}

/** One stream event per Codex item: agent text as `text`, any tool-ish item as `tool`. */
function* itemEvents(ev: Record<string, unknown>, started: Set<string>): Generator<RunEvent> {
  const type = typeof ev.type === 'string' ? ev.type : '';
  if (type !== 'item.started' && type !== 'item.completed') return;
  const item = isRecord(ev.item) ? ev.item : undefined;
  if (!item) return;
  const itemType = typeof item.type === 'string' ? item.type : '';
  if (itemType.includes('agent_message')) {
    if (type === 'item.completed' && typeof item.text === 'string' && item.text !== '') {
      yield { type: 'text', text: item.text };
    }
    return;
  }
  if (itemType === '' || itemType.includes('reasoning') || itemType === 'error') return;
  const id = typeof item.id === 'string' ? item.id : undefined;
  if (type === 'item.started') {
    if (id !== undefined) started.add(id);
  } else if (id !== undefined && started.has(id)) {
    return; // its start already reported this tool
  }
  const name =
    itemType.includes('mcp_tool_call') && typeof item.server === 'string' && typeof item.tool === 'string'
      ? `mcp__${item.server}__${item.tool}`
      : itemType;
  yield { type: 'tool', name, detail: item };
}

/** The validated turn-lane plan of one run()/stream() call. */
interface TurnPlan {
  /** Continue this thread (`codex exec resume <id>`). */
  resumeId?: string;
  /** The trimmed model; REQUIRED with `resumeId`. */
  model?: string;
  mcp?: McpAttachment;
  appendSystemPromptFile?: string;
  /** Notes for the fields this adapter ignores, in their stable order. */
  notes: string[];
}

interface MapContext {
  task: { cwd?: string; account?: Account; timeoutMs?: number };
  /** Model override from the request (task.model / opts.model). */
  modelOverride?: string;
  /** Fall back to this id when the stream echoes none (resume only). */
  fallbackId?: string;
  /** Notes accumulated before exec (e.g. allowedTools ignored). */
  notes: string[];
}

/** How a finished child ended, from exec or from a line stream's end metadata. */
interface ExitInfo {
  timedOut: boolean;
  exitCode: number | null;
  stderr: string;
}

export class CodexAdapter implements Adapter {
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
  private readonly readTextFile: ReadTextFile;
  private readonly fetchFn: typeof fetch;
  private readonly quotaTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly modelsTimeoutMs: number;
  private readonly modelsCacheMs: number;
  private readonly skipGitRepoCheck: boolean;

  /** Successful live listings, per resolved CODEX_HOME (memoized for the instance's life). */
  private readonly liveModels = new Map<string, ModelInfo[]>();
  /** Per CODEX_HOME: epoch-ms until which a FAILED listing is not retried. */
  private readonly liveFailedUntil = new Map<string, number>();
  /** Per CODEX_HOME: the listing in flight, so concurrent calls share one app-server. */
  private readonly liveInFlight = new Map<string, Promise<ModelInfo[] | undefined>>();

  constructor(opts: CodexAdapterOptions = {}) {
    this.exec = opts.exec ?? nodeExec;
    this.lineStream = opts.lineStream ?? nodeLineStream;
    this.binary = opts.binary ?? 'codex';
    this.defaultAccount = opts.defaultAccount;
    this.readTextFile = opts.readTextFile ?? defaultReadTextFile;
    this.fetchFn = opts.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.quotaTimeoutMs = opts.quotaTimeoutMs ?? DEFAULT_QUOTA_TIMEOUT_MS;
    this.env = opts.env ?? process.env;
    this.modelsTimeoutMs = opts.modelsTimeoutMs ?? DEFAULT_LIVE_MODELS_TIMEOUT_MS;
    this.modelsCacheMs = opts.modelsCacheMs ?? DEFAULT_MODELS_CACHE_MS;
    this.skipGitRepoCheck = opts.skipGitRepoCheck === true;
  }

  async authStatus(account?: Account): Promise<AuthStatus> {
    const home = resolveCodexHome(asAccount(account), this.defaultAccount, this.env);
    return resolveAuthStatus(this.env.OPENAI_API_KEY, home, this.readTextFile);
  }

  /**
   * The models this account can pick, as the CLI itself lists them (`codex
   * app-server` → `model/list`, run with this account's CODEX_HOME), gated by auth
   * mode exactly like the static catalog. When the CLI cannot answer — not
   * installed, an error, a malformed answer, the deadline — the static catalog is
   * returned instead. Never throws, never hangs (`modelsTimeoutMs` bounds the
   * listing). A successful listing is memoized per CODEX_HOME; a failed one is
   * retried after `modelsCacheMs`. Fresh arrays every call.
   */
  async availableModels(account?: Account): Promise<ModelInfo[]> {
    const status = await this.authStatus(account);
    const home = resolveCodexHome(asAccount(account), this.defaultAccount, this.env);
    const live = await this.liveModelsFor(home);
    return gateList(live ?? STATIC_MODELS, status);
  }

  /** The memoized live listing for one CODEX_HOME, or undefined while it is unavailable. */
  private async liveModelsFor(home: string): Promise<ModelInfo[] | undefined> {
    const cached = this.liveModels.get(home);
    if (cached) return cached.map(cloneModel);
    if (Date.now() < (this.liveFailedUntil.get(home) ?? 0)) return undefined;
    let pending = this.liveInFlight.get(home);
    if (!pending) {
      pending = fetchLiveModels({
        binary: this.binary,
        codexHome: home,
        env: this.env,
        timeoutMs: this.modelsTimeoutMs,
      })
        .then((models) => {
          if (models.length > 0) {
            this.liveModels.set(home, models);
            return models;
          }
          this.liveFailedUntil.set(home, Date.now() + this.modelsCacheMs);
          return undefined;
        })
        .catch(() => undefined) // fetchLiveModels never rejects; belt-and-braces
        .finally(() => this.liveInFlight.delete(home));
      this.liveInFlight.set(home, pending);
    }
    const models = await pending;
    return models?.map(cloneModel);
  }

  async quota(account?: Account): Promise<QuotaSnapshot | null> {
    const home = resolveCodexHome(asAccount(account), this.defaultAccount, this.env);
    return readQuota(home, this.readTextFile, this.fetchFn, this.quotaTimeoutMs);
  }

  /**
   * One headless run over `codex exec --json`. Since 0.1.3 the turn-lane fields apply exactly
   * as {@link stream} documents (`resumeId` continues a thread and REQUIRES `model`), and
   * `opts.lineStream` / `opts.env` / `opts.skipAuthCheck` are honoured.
   */
  async run(task: RunTask, opts?: RunOptions): Promise<RunResult> {
    if (!isNonEmpty(task.prompt)) {
      throw new AgentMeshError('run: prompt must be a non-empty string', VENDOR);
    }
    const plan = this.planTurn(task);
    const notes: string[] = [];
    if (task.allowedTools && task.allowedTools.length > 0) {
      notes.push('allowedTools not supported by codex; ignored');
    }
    // A provided-but-empty model means "not requested": omit the flag, skip the
    // auth gate, add no note. Only a non-empty (trimmed) value is validated/passed.
    await this.gate(plan.model, task.account, opts, notes);
    const extra = extraArgs(task.extra);
    if (extra.dropped > 0) notes.push(droppedArgsNote(extra.dropped));
    notes.push(...plan.notes);
    const prompt = await this.composePrompt(task.prompt, plan.appendSystemPromptFile, notes);
    const args = this.buildArgs(plan, task.permissionMode, extra.args, prompt);

    return this.execAndMap(
      args,
      {
        task,
        // The trimmed request, exactly as 0.1.2 passed it ('' for a blank model).
        modelOverride: task.model?.trim(),
        notes,
        ...(plan.resumeId !== undefined ? { fallbackId: plan.resumeId } : {}),
      },
      opts,
    );
  }

  async resume(conversationId: string, message: string, opts?: ResumeOptions): Promise<RunResult> {
    // Validate the TRIMMED id, then pass the trimmed value to the CLI — never the
    // raw string with its surrounding whitespace.
    const id = conversationId.trim();
    if (id === '') {
      throw new AgentMeshError('resume: conversationId must be a non-empty string', VENDOR);
    }
    // The id is a positional BEFORE the flags, so the `--` fence cannot protect it.
    // A flag-shaped id (e.g. '--last') would hijack a different session — reject it.
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
    // Same empty-is-absent rule as run(): only a non-empty trimmed model is gated/passed.
    const model = opts?.model?.trim();
    if (model) {
      const gate = gateModel(model, await this.authStatus(opts?.account));
      if (gate.kind === 'blocked') throw new AgentMeshError(gate.message, VENDOR);
      if (gate.kind === 'unknown') notes.push(gate.note);
    }
    const args = ['exec', 'resume', id, '--json'];
    if (model) args.push('--model', model);
    const extra = extraArgs(opts?.extra);
    args.push(...extra.args);
    if (extra.dropped > 0) notes.push(droppedArgsNote(extra.dropped));
    // `--` fences the message positional, mirroring run().
    args.push('--', message); // message is ALWAYS the final argv element

    // ResumeOptions has no cwd (core is frozen); honour a string `extra.cwd` as the
    // child's working directory, otherwise inherit as before.
    const cwd = typeof opts?.extra?.cwd === 'string' ? opts.extra.cwd : undefined;

    return this.execAndMap(args, {
      task: { account: opts?.account, timeoutMs: opts?.timeoutMs, cwd },
      modelOverride: model,
      fallbackId: id,
      notes,
    });
  }

  /**
   * Incremental events over `codex exec --json` (since 0.1.3). The JSONL is read line by line:
   * the thread id (normally `thread.started`'s `thread_id`) emits a `session` event once — the
   * CLI's own report, never `task.resumeId` echoed back; each completed `agent_message` item
   * emits a `text` event; each tool-ish item (a command, an MCP tool call, a file change, …)
   * emits one `tool` event (an MCP call is named `mcp__<server>__<tool>`); reasoning items emit
   * nothing. When the process ends, a `usage` event (when reported) and one `done` follow, with
   * exactly the result `run()` would map from the same output — or one `error` where `run()`
   * would throw (a spawn failure; a non-zero exit with nothing parsed, its stderr tail included).
   *
   * Argv. A first turn: `exec --json [--skip-git-repo-check] [--model <m>] [--sandbox <mode>]
   * [<mcp -c overrides>] [extra.args] -- <prompt>`. A resumed turn (`resumeId`):
   * `exec resume <id> --json --model <m> [-c sandbox_mode="<mode>"] [<mcp -c overrides>]
   * [extra.args] -- <prompt>` — `exec resume` takes no `--sandbox` (the thread's sandbox carries
   * over; the override restates it), and a resume without `--model` would run config.toml's model,
   * so a `resumeId` without `model` throws `Codex resume needs a model (-m): …`. The MCP overrides
   * are `-c mcp_servers.<name>.command="…"`, `-c mcp_servers.<name>.args=[…]` and
   * `-c mcp_servers.<name>.default_tools_approval_mode="approve"` (TOML strings). Measured on
   * codex-cli 0.162.1.
   *
   * Before the spawn a non-empty `model` is gated against the login (`authStatus()`) unless
   * `opts.skipAuthCheck`; a blocked model or an unreadable `appendSystemPromptFile` ends the
   * stream with one `error` and spawns nothing. A blank prompt and every invalid turn-lane field
   * throw synchronously, at call time.
   */
  stream(task: RunTask, opts?: RunOptions): AsyncGenerator<RunEvent> {
    if (!isNonEmpty(task.prompt)) {
      throw new AgentMeshError('run: prompt must be a non-empty string', VENDOR);
    }
    const plan = this.planTurn(task);
    return this.streamEvents(task, plan, opts);
  }

  /** Codex has no interactive take-over in this release. */
  interactiveResume(_conversationId: string, _account?: Account): undefined {
    return undefined;
  }

  /** The generator behind {@link stream}; the task is already validated. */
  private async *streamEvents(task: RunTask, plan: TurnPlan, opts?: RunOptions): AsyncGenerator<RunEvent> {
    const notes: string[] = [];
    let args: string[];
    try {
      if (task.allowedTools && task.allowedTools.length > 0) {
        notes.push('allowedTools not supported by codex; ignored');
      }
      await this.gate(plan.model, task.account, opts, notes);
      const extra = extraArgs(task.extra);
      if (extra.dropped > 0) notes.push(droppedArgsNote(extra.dropped));
      notes.push(...plan.notes);
      const prompt = await this.composePrompt(task.prompt, plan.appendSystemPromptFile, notes);
      args = this.buildArgs(plan, task.permissionMode, extra.args, prompt);
    } catch (e) {
      yield { type: 'error', message: errorMessage(e) };
      return;
    }
    const { env, note: envNote } = this.childEnv(task.account, opts);
    if (envNote) notes.push(envNote);
    // A per-run seam (RunOptions.lineStream) is the ONLY seam this run spawns through.
    const lineStream: LineStreamFn = opts?.lineStream ?? this.lineStream;

    const parser = new CodexEventParser();
    const started = new Set<string>();
    let reported = '';
    let endMeta: StreamEndMeta | undefined;
    try {
      for await (const line of lineStream(
        { cmd: this.binary, args, cwd: task.cwd, env, timeoutMs: task.timeoutMs },
        (meta) => {
          endMeta = meta;
        },
      )) {
        const ev = parser.push(line);
        if (!ev) continue;
        const id = parser.conversationId;
        if (id !== '' && id !== reported) {
          reported = id;
          yield { type: 'session', conversationId: id };
        }
        yield* itemEvents(ev, started);
      }
    } catch (e) {
      yield { type: 'error', message: errorMessage(e) };
      return;
    }

    const exit: ExitInfo = {
      timedOut: endMeta?.timedOut ?? false,
      exitCode: endMeta ? endMeta.exitCode : null,
      stderr: endMeta?.stderrTail ?? '',
    };
    let result: RunResult;
    try {
      result = this.finish(parser.result(), exit, {
        task,
        modelOverride: task.model?.trim(),
        notes,
        ...(plan.resumeId !== undefined ? { fallbackId: plan.resumeId } : {}),
      });
    } catch (e) {
      const tail = exit.stderr.trim();
      yield { type: 'error', message: `${errorMessage(e)}${tail ? `: ${tail}` : ''}` };
      return;
    }
    if (result.usage) yield { type: 'usage', usage: result.usage };
    yield { type: 'done', result };
  }

  /**
   * Validate the turn-lane fields of `task` (synchronously — so `stream()` throws at call time)
   * and plan the run. Throws AgentMeshError for: a blank or flag-shaped `resumeId`; `resumeId`
   * together with `sessionId`; `resumeId` without a model; a relative `appendSystemPromptFile`;
   * an invalid `mcp`; a non-array `disallowedTools`; a control character in a resumed run's
   * `permissionMode` (it becomes a TOML string).
   */
  private planTurn(task: RunTask): TurnPlan {
    const notes: string[] = [];
    const resumeId = conversationIdField(task.resumeId, 'resumeId');
    if (task.sessionId !== undefined) {
      if (resumeId !== undefined) {
        throw new AgentMeshError(
          'codex sessionId and resumeId are mutually exclusive: sessionId starts a conversation, resumeId continues one',
          VENDOR,
        );
      }
      notes.push('sessionId not supported by codex (the thread id comes from thread.started); ignored');
    }
    const model = task.model?.trim() || undefined;
    if (resumeId !== undefined && model === undefined) {
      throw new AgentMeshError(RESUME_NEEDS_MODEL, VENDOR);
    }
    if (resumeId !== undefined && isNonEmpty(task.permissionMode) && CONTROL_CHARS.test(task.permissionMode)) {
      throw new AgentMeshError('codex permissionMode must not contain control characters', VENDOR);
    }
    const appendSystemPromptFile = absolutePathField(task.appendSystemPromptFile, 'appendSystemPromptFile');
    const mcp = task.mcp === undefined ? undefined : mcpField(task.mcp);
    if (namesAnyTool(task.disallowedTools, 'disallowedTools')) {
      notes.push('disallowedTools not supported by codex; ignored');
    }
    if (isNonEmpty(task.settingSources)) {
      notes.push('settingSources not supported by codex; ignored');
    }
    if (task.elevated === true) {
      notes.push('elevated has no codex equivalent (the sandbox comes from permissionMode); ignored');
    }
    if (mcp?.projectConfigFile !== undefined) {
      notes.push('mcp.projectConfigFile is not supported by codex; ignored');
    }
    return {
      ...(resumeId !== undefined ? { resumeId } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(mcp !== undefined ? { mcp } : {}),
      ...(appendSystemPromptFile !== undefined ? { appendSystemPromptFile } : {}),
      notes,
    };
  }

  /** The argv for one planned run (see {@link stream} for the two shapes). */
  private buildArgs(plan: TurnPlan, permissionMode: string | undefined, extra: string[], prompt: string): string[] {
    const args = plan.resumeId !== undefined ? ['exec', 'resume', plan.resumeId, '--json'] : ['exec', '--json'];
    if (plan.resumeId === undefined && this.skipGitRepoCheck) args.push('--skip-git-repo-check');
    if (plan.model) args.push('--model', plan.model);
    if (isNonEmpty(permissionMode)) {
      // `exec resume` takes no --sandbox: restate the thread's sandbox as a config override.
      if (plan.resumeId !== undefined) args.push('-c', `sandbox_mode=${tomlString(permissionMode)}`);
      else args.push('--sandbox', permissionMode);
    }
    if (plan.mcp) args.push(...mcpArgs(plan.mcp));
    args.push(...extra);
    // `--` fences the prompt so a flag-shaped prompt (e.g. '--help') is treated as
    // the positional, never parsed as a CLI flag. Flags stay before the fence.
    args.push('--', prompt); // prompt is ALWAYS the final argv element
    return args;
  }

  /**
   * The pre-spawn model gate: a non-empty model is checked against the login; a model the login
   * cannot select throws, an off-catalog one adds a note. With `opts.skipAuthCheck` the login is
   * NOT read (only the catalog note is computed). With `opts.env` the login is the one the child
   * will see: `OPENAI_API_KEY` and `CODEX_HOME` from that env.
   */
  private async gate(
    model: string | undefined,
    account: Account | undefined,
    opts: RunOptions | undefined,
    notes: string[],
  ): Promise<void> {
    if (!model) return;
    if (opts?.skipAuthCheck === true) {
      const note = catalogNote(model);
      if (note) notes.push(note);
      return;
    }
    const status = opts?.env
      ? await resolveAuthStatus(
          opts.env.OPENAI_API_KEY,
          resolveCodexHome(undefined, undefined, opts.env),
          this.readTextFile,
        )
      : await this.authStatus(account);
    const gate = gateModel(model, status);
    if (gate.kind === 'blocked') throw new AgentMeshError(gate.message, VENDOR);
    if (gate.kind === 'unknown') notes.push(gate.note);
  }

  /**
   * The prompt for this run: with `appendSystemPromptFile`, the file's content (trimmed) followed
   * by a blank line and the prompt — codex has no system-prompt flag — and a note saying so. An
   * unreadable file, or one over 256 KiB, throws.
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
      throw new AgentMeshError(`codex appendSystemPromptFile could not be read: ${file}`, VENDOR);
    }
    if (Buffer.byteLength(text, 'utf8') > APPEND_PROMPT_MAX_BYTES) {
      throw new AgentMeshError(
        `codex appendSystemPromptFile is larger than ${APPEND_PROMPT_MAX_BYTES} bytes: ${file}`,
        VENDOR,
      );
    }
    const content = text.trim();
    if (content === '') {
      notes.push('appendSystemPromptFile is empty; nothing was prefixed');
      return prompt;
    }
    notes.push('appendSystemPromptFile: codex has no system-prompt flag; its content was prefixed to the prompt');
    return `${content}\n\n${prompt}`;
  }

  /**
   * The child env. With `opts.env` (0.1.3): that env VERBATIM (a copy) — no `CODEX_HOME` of the
   * adapter's own; an explicit `account.configDir` it displaces is noted. Otherwise the 0.1.2
   * rule: the injected seam (this.env) with `CODEX_HOME` overlaid from the account.
   */
  private childEnv(
    account: Account | undefined,
    opts?: RunOptions,
  ): { env: Record<string, string | undefined>; note?: string } {
    const acct = asAccount(account);
    if (opts?.env) {
      const explicit = acct !== undefined && typeof acct.configDir === 'string' && acct.configDir !== '';
      return { env: { ...opts.env }, ...(explicit ? { note: ENV_ACCOUNT_NOTE } : {}) };
    }
    // Account precedence mirrors resolveCodexHome(): a well-formed passed account
    // is authoritative — with no configDir it means "ambient login", NOT the
    // default account's dir. A missing OR malformed (null/non-object) account
    // falls back to the default.
    const configDir = acct ? acct.configDir : this.defaultAccount?.configDir;
    // Compose the FULL child env from the injected seam (this.env), not raw
    // process.env, so introspection and execution resolve the same account. The
    // exec seam treats this as the base and does not merge over process.env.
    const env: Record<string, string | undefined> = { ...this.env };
    if (configDir) env.CODEX_HOME = configDir;
    return { env };
  }

  /** Spawn the CLI with the built argv, then map stdout/exit into a RunResult. */
  private async execAndMap(args: string[], ctx: MapContext, opts?: RunOptions): Promise<RunResult> {
    const { env, note } = this.childEnv(ctx.task.account, opts);
    const req: ExecRequest = {
      cmd: this.binary,
      args,
      cwd: ctx.task.cwd,
      env,
      timeoutMs: ctx.task.timeoutMs,
    };
    let res: ExecResult;
    try {
      // A per-run seam (RunOptions.lineStream) is the ONLY seam this run spawns through.
      res = opts?.lineStream ? await execOverLineStream(opts.lineStream, req) : await this.exec(req);
    } catch (err) {
      // Spawn-level failure (e.g. ENOENT: codex not installed).
      throw new AdapterExecError(`codex failed to start: ${errorMessage(err)}`, VENDOR, {
        stderr: truncate(errorMessage(err), STDERR_CAP),
      });
    }
    return this.finish(
      parseCodexEvents(res.stdout),
      { timedOut: res.timedOut, exitCode: res.exitCode, stderr: res.stderr },
      note ? { ...ctx, notes: [...ctx.notes, note] } : ctx,
    );
  }

  /**
   * Map a finished run — its parsed events and how the process ended — to a RunResult, or throw
   * AdapterExecError for a non-zero exit that produced nothing parseable. Shared by run(),
   * resume() and stream(), so all three map the same output identically.
   */
  private finish(parsed: ParsedRun, exit: ExitInfo, ctx: MapContext): RunResult {
    const notes = [...ctx.notes];

    const finalize = (status: RunStatus): RunResult => {
      const conversationId = ctx.fallbackId
        ? parsed.conversationId || ctx.fallbackId
        : parsed.conversationId;
      const model = ctx.modelOverride ?? parsed.model;
      const result: RunResult = { vendor: VENDOR, conversationId, text: parsed.text, status };
      if (model) result.model = model;
      if (parsed.usage) result.usage = parsed.usage;
      if (notes.length > 0) result.note = notes.join('; ');
      if (parsed.raw !== undefined) result.raw = parsed.raw;
      return result;
    };

    // Timeout never throws — resolve 'incomplete' with best-effort partials.
    if (exit.timedOut) {
      notes.push(`timed out after ${ctx.task.timeoutMs}ms`);
      return finalize('incomplete');
    }

    // An explicit vendor error event ALWAYS resolves status 'error' (matching the
    // claude adapter, which maps `is_error:true` to 'error' while keeping its
    // text): any partial assistant text is PRESERVED in `text`, and the vendor's
    // message rides in `note`. This wins over a partial answer — a refusal must
    // never be reported as a clean success — and precedes the exit-code throw so
    // AdapterExecError stays reserved for a non-zero exit with nothing parseable.
    if (parsed.errorMessage) {
      notes.push(parsed.errorMessage);
      return finalize('error');
    }

    // Non-zero exit with NO parsed signal at all → hard failure.
    if (parsed.text === '' && (exit.exitCode ?? 0) !== 0) {
      throw new AdapterExecError(`codex exited with code ${exit.exitCode}`, VENDOR, {
        ...(typeof exit.exitCode === 'number' ? { exitCode: exit.exitCode } : {}),
        stderr: truncate(exit.stderr, STDERR_CAP),
      });
    }

    if (parsed.text !== '') return finalize('ok');

    // Zero exit, nothing parsed.
    return finalize('incomplete');
  }
}
