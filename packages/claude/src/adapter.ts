/**
 * ClaudeAdapter — the agent-mesh {@link Adapter} for Anthropic's official `claude` CLI.
 *
 * Drives `claude -p` (one-shot JSON), `claude --resume` (revise a conversation), and
 * `claude -p --output-format stream-json` (incremental events) under the user's own login.
 * Introspection (`authStatus`/`availableModels`/`quota`) reads local state and the absorbed
 * live-usage probe. `steer` reuses the absorbed mesh gateway to wake a peer session by name.
 *
 * Since 0.1.3, `run()` and `stream()` also drive the turn lane: a task may start a conversation
 * under a chosen id (`sessionId` → `--session-id`) or continue one (`resumeId` → `--resume`),
 * append a system-prompt file, attach one MCP server for the run, forbid tools, and run with
 * nobody to answer a permission prompt. `stream()` reports the CLI's own session id as a
 * `session` event, and `interactiveResume()` returns the terminal command that hands a
 * conversation to a person.
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
  type InteractiveResumeSpec,
  type McpAttachment,
  type McpServerStatus,
  type ModelInfo,
  type QuotaSnapshot,
  type QuotaWindow,
  type ResumeOptions,
  type RunEvent,
  type RunOptions,
  type RunResult,
  type RunTask,
  type TokenUsage,
  type Vendor,
} from '@toragonite/agent-mesh';
import { findSession } from './agents';
import type { ExecFn, ExecRequest, ExecResult, LineStreamFn, StreamEndMeta } from './exec';
import { execOverLineStream, nodeExec, nodeLineStream } from './exec';
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

/** `McpAttachment.name`: a lowercase identifier — it becomes part of tool names (`mcp__<name>__<tool>`). */
const MCP_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** A UUID, which `--session-id` requires (any case; passed through as given, trimmed). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** C0 control characters and DEL — never part of a path or a value handed to the CLI. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The note for an explicit account whose config dir `options.env` displaces. */
const ENV_ACCOUNT_NOTE = 'account.configDir not applied: options.env is the complete child environment';

/**
 * Whether the take-over command of {@link ClaudeAdapter.interactiveResume} has been verified
 * against the real CLI (a person continues the conversation in `claude --resume <id>`, and the
 * next headless `--resume` sees that person's turn). Not yet: it is reported as unverified.
 */
const INTERACTIVE_RESUME_VERIFIED = false;

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

/** At most this many `mcp_servers` entries are kept (and checked) from a `system/init` line. */
export const MAX_INIT_MCP_SERVERS = 64;
/** A kept `mcp_servers` name/status is trimmed and cut to this many characters (code points). */
export const MAX_INIT_MCP_FIELD_CHARS = 200;

/** Trimmed and cut to {@link MAX_INIT_MCP_FIELD_CHARS} code points; `undefined` when not a non-blank string. */
function initMcpField(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const chars = Array.from(trimmed);
  return chars.length > MAX_INIT_MCP_FIELD_CHARS ? chars.slice(0, MAX_INIT_MCP_FIELD_CHARS).join('').trimEnd() : trimmed;
}

/**
 * The `mcp_servers` of a stream-json `{"type":"system","subtype":"init"}` line (since 0.1.4), or
 * `undefined`. Accepted ONLY as an array whose kept entries — the first
 * {@link MAX_INIT_MCP_SERVERS}; the rest are dropped unchecked — are all objects with a non-blank
 * string `name` and `status` (trimmed, cut to {@link MAX_INIT_MCP_FIELD_CHARS}; other keys ignored).
 * Anything else (not an array, a non-object entry, a missing/blank/non-string name or status)
 * yields `undefined`: a partly-read list would misreport which servers exist. `[]` stays `[]`.
 * Returns fresh objects; never throws.
 */
