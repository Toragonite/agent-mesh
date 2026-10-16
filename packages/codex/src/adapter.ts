/**
 * CodexAdapter — drives the official OpenAI `codex` CLI headlessly behind the
 * frozen agent-mesh Adapter contract.
 *
 * Every external seam (process exec, file reads, network fetch) is injectable
 * with a real default, so the whole adapter is testable without a CLI, a home
 * directory, or a network. No token or secret ever appears in a result, note,
 * detail, error, or raw payload.
 */
import { readFile } from 'node:fs/promises';
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
  type RunResult,
  type RunStatus,
  type RunTask,
  type Vendor,
} from '@toragonite/agent-mesh';
import { nodeExec, type ExecFn } from './exec.js';
import { parseCodexEvents } from './parse.js';
import {
  DEFAULT_LIVE_MODELS_TIMEOUT_MS,
  STATIC_MODELS,
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
}

const VENDOR: Vendor = 'codex';
const STDERR_CAP = 4096;
const DEFAULT_QUOTA_TIMEOUT_MS = 10_000;
const DEFAULT_MODELS_CACHE_MS = 60_000;

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

interface MapContext {
  task: { cwd?: string; account?: Account; timeoutMs?: number };
  /** Model override from the request (task.model / opts.model). */
  modelOverride?: string;
  /** Fall back to this id when the stream echoes none (resume only). */
  fallbackId?: string;
  /** Notes accumulated before exec (e.g. allowedTools ignored). */
  notes: string[];
}

export class CodexAdapter implements Adapter {
  readonly vendor: Vendor = VENDOR;
  readonly capabilities: AdapterCapabilities = {
    resume: true,
    steer: 'turn',
    peerMesh: false,
    quota: true,
    stream: false,
  };

  private readonly exec: ExecFn;
  private readonly binary: string;
  private readonly defaultAccount?: Account;
  private readonly readTextFile: ReadTextFile;
  private readonly fetchFn: typeof fetch;
  private readonly quotaTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly modelsTimeoutMs: number;
  private readonly modelsCacheMs: number;

  /** Successful live listings, per resolved CODEX_HOME (memoized for the instance's life). */
  private readonly liveModels = new Map<string, ModelInfo[]>();
  /** Per CODEX_HOME: epoch-ms until which a FAILED listing is not retried. */
  private readonly liveFailedUntil = new Map<string, number>();
  /** Per CODEX_HOME: the listing in flight, so concurrent calls share one app-server. */
  private readonly liveInFlight = new Map<string, Promise<ModelInfo[] | undefined>>();

  constructor(opts: CodexAdapterOptions = {}) {
    this.exec = opts.exec ?? nodeExec;
    this.binary = opts.binary ?? 'codex';
    this.defaultAccount = opts.defaultAccount;
    this.readTextFile = opts.readTextFile ?? defaultReadTextFile;
    this.fetchFn = opts.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.quotaTimeoutMs = opts.quotaTimeoutMs ?? DEFAULT_QUOTA_TIMEOUT_MS;
    this.env = opts.env ?? process.env;
    this.modelsTimeoutMs = opts.modelsTimeoutMs ?? DEFAULT_LIVE_MODELS_TIMEOUT_MS;
    this.modelsCacheMs = opts.modelsCacheMs ?? DEFAULT_MODELS_CACHE_MS;
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

  async run(task: RunTask): Promise<RunResult> {
    if (!isNonEmpty(task.prompt)) {
      throw new AgentMeshError('run: prompt must be a non-empty string', VENDOR);
    }
    const notes: string[] = [];
    if (task.allowedTools && task.allowedTools.length > 0) {
      notes.push('allowedTools not supported by codex; ignored');
    }
    // A provided-but-empty model means "not requested": omit the flag, skip the
    // auth gate, add no note. Only a non-empty (trimmed) value is validated/passed.
    const model = task.model?.trim();
    if (model) {
      const gate = gateModel(model, await this.authStatus(task.account));
      if (gate.kind === 'blocked') throw new AgentMeshError(gate.message, VENDOR);
      if (gate.kind === 'unknown') notes.push(gate.note);
    }
    const args = ['exec', '--json'];
    if (model) args.push('--model', model);
    if (isNonEmpty(task.permissionMode)) args.push('--sandbox', task.permissionMode);
    const extra = extraArgs(task.extra);
    args.push(...extra.args);
    if (extra.dropped > 0) notes.push(droppedArgsNote(extra.dropped));
    // `--` fences the prompt so a flag-shaped prompt (e.g. '--help') is treated as
    // the positional, never parsed as a CLI flag. Flags stay before the fence.
    args.push('--', task.prompt); // prompt is ALWAYS the final argv element

    return this.execAndMap(args, {
      task,
      modelOverride: model,
      notes,
    });
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

  /** Spawn the CLI with the built argv, then map stdout/exit into a RunResult. */
  private async execAndMap(args: string[], ctx: MapContext): Promise<RunResult> {
    // Account precedence mirrors resolveCodexHome(): a well-formed passed account
    // is authoritative — with no configDir it means "ambient login", NOT the
    // default account's dir. A missing OR malformed (null/non-object) account
    // falls back to the default.
    const account = asAccount(ctx.task.account);
    const configDir = account ? account.configDir : this.defaultAccount?.configDir;
    // Compose the FULL child env from the injected seam (this.env), not raw
    // process.env, so introspection and execution resolve the same account. The
    // exec seam treats this as the base and does not merge over process.env.
    const env: Record<string, string | undefined> = { ...this.env };
    if (configDir) env.CODEX_HOME = configDir;

    let res;
    try {
      res = await this.exec({
        cmd: this.binary,
        args,
        cwd: ctx.task.cwd,
        env,
        timeoutMs: ctx.task.timeoutMs,
      });
    } catch (err) {
      // Spawn-level failure (e.g. ENOENT: codex not installed).
      throw new AdapterExecError(`codex failed to start: ${errorMessage(err)}`, VENDOR, {
        stderr: truncate(errorMessage(err), STDERR_CAP),
      });
    }

    const parsed = parseCodexEvents(res.stdout);
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
    if (res.timedOut) {
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
    if (parsed.text === '' && (res.exitCode ?? 0) !== 0) {
      throw new AdapterExecError(`codex exited with code ${res.exitCode}`, VENDOR, {
        ...(typeof res.exitCode === 'number' ? { exitCode: res.exitCode } : {}),
        stderr: truncate(res.stderr, STDERR_CAP),
      });
    }

    if (parsed.text !== '') return finalize('ok');

    // Zero exit, nothing parsed.
    return finalize('incomplete');
  }
}
