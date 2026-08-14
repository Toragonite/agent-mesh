/**
 * ClaudeAdapter — the agent-mesh {@link Adapter} for Anthropic's official `claude` CLI.
 *
 * Drives `claude -p` (one-shot JSON), `claude --resume` (revise a conversation), and
 * `claude -p --output-format stream-json` (incremental events) under the user's own login.
 * Introspection (`authStatus`/`availableModels`/`quota`) reads local state and the absorbed
 * live-usage probe. `steer` reuses the absorbed mesh gateway to wake a peer session by name.
 *
 * Every side-effecting seam — process exec, line streaming, config-file reads, the usage
 * probe, the mesh gateway — is injectable through the constructor so the whole surface is
 * testable with no real CLI, no network, and no real home directory. The defaults are the
 * real implementations.
 *
 * Official CLI only: it shells out to the local `claude` binary and never reads, proxies, or
 * logs credentials. No token or secret value appears in any result, error, note, or `raw`.
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
  type QuotaWindow,
  type ResumeOptions,
  type RunEvent,
  type RunResult,
  type RunTask,
  type TokenUsage,
  type Vendor,
} from '@toragonite/agent-mesh';
import { findSession } from './agents';
import type { ExecFn, ExecRequest, ExecResult, LineStreamFn, StreamEndMeta } from './exec';
import { nodeExec, nodeLineStream } from './exec';
import type { MeshGateway } from './gateway';
import { accountConfigFile } from './protocol';
import { defaultWindowLabel, getLiveUsage, type LiveUsage } from './usage';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const VENDOR: Vendor = 'claude';

/** Max stderr bytes attached to an AdapterExecError, so a failure is diagnosable without a flood. */
const STDERR_CAP = 4_096;

/**
 * Static model matrix (empirically confirmed). No auth-mode gating for Claude Code.
 *
 * No model is marked `default` (A4): `run()` omits `--model` when a task names none, so the CLI
 * picks its own default at runtime. Advertising a `default` here would be a claim the adapter
 * cannot honor without injecting a model — which would change what actually runs.
 */
const MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-8', latencyClass: 'slow' },
  { id: 'claude-sonnet-5', latencyClass: 'fast' },
  { id: 'claude-haiku-4-5', latencyClass: 'fast' },
  { id: 'claude-fable-5', latencyClass: 'slow' },
];

/**
 * True when `model` is in the static catalog, allowing a dated suffix (a catalog id is a prefix
 * of the requested id at a `-` boundary): `'claude-haiku-4-5'` matches `'claude-haiku-4-5-20251001'`.
 * The catalog is partial by design, so an unknown model is annotated (see M12), never blocked.
 */
function isKnownModel(model: string): boolean {
  return MODELS.some((m) => model === m.id || model.startsWith(`${m.id}-`));
}

/** Constructor seams. Each defaults to the real implementation; every one is overridable in tests. */
export interface ClaudeAdapterOptions {
  /** Run-to-completion process seam. Default: {@link nodeExec}. */
  exec?: ExecFn;
  /** Streaming process seam for `stream()`. Default: {@link nodeLineStream}. */
  lineStream?: LineStreamFn;
  /** The claude executable path or command name. Default: `'claude'`. */
  binary?: string;
  /** Account used when a call passes none. Its `configDir` sets `CLAUDE_CONFIG_DIR`. */
  defaultAccount?: Account;
  /** A live mesh gateway; required for `steer()` (peer wake). */
  gateway?: MeshGateway;
  /** Reads a text file, resolving `null` when absent/unreadable. Default: fs read. */
  readTextFile?: (path: string) => Promise<string | null>;
  /** The live-usage probe backing `quota()`. Default: {@link getLiveUsage}. */
  getUsage?: typeof getLiveUsage;
  /**
   * Wall-clock cap for the `quota()` CLI probe. The probe's own 20s default is too tight on a
   * cold CLI boot (observed >20s on a real machine, yielding a permanent `null`). Default: 30000.
   */
  quotaTimeoutMs?: number;
  /**
   * Environment seam for every env read (`ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`) and the base
   * of the child-env override. Default: {@link process.env}. Injecting it keeps introspection and
   * execution resolving the SAME account and lets tests avoid mutating global `process.env`.
   */
  env?: Record<string, string | undefined>;
}