export function parseInitMcpServers(event: unknown): McpServerStatus[] | undefined {
  try {
    if (!isRecord(event) || event.type !== 'system' || event.subtype !== 'init') {
      return undefined;
    }
    const list = event.mcp_servers;
    if (!Array.isArray(list)) {
      return undefined;
    }
    const out: McpServerStatus[] = [];
    const n = Math.min(list.length, MAX_INIT_MCP_SERVERS);
    for (let i = 0; i < n; i++) {
      const entry: unknown = list[i];
      if (!isRecord(entry)) {
        return undefined;
      }
      const name = initMcpField(entry.name);
      const status = initMcpField(entry.status);
      if (name === undefined || status === undefined) {
        return undefined;
      }
      out.push({ name, status });
    }
    return out;
  } catch {
    return undefined; // a hostile getter/proxy can never break the stream
  }
}

/** A fresh copy of a parsed list, so no two consumers share (or can corrupt) one array. */
function copyMcpServers(list: readonly McpServerStatus[]): McpServerStatus[] {
  return list.map((s) => ({ name: s.name, status: s.status }));
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

/* ------------------------------------------------------------------------- *
 * The turn-lane fields of a task (0.1.3) — validated BEFORE anything spawns.
 * ------------------------------------------------------------------------- */

/** The 0.1.3 turn-lane fields of a task, validated and normalized. */
interface TurnFields {
  resumeId?: string;
  sessionId?: string;
  appendSystemPromptFile?: string;
  unattended: boolean;
  mcp?: McpAttachment;
  disallowedTools: string[];
  settingSources?: string;
  /** Notes for fields this adapter dropped or ignored. */
  notes: string[];
}

/** A conversation id field: trimmed; blank or `-`-leading throws. `undefined` stays absent. */
function conversationIdField(raw: unknown, field: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (id === '') {
    throw new AgentMeshError(`claude ${field} must be a non-empty conversation id`, VENDOR);
  }
  if (id.startsWith('-')) {
    throw new AgentMeshError(`claude ${field} must not start with "-" (would parse as a CLI flag)`, VENDOR);
  }
  return id;
}

/** An absolute-path field (no control characters). `undefined` stays absent; anything else throws. */
function absolutePathField(raw: unknown, field: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string' || !path.isAbsolute(raw) || CONTROL_CHARS.test(raw)) {
    throw new AgentMeshError(`claude ${field} must be an absolute path`, VENDOR);
  }
  return raw;
}

/** Validate an {@link McpAttachment}: every field is checked by value; a bad one throws. */
function mcpField(raw: unknown): McpAttachment {
  if (!isRecord(raw)) {
    throw new AgentMeshError('claude mcp must be an object { name, command, args, configFile }', VENDOR);
  }
  const { name, command, args } = raw;
  if (typeof name !== 'string' || !MCP_NAME.test(name)) {
    throw new AgentMeshError('claude mcp.name must match /^[a-z][a-z0-9_]{0,31}$/', VENDOR);
  }
  if (typeof command !== 'string' || command.trim() === '' || CONTROL_CHARS.test(command)) {
    throw new AgentMeshError('claude mcp.command must be a non-empty string without control characters', VENDOR);
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string' && !CONTROL_CHARS.test(a))) {
    throw new AgentMeshError('claude mcp.args must be an array of strings without control characters', VENDOR);
  }
  const configFile = absolutePathField(raw.configFile, 'mcp.configFile');
  if (configFile === undefined) {
    throw new AgentMeshError('claude mcp.configFile must be an absolute path', VENDOR);
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

/** A tool-name list: must be an array; non-string or blank entries are dropped and counted. */
function toolListField(raw: unknown, field: string): { tools: string[]; dropped: number } {
  if (raw === undefined) {
    return { tools: [], dropped: 0 };
  }
  if (!Array.isArray(raw)) {
    throw new AgentMeshError(`claude ${field} must be an array of tool names`, VENDOR);
  }
  const tools = raw
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .map((t) => t.trim());
  return { tools, dropped: raw.length - tools.length };
}

/** `settingSources`: blank is absent (U2); a flag-shaped or non-string value throws. */
function settingSourcesField(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new AgentMeshError('claude settingSources must be a string such as "user,project"', VENDOR);
  }
  const value = raw.trim();
  if (value === '') {
    return undefined;
  }
  if (value.startsWith('-') || CONTROL_CHARS.test(value)) {
    throw new AgentMeshError('claude settingSources must be a value such as "user,project", not a flag', VENDOR);
  }
  return value;
}

/** Validate every turn-lane field of `task`. Throws AgentMeshError on the first invalid one. */
function turnFields(task: RunTask): TurnFields {
  const notes: string[] = [];
  const resumeId = conversationIdField(task.resumeId, 'resumeId');
  let sessionId: string | undefined;
  if (task.sessionId !== undefined) {
    const candidate = typeof task.sessionId === 'string' ? task.sessionId.trim() : '';
    if (!UUID.test(candidate)) {
      throw new AgentMeshError('claude sessionId must be a UUID (claude --session-id takes one)', VENDOR);
    }
    sessionId = candidate;
  }
  if (resumeId !== undefined && sessionId !== undefined) {
    throw new AgentMeshError(
      'claude sessionId and resumeId are mutually exclusive: sessionId starts a conversation, resumeId continues one',
      VENDOR,
    );
  }
  const appendSystemPromptFile = absolutePathField(task.appendSystemPromptFile, 'appendSystemPromptFile');
  const mcp = task.mcp === undefined ? undefined : mcpField(task.mcp);
  const { tools: disallowedTools, dropped } = toolListField(task.disallowedTools, 'disallowedTools');
  if (dropped > 0) {
    notes.push(`disallowedTools contained ${dropped} non-string or blank ${dropped === 1 ? 'entry' : 'entries'}; dropped`);
  }
  const settingSources = settingSourcesField(task.settingSources);
  if (task.elevated === true) {
    notes.push('elevated has no claude equivalent; ignored');
  }
  return {
    ...(resumeId !== undefined ? { resumeId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(appendSystemPromptFile !== undefined ? { appendSystemPromptFile } : {}),
    unattended: task.unattended === true,
    ...(mcp !== undefined ? { mcp } : {}),
    disallowedTools,
    ...(settingSources !== undefined ? { settingSources } : {}),
    notes,
  };
}

/** Lexically, do two directory strings name the same directory? No filesystem access. */
function sameDir(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
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
   *
   * Since 0.1.3: `task.resumeId` continues a conversation (`--resume <id>` with every other flag
   * passed again), `task.sessionId` starts one under a chosen UUID, and the other turn-lane
   * fields map as {@link stream} documents. `opts.lineStream` (when given) is the only seam the
   * run spawns through; `opts.env` (when given) is the child's whole environment.
   */
  async run(task: RunTask, opts?: RunOptions): Promise<RunResult> {
    if (typeof task.prompt !== 'string' || task.prompt.trim() === '') {
      throw new AgentMeshError('claude run requires a non-empty prompt', VENDOR);
    }
    const turn = turnFields(task);
    const model = effectiveModel(task.model);
    const args = this.buildArgs(
      {
        model,
        permissionMode: task.permissionMode,
        allowedTools: task.allowedTools,
        extra: task.extra,
        turn,
      },
      task.prompt,
      'json',
    );
    const { env, note: envNote } = this.childEnv(task.account, opts);
    const result = await this.exec1(
      {
        cmd: this.binary,
        args,
        cwd: task.cwd,
        env,
        timeoutMs: task.timeoutMs,
      },
      opts,
    );
    return this.toRunResult(
      result,
      model,
      task.timeoutMs,
      this.composeNote(extraArgsNote(task.extra), ...turn.notes, envNote),
    );
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
   * Incremental events for a run over `--output-format stream-json --verbose`. Assistant text
   * blocks become `text` events and `tool_use` blocks become `tool` events; the terminal
   * `result` event emits a `usage` event then a `done` event carrying the mapped
   * {@link RunResult}. Non-JSON lines are skipped. The stream ends with exactly one `done` or
   * `error`: lines after the terminal `result` are drained but emit nothing.
   *
   * Session (since 0.1.3): the first line that carries a `session_id` (normally `system/init`)
   * emits a `session` event with that id — the CLI's own report, never `task.sessionId` or
   * `task.resumeId` echoed back — and a later line with a DIFFERENT id emits another.
   *
   * MCP status (since 0.1.4): the first `system/init` line's `mcp_servers` (see
   * {@link parseInitMcpServers}) rides on the `session` event that line emits, and on the `done`
   * result (`RunResult.mcpServers`) — also when an earlier line had already reported the session.
   * A missing or malformed list leaves both absent; it never fails the run.
   *
   * Turn lane (since 0.1.3), in argv order: `resumeId` → `--resume <id>`, `sessionId` →
   * `--session-id <uuid>`, `model` → `--model`, `permissionMode` → `--permission-mode` (on every
   * run, resumed or not), `unattended` → `--permission-prompts none`, `settingSources` →
   * `--setting-sources <v>`, `appendSystemPromptFile` → `--append-system-prompt-file <path>`,
   * `mcp` → `--mcp-config [<projectConfigFile>] <configFile> --strict-mcp-config`, `allowedTools`
   * → `--allowedTools a,b`, `disallowedTools` → `--disallowedTools a,b`, then `extra.args`, then
   * `-p --output-format stream-json --verbose -- <prompt>`. Measured on Claude Code 2.1.299.
   *
   * Failure fidelity mirrors {@link run} (M2): if the stream ends with no `result` event, a
   * TIMEOUT emits a `done` with `status:'incomplete'` and a timeout note (never an `error`),
   * carrying the partial text and any session id seen so far; a non-zero EXIT emits an `error`
   * whose message includes the exit code and the child's stderr tail. A spawn-level failure
   * still emits a single `error`.
   *
   * Validation runs EAGERLY at call time (N1): `stream()` is a plain method that validates and
   * then returns the async generator, so a blank prompt or an invalid turn-lane field throws
   * before spawn — not deferred to the first `next()` as a bare `async *` would.
   */
  stream(task: RunTask, opts?: RunOptions): AsyncGenerator<RunEvent> {
    if (typeof task.prompt !== 'string' || task.prompt.trim() === '') {
      throw new AgentMeshError('claude run requires a non-empty prompt', VENDOR);
    }
    const turn = turnFields(task);
    return this.streamEvents(task, turn, opts);
  }

  /** The generator behind {@link stream}; the task is already validated by the time this runs. */
  private async *streamEvents(task: RunTask, turn: TurnFields, opts?: RunOptions): AsyncGenerator<RunEvent> {
    const model = effectiveModel(task.model);
    const modelNote = this.modelNote(model);
    const { env, note: envNote } = this.childEnv(task.account, opts);
    const extraNote = this.composeNote(extraArgsNote(task.extra), ...turn.notes, envNote);
    const args = this.buildArgs(
      {
        model,
        permissionMode: task.permissionMode,
        allowedTools: task.allowedTools,
        extra: task.extra,
        turn,
      },
      task.prompt,
      'stream-json',
    );
    // A per-run seam (RunOptions.lineStream) is the ONLY seam this run spawns through.
    const lineStream: LineStreamFn = opts?.lineStream ?? this.lineStream;

    let sessionId = '';
    let reportedSession = '';
    let seenModel: string | undefined;
    // The first well-formed `system/init` `mcp_servers` of this run (since 0.1.4).
    let mcpServers: McpServerStatus[] | undefined;
    let textSoFar = '';
    let emittedDone = false;
    let endMeta: StreamEndMeta | undefined;
    try {
      for await (const line of lineStream(
        {
          cmd: this.binary,
          args,
          cwd: task.cwd,
          env,
          timeoutMs: task.timeoutMs,
        },
        (meta) => {
          endMeta = meta;
        },
      )) {
        if (emittedDone) {
          continue; // drain: nothing follows the terminal event
        }
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
        const initServers = mcpServers === undefined ? parseInitMcpServers(event) : undefined;
        if (initServers !== undefined) {
          mcpServers = initServers;
        }
        const eventSession = str(event, 'session_id');
        if (eventSession) {
          sessionId = eventSession;
          if (eventSession !== reportedSession) {
            reportedSession = eventSession;
            yield initServers !== undefined
              ? { type: 'session', conversationId: eventSession, mcpServers: copyMcpServers(initServers) }
              : { type: 'session', conversationId: eventSession };
          }
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
            ...(mcpServers !== undefined ? { mcpServers: copyMcpServers(mcpServers) } : {}),
          };
          emittedDone = true;
          yield { type: 'done', result };
        }
      }
    } catch (e) {
      if (!emittedDone) {
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      }
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
          ...(mcpServers !== undefined ? { mcpServers: copyMcpServers(mcpServers) } : {}),
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
   * The command that opens Claude Code's INTERACTIVE terminal on `conversationId` — what a host
   * runs in a PTY to hand a headless conversation to a person: `claude --resume <id>`. Nothing is
   * spawned. `env` / `unsetEnv` carry the account's config-dir binding: the host's own
   * `CLAUDE_CONFIG_DIR` string when the account IS the host's directory; otherwise the default
   * directory (`~/.claude`) is expressed by UNSETTING `CLAUDE_CONFIG_DIR` — an explicit default
   * path makes the CLI read a different credential and look logged out — and any other directory
   * is set verbatim. A fully ambient account unsets it too. `verified` is `false`: this take-over
   * has not been verified against the real CLI yet. A blank or `-`-leading id throws.
   */
  interactiveResume(conversationId: string, account?: Account): InteractiveResumeSpec {
    const id = typeof conversationId === 'string' ? conversationId.trim() : '';
    if (id === '') {
      throw new AgentMeshError('claude interactiveResume requires a non-empty conversationId', VENDOR);
    }
    if (id.startsWith('-')) {
      throw new AgentMeshError(
        'claude interactiveResume conversationId must not start with "-" (would parse as a CLI flag)',
        VENDOR,
      );
    }
    const binding = this.configDirBinding(account);
    return {
      command: this.binary,
      args: ['--resume', id],
      env: binding.set !== undefined ? { CLAUDE_CONFIG_DIR: binding.set } : {},
      unsetEnv: binding.set !== undefined ? [] : ['CLAUDE_CONFIG_DIR'],
      verified: INTERACTIVE_RESUME_VERIFIED,
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
   * How `CLAUDE_CONFIG_DIR` must be presented to a terminal that should run as the account:
   * `{ set }` to export exactly that string, `{}` (no `set`) for "must be absent". Rules, in order:
   * the host's own non-blank `CLAUDE_CONFIG_DIR` naming the same directory → that string,
   * untouched; no directory at all (ambient) or the default `~/.claude` → absent; anything else →
   * the directory verbatim. Directories are compared lexically (`path.resolve`).
   */
  private configDirBinding(account?: Account): { set?: string } {
    const hostRaw = this.env.CLAUDE_CONFIG_DIR;
    const host = typeof hostRaw === 'string' && hostRaw.trim() !== '' ? hostRaw : undefined;
    let dir: string | undefined;
    if (isRecord(account)) {
      dir = typeof account.configDir === 'string' && account.configDir.trim() !== '' ? account.configDir : undefined;
    } else {
      const fallback = this.defaultAccount?.configDir;
      dir = typeof fallback === 'string' && fallback.trim() !== '' ? fallback : undefined;
    }
    dir = dir ?? host;
    if (dir === undefined) {
      return {};
    }
    if (host !== undefined && sameDir(host, dir)) {
      return { set: host };
    }
    if (sameDir(dir, path.join(os.homedir(), '.claude'))) {
      return {};
    }
    return { set: dir };
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

  /**
   * The child env for a run()/stream() call. With `opts.env` (0.1.3) the caller's env is used
   * VERBATIM — a copy, with no `CLAUDE_CONFIG_DIR` of the adapter's own and no fallback to the env
   * seam's or the default account's directory (the caller composed the account's binding,
   * including an UNSET variable for the default directory). An explicit `account.configDir` it
   * displaces is noted. Without `opts.env`, {@link configEnv} applies exactly as before.
   */
  private childEnv(
    account: Account | undefined,
    opts: RunOptions | undefined,
  ): { env: Record<string, string | undefined>; note?: string } {
    if (opts?.env) {
      const explicit = isRecord(account) && typeof account.configDir === 'string' && account.configDir !== '';
      return { env: { ...opts.env }, ...(explicit ? { note: ENV_ACCOUNT_NOTE } : {}) };
    }
    return { env: this.configEnv(account) };
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
   * Build the argv shared by run/stream. Conversation flags lead (`--resume` / `--session-id`),
   * then value flags (model, permission mode, the turn-lane flags, allowed and disallowed tools),
   * then the caller's `extra.args` verbatim, then the output-format tail with the positional
   * (prompt) ALWAYS last, fenced behind a `--` terminator. `stream-json` adds `--verbose`. With
   * no turn-lane field set, the argv is exactly what 0.1.2 produced.
   *
   * `--allowedTools` / `--disallowedTools` are emitted as ONE comma-joined value each
   * (`--allowedTools Read,Edit`), never a variadic list, so a following `extra.args` token can
   * never be swallowed into the tool grant (M6). `--mcp-config` is variadic too; the files are
   * closed by `--strict-mcp-config` right after them. The `--` before the prompt makes commander
   * treat a flag-shaped prompt (`--help`, `-p`) as the positional, not a flag (H3).
   */
  private buildArgs(
    opts: {
      model?: string;
      permissionMode?: string;
      allowedTools?: string[];
      extra?: Record<string, unknown>;
      turn: TurnFields;
    },
    positional: string,
    format: 'json' | 'stream-json',
  ): string[] {
    const turn = opts.turn;
    const tail =
      format === 'stream-json'
        ? ['-p', '--output-format', 'stream-json', '--verbose', '--', positional]
        : ['-p', '--output-format', 'json', '--', positional];
    return [
      ...(turn.resumeId ? ['--resume', turn.resumeId] : []),
      ...(turn.sessionId ? ['--session-id', turn.sessionId] : []),
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.permissionMode ? ['--permission-mode', opts.permissionMode] : []),
      ...(turn.unattended ? ['--permission-prompts', 'none'] : []),
      ...(turn.settingSources ? ['--setting-sources', turn.settingSources] : []),
      ...(turn.appendSystemPromptFile ? ['--append-system-prompt-file', turn.appendSystemPromptFile] : []),
      ...(turn.mcp
        ? [
            '--mcp-config',
            ...(turn.mcp.projectConfigFile ? [turn.mcp.projectConfigFile] : []),
            turn.mcp.configFile,
            '--strict-mcp-config',
          ]
        : []),
      ...(opts.allowedTools && opts.allowedTools.length > 0
        ? ['--allowedTools', opts.allowedTools.join(',')]
        : []),
      ...(turn.disallowedTools.length > 0 ? ['--disallowedTools', turn.disallowedTools.join(',')] : []),
      ...extraArgs(opts.extra),
      ...tail,
    ];
  }

  /**
   * Run the exec seam — or, when `opts.lineStream` is given, that per-run seam (drained to
   * completion) — converting a spawn-level rejection (ENOENT, spawn throw) to AdapterExecError.
   */
  private async exec1(req: ExecRequest, opts?: RunOptions): Promise<ExecResult> {
    try {
      return opts?.lineStream ? await execOverLineStream(opts.lineStream, req) : await this.exec(req);
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