/** True for a plain (non-array, non-null) object — gates every defensive read of parsed output. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Default file reader: resolves the UTF-8 contents, or `null` on any error (missing/unreadable). */
async function defaultReadTextFile(path: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Parse stdout as ONE JSON object, degrading to `undefined` for empty/garbage/non-object output. */
function tryParseResult(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a claude `usage` object to a {@link TokenUsage}. `cachedInputTokens` comes from
 * `cache_read_input_tokens`. Only numeric fields are carried; a shape with none maps to
 * `undefined` so callers never see an empty usage object.
 */
function mapUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const usage: TokenUsage = {};
  if (typeof raw.input_tokens === 'number') {
    usage.inputTokens = raw.input_tokens;
  }
  if (typeof raw.output_tokens === 'number') {
    usage.outputTokens = raw.output_tokens;
  }
  if (typeof raw.cache_read_input_tokens === 'number') {
    usage.cachedInputTokens = raw.cache_read_input_tokens;
  }
  // U3: a vendor-supplied total is used verbatim; otherwise, when BOTH input and output are
  // numbers, the total is their sum; otherwise the field is omitted.
  if (typeof raw.total_tokens === 'number') {
    usage.totalTokens = raw.total_tokens;
  } else if (typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number') {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** A string field off a parsed record, or `undefined` when absent/non-string. */
function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The `args` escape-hatch from `extra`, split into the kept string entries and the count of
 * non-string entries dropped. A non-string can never reach a CLI, so it is filtered out — but the
 * dropped count is surfaced so the caller is never silently ignored (U5).
 */
function partitionExtraArgs(extra: Record<string, unknown> | undefined): {
  args: string[];
  dropped: number;
} {
  const raw = extra?.args;
  if (!Array.isArray(raw)) {
    return { args: [], dropped: 0 };
  }
  const args = raw.filter((a): a is string => typeof a === 'string');
  return { args, dropped: raw.length - args.length };
}

/** The kept string entries of `extra.args`; `[]` when absent or malformed. */
function extraArgs(extra: Record<string, unknown> | undefined): string[] {
  return partitionExtraArgs(extra).args;
}

/** The U5 note for dropped `extra.args` entries, or `undefined` when nothing was dropped. */
function extraArgsNote(extra: Record<string, unknown> | undefined): string | undefined {
  const { dropped } = partitionExtraArgs(extra);
  if (dropped === 0) {
    return undefined;
  }
  return `extra.args contained ${dropped} non-string ${dropped === 1 ? 'entry' : 'entries'}; dropped`;
}

/**
 * The requested model trimmed to its effective value: `undefined` when the model is absent or
 * blank after trimming (U2). An empty optional value means "not requested" — the flag is omitted,
 * no note is added, and nothing is thrown. A non-empty value is passed to the CLI trimmed.
 */
function effectiveModel(model: string | undefined): string | undefined {
  const m = model?.trim();
  return m ? m : undefined;
}

export class ClaudeAdapter implements Adapter {
  readonly vendor: Vendor = VENDOR;
  readonly capabilities: AdapterCapabilities = {
    resume: true,
    steer: 'mid-run',
    peerMesh: true,
    quota: true,
    stream: true,
  };

  private readonly exec: ExecFn;
  private readonly lineStream: LineStreamFn;
  private readonly binary: string;
  private readonly defaultAccount?: Account;
  private readonly gateway?: MeshGateway;
  private readonly readTextFile: (path: string) => Promise<string | null>;
  private readonly getUsage: typeof getLiveUsage;
  private readonly quotaTimeoutMs: number;
  private readonly env: Record<string, string | undefined>;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.exec = opts.exec ?? nodeExec;
    this.lineStream = opts.lineStream ?? nodeLineStream;
    this.binary = opts.binary ?? 'claude';
    this.defaultAccount = opts.defaultAccount;
    this.gateway = opts.gateway;
    this.readTextFile = opts.readTextFile ?? defaultReadTextFile;
    this.getUsage = opts.getUsage ?? getLiveUsage;
    this.quotaTimeoutMs = opts.quotaTimeoutMs ?? 30_000;
    this.env = opts.env ?? process.env;
  }

  /* ----------------------------------------------------------------------- *
   * Introspection
   * ----------------------------------------------------------------------- */

  /**
   * Login state without ever exposing a token. `ANTHROPIC_API_KEY` in the environment reads
   * as an api-key login; otherwise the account's `.claude.json` is read and an `oauthAccount`
   * block reads as a subscription login (with its email as `detail`). Any other case, and any
   * read/parse failure, is a logged-out result. Never throws.
   *
   * Config resolution (H1): an explicit config dir (from the account, else the env seam's
   * `CLAUDE_CONFIG_DIR`) reads `<dir>/.claude.json`; a fully ambient login reads `~/.claude.json`
   * (home root — the real ambient location), NOT `~/.claude/.claude.json`.
   */
  async authStatus(account?: Account): Promise<AuthStatus> {
    if (this.env.ANTHROPIC_API_KEY) {
      return { loggedIn: true, mode: 'api-key' };
    }
    const configDir = this.resolveConfigDir(account);
    const configFile =
      configDir !== undefined
        ? accountConfigFile(configDir)
        : path.join(os.homedir(), '.claude.json');
    const text = await this.readTextFile(configFile);
    if (!text) {
      return { loggedIn: false };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const oauth = isRecord(parsed) ? parsed.oauthAccount : undefined;
      if (isRecord(oauth)) {
        const email = str(oauth, 'emailAddress');
        return email
          ? { loggedIn: true, mode: 'subscription', detail: email }
          : { loggedIn: true, mode: 'subscription' };
      }
    } catch {
      // unparseable config — treat as logged out, never throw
    }
    return { loggedIn: false };
  }

  /** The static model matrix. A fresh array each call so callers cannot mutate the shared list. */
  async availableModels(_account?: Account): Promise<ModelInfo[]> {
    return MODELS.map((m) => ({ ...m }));
  }

  /**
   * A quota snapshot from the absorbed live-usage probe, or `null` when genuinely unknown
   * (probe error, or an account exposing no claude.ai plan limits). Each usage window maps to
   * a {@link QuotaWindow}; `allowed` is true only while every window is under 100% (and true
   * when there are none). NEVER throws for an environmental failure.
   */
  async quota(account?: Account): Promise<QuotaSnapshot | null> {
    // H1: an explicit config dir (account, else env seam) is probed under CLAUDE_CONFIG_DIR; a
    // fully ambient login passes no configDir so the probe inherits the ambient env (see usage.ts).
    // M5: the probe must use the adapter's own binary, not a bare `claude` from PATH.
    const configDir = this.resolveConfigDir(account);
    let usage: LiveUsage;
    try {
      usage = await this.getUsage({
        ...(configDir !== undefined ? { configDir } : {}),
        claudePath: this.binary,
        timeoutMs: this.quotaTimeoutMs,
      });
    } catch {
      return null;
    }
    if (!usage || usage.error !== undefined || !usage.available) {
      return null;
    }
    const windows: QuotaWindow[] = usage.windows.map((w) => ({
      label: defaultWindowLabel(w.kind),
      usedPercent: w.percent,
      ...(w.resetsAt ? { resetAt: w.resetsAt } : {}),
    }));
    return {
      vendor: VENDOR,
      windows,
      allowed: windows.every((w) => w.usedPercent < 100),
      raw: usage,
    };
  }

  /* ----------------------------------------------------------------------- *
   * Worker lifecycle
   * ----------------------------------------------------------------------- */

  /**
   * Start a headless run. The prompt is ALWAYS the final argv element; value flags precede it
   * and `--allowedTools` (variadic) is fenced off from the prompt by the trailing `-p` flag.
   * A blank prompt throws before spawning; a spawn failure or a non-zero exit with no parseable
   * result throws AdapterExecError; a timeout resolves an `incomplete` result (never throws).
   */
  async run(task: RunTask): Promise<RunResult> {
    if (typeof task.prompt !== 'string' || task.prompt.trim() === '') {
      throw new AgentMeshError('claude run requires a non-empty prompt', VENDOR);
    }
    const model = effectiveModel(task.model);
    const args = this.buildArgs(
      {
        model,
        permissionMode: task.permissionMode,
        allowedTools: task.allowedTools,
        extra: task.extra,
      },
      task.prompt,
      'json',
    );
    const result = await this.exec1({
      cmd: this.binary,
      args,
      cwd: task.cwd,
      env: this.configEnv(task.account),
      timeoutMs: task.timeoutMs,
    });
    return this.toRunResult(result, model, task.timeoutMs, extraArgsNote(task.extra));
  }

  /**
   * Continue an existing conversation. Argv leads with `--resume <id>`, then optional model and
   * `extra.args`, and the message as the final positional (fenced behind `--`). A blank id or
   * message throws before spawning; a flag-shaped id (leading `-`, e.g. `--last`) also throws
   * before spawning, so a hostile/corrupted id can never be parsed as a CLI flag and redirect
   * the run to another session (H3). The same result/timeout/failure semantics as {@link run} apply.
   */
  async resume(conversationId: string, message: string, opts?: ResumeOptions): Promise<RunResult> {
    if (typeof conversationId !== 'string') {
      throw new AgentMeshError('claude resume requires a non-empty conversationId', VENDOR);
    }
    // U1: validate the TRIMMED value, and pass that trimmed value to the CLI — never the raw
    // string. So `'  -c  '` is rejected (flag-shaped) and `'  abc-123  '` reaches argv as
    // `'abc-123'`, never with its surrounding spaces intact.
    const id = conversationId.trim();
    if (id === '') {
      throw new AgentMeshError('claude resume requires a non-empty conversationId', VENDOR);
    }
    if (id.startsWith('-')) {
      throw new AgentMeshError(
        'claude resume conversationId must not start with "-" (would parse as a CLI flag)',
        VENDOR,
      );
    }
    if (typeof message !== 'string' || message.trim() === '') {
      throw new AgentMeshError('claude resume requires a non-empty message', VENDOR);
    }
    const model = effectiveModel(opts?.model);
    const args = [
      '--resume',
      id,
      ...(model ? ['--model', model] : []),
      ...extraArgs(opts?.extra),
      '-p',
      '--output-format',
      'json',
      '--',
      message,
    ];
    // U6: ResumeOptions has no `cwd` and core is frozen, so read `opts.extra?.cwd` when it is a
    // string and run the child there; otherwise inherit the process cwd as before.
    const extraCwd = opts?.extra?.cwd;
    const cwd = typeof extraCwd === 'string' ? extraCwd : undefined;
    const result = await this.exec1({
      cmd: this.binary,
      args,
      cwd,
      env: this.configEnv(opts?.account),
      timeoutMs: opts?.timeoutMs,
    });
    return this.toRunResult(result, model, opts?.timeoutMs, extraArgsNote(opts?.extra));
  }

  /**
   * Incremental events for a run over `--output-format stream-json --verbose`. Session id is
   * remembered from init/system events; assistant text blocks become `text` events and
   * `tool_use` blocks become `tool` events; the terminal `result` event emits a `usage` event
   * then a `done` event carrying the mapped {@link RunResult}. Non-JSON lines are skipped.
   *
   * Failure fidelity mirrors {@link run} (M2): if the stream ends with no `result` event, a
   * TIMEOUT emits a `done` with `status:'incomplete'` and a timeout note (never an `error`),
   * carrying the partial text and any session id seen so far; a non-zero EXIT emits an `error`
   * whose message includes the exit code and the child's stderr tail. A spawn-level failure
   * still emits a single `error`.
   *
   * The empty-prompt guard runs EAGERLY at call time (N1): `stream()` is a plain method that
   * validates and then returns the async generator, so a blank prompt throws before spawn —
   * not deferred to the first `next()` as a bare `async *` would.
   */
  stream(task: RunTask): AsyncGenerator<RunEvent> {
    if (typeof task.prompt !== 'string' || task.prompt.trim() === '') {
      throw new AgentMeshError('claude run requires a non-empty prompt', VENDOR);
    }
    return this.streamEvents(task);
  }

  /** The generator behind {@link stream}; the prompt is already validated by the time this runs. */
  private async *streamEvents(task: RunTask): AsyncGenerator<RunEvent> {
    const model = effectiveModel(task.model);
    const modelNote = this.modelNote(model);
    const extraNote = extraArgsNote(task.extra);
    const args = this.buildArgs(
      {
        model,
        permissionMode: task.permissionMode,
        allowedTools: task.allowedTools,
        extra: task.extra,
      },
      task.prompt,
      'stream-json',
    );

    let sessionId = '';
    let seenModel: string | undefined;
    let textSoFar = '';
    let emittedDone = false;
    let endMeta: StreamEndMeta | undefined;
    try {
      for await (const line of this.lineStream(
        {
          cmd: this.binary,
          args,
          cwd: task.cwd,
          env: this.configEnv(task.account),
          timeoutMs: task.timeoutMs,
        },
        (meta) => {
          endMeta = meta;
        },
      )) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue; // stray prose / log line — skip
        }
        if (!isRecord(event)) {
          continue;
        }
        const eventSession = str(event, 'session_id');
        if (eventSession) {
          sessionId = eventSession;
        }
        const eventModel = str(event, 'model');
        if (eventModel) {
          seenModel = eventModel;
        }

        if (event.type === 'assistant') {
          const message = isRecord(event.message) ? event.message : undefined;
          const content = message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (!isRecord(block)) {
                continue;
              }
              if (block.type === 'text' && typeof block.text === 'string') {
                textSoFar += block.text;
                yield { type: 'text', text: block.text };
              } else if (block.type === 'tool_use' && typeof block.name === 'string') {
                yield { type: 'tool', name: block.name, detail: block.input };
              }
            }
          }
        } else if (event.type === 'result') {
          const usage = mapUsage(event.usage);
          if (usage) {
            yield { type: 'usage', usage };
          }
          const note = this.composeNote(modelNote, extraNote);
          const result: RunResult = {
            vendor: VENDOR,
            conversationId: str(event, 'session_id') ?? sessionId,
            text: str(event, 'result') ?? '',
            status: event.is_error === true ? 'error' : 'ok',
            model: model ?? seenModel,
            usage,
            ...(note ? { note } : {}),
            raw: event,
          };
          emittedDone = true;
          yield { type: 'done', result };
        }
      }
    } catch (e) {
      yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      return;
    }
    if (emittedDone) {
      return;
    }
    // Stream ended with no `result` event: mirror run()'s degraded outcomes.
    if (endMeta?.timedOut) {
      const note = this.composeNote(`timed out after ${task.timeoutMs}ms`, modelNote, extraNote);
      yield {
        type: 'done',
        result: {
          vendor: VENDOR,
          conversationId: sessionId,
          text: textSoFar,
          status: 'incomplete',
          ...(note ? { note } : {}),
          model: model ?? seenModel,
        },
      };
      return;
    }
    const code = endMeta?.exitCode;
    const codePart = code !== undefined && code !== null ? ` (exit ${code})` : '';
    const tail = endMeta?.stderrTail?.trim() ? `: ${endMeta.stderrTail.trim()}` : '';
    yield {
      type: 'error',
      message: `claude stream ended without a result event${codePart}${tail}`,
    };
  }

  /**
   * Wake a peer session by its mesh NAME through the absorbed gateway. `conversationId` here is
   * a mesh session name, not a run id — Claude has no conversation-id→socket mapping. Requires
   * a `{ gateway }` to have been supplied to the constructor; otherwise throws.
   */
  async steer(conversationId: string, message: string): Promise<void> {
    if (!this.gateway) {
      throw new AgentMeshError(
        'claude steer requires a MeshGateway: pass { gateway } to ClaudeAdapter',
        VENDOR,
      );
    }
    // Resolve the target by name against the local registry; fall back to the raw name so the
    // gateway can still attempt discovery-by-name when no live entry is found locally.
    const session = findSession(conversationId, this.defaultAccount?.configDir);
    await this.gateway.send({ to: session?.name ?? conversationId, message });
  }

  /* ----------------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------------- */

  /**
   * The config dir this call resolves to, or `undefined` for a fully ambient login. A passed
   * `account` is AUTHORITATIVE (M7/L8): an account object with no `configDir` means AMBIENT and
   * does NOT fall back to `defaultAccount`; only `account === undefined` falls back. With no
   * explicit dir, the env seam's `CLAUDE_CONFIG_DIR` (if set) is treated as explicit (H1 step 2).
   */
  private resolveConfigDir(account?: Account): string | undefined {
    // U4: a null or otherwise non-object account is ABSENT — it falls back to `defaultAccount`,
    // never a raw TypeError. A real account object whose `configDir` is undefined is AMBIENT and
    // does NOT inherit `defaultAccount.configDir` (M7/L8); it falls only to the env seam's dir.
    let explicit: string | undefined;
    if (isRecord(account)) {
      explicit = typeof account.configDir === 'string' ? account.configDir : undefined;
    } else {
      explicit = this.defaultAccount?.configDir;
    }
    return explicit ?? this.env.CLAUDE_CONFIG_DIR;
  }

  /**
   * The FULLY RESOLVED child env for a spawn: the injected `env` seam (default `process.env`) as
   * the base, with `CLAUDE_CONFIG_DIR` overlaid ONLY when this call resolves an explicit config
   * dir. The exec seam treats this as the complete child env (no merge over `process.env`), so an
   * injected `env` genuinely isolates the child and introspection can never resolve a different
   * account than execution. A fully ambient login (no resolved dir) carries no `CLAUDE_CONFIG_DIR`
   * key at all. `this.env` defaults to `process.env`, so a caller who never injects `env` sees the
   * same real-world behavior as before.
   */
  private configEnv(account?: Account): Record<string, string | undefined> {
    const configDir = this.resolveConfigDir(account);
    return { ...this.env, ...(configDir !== undefined ? { CLAUDE_CONFIG_DIR: configDir } : {}) };
  }

  /** The catalog note for a requested model, or `undefined` when the model is known/absent (M12). */
  private modelNote(model: string | undefined): string | undefined {
    return model && !isKnownModel(model) ? `model ${model} not in known catalog` : undefined;
  }

  /** Join the present notes with `'; '`, or `undefined` when there are none. Notes compose (M12). */
  private composeNote(...notes: Array<string | undefined>): string | undefined {
    const kept = notes.filter((n): n is string => n !== undefined && n !== '');
    return kept.length > 0 ? kept.join('; ') : undefined;
  }

  /**
   * Build the argv shared by run/stream. Value flags come first (model, permission mode,
   * allowed tools), then the caller's `extra.args` verbatim, then the output-format tail with
   * the positional (prompt) ALWAYS last, fenced behind a `--` terminator. `stream-json` adds
   * `--verbose`.
   *
   * `--allowedTools` is emitted as ONE comma-joined value (`--allowedTools Read,Edit`), never a
   * variadic list, so a following `extra.args` token can never be swallowed into the tool grant
   * (M6). The `--` before the prompt makes commander treat a flag-shaped prompt (`--help`, `-p`)
   * as the positional, not a flag (H3).
   */
  private buildArgs(
    opts: {
      model?: string;
      permissionMode?: string;
      allowedTools?: string[];
      extra?: Record<string, unknown>;
    },
    positional: string,
    format: 'json' | 'stream-json',
  ): string[] {
    const tail =
      format === 'stream-json'
        ? ['-p', '--output-format', 'stream-json', '--verbose', '--', positional]
        : ['-p', '--output-format', 'json', '--', positional];
    return [
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.permissionMode ? ['--permission-mode', opts.permissionMode] : []),
      ...(opts.allowedTools && opts.allowedTools.length > 0
        ? ['--allowedTools', opts.allowedTools.join(',')]
        : []),
      ...extraArgs(opts.extra),
      ...tail,
    ];
  }

  /** Run the exec seam, converting a spawn-level rejection (ENOENT, spawn throw) to AdapterExecError. */
  private async exec1(req: ExecRequest): Promise<ExecResult> {
    try {
      return await this.exec(req);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new AdapterExecError(`claude failed to spawn: ${message}`, VENDOR, {
        stderr: message.slice(0, STDERR_CAP),
      });
    }
  }

  /**
   * Map a settled {@link ExecResult} to a {@link RunResult}. A timeout resolves an `incomplete`
   * result with a note and best-effort partial fields. A non-zero exit with no parseable result
   * throws AdapterExecError; a zero exit with no parseable result resolves `incomplete`,
   * `text:''`. A parseable result maps `is_error` to status and carries usage + raw.
   */
  private toRunResult(
    result: ExecResult,
    requestedModel: string | undefined,
    timeoutMs: number | undefined,
    extraNote: string | undefined,
  ): RunResult {
    const parsed = tryParseResult(result.stdout);

    const modelNote = this.modelNote(requestedModel);

    if (result.timedOut) {
      return {
        vendor: VENDOR,
        conversationId: parsed ? (str(parsed, 'session_id') ?? '') : '',
        text: parsed ? (str(parsed, 'result') ?? '') : '',
        status: 'incomplete',
        note: this.composeNote(`timed out after ${timeoutMs}ms`, modelNote, extraNote),
        model: requestedModel ?? (parsed ? str(parsed, 'model') : undefined),
        ...(parsed ? { raw: parsed } : {}),
      };
    }

    if (!parsed) {
      if (result.exitCode !== 0) {
        throw new AdapterExecError(
          `claude exited with code ${result.exitCode} and produced no parseable result`,
          VENDOR,
          { exitCode: result.exitCode ?? undefined, stderr: result.stderr.slice(0, STDERR_CAP) },
        );
      }
      return {
        vendor: VENDOR,
        conversationId: '',
        text: '',
        status: 'incomplete',
        note: this.composeNote('claude produced no parseable JSON result', modelNote, extraNote),
      };
    }

    const note = this.composeNote(modelNote, extraNote);
    return {
      vendor: VENDOR,
      conversationId: str(parsed, 'session_id') ?? '',
      text: str(parsed, 'result') ?? '',
      status: parsed.is_error === true ? 'error' : 'ok',
      model: requestedModel ?? str(parsed, 'model'),
      usage: mapUsage(parsed.usage),
      ...(note ? { note } : {}),
      raw: parsed,
    };
  }
}
