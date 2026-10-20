/**
 * agent-mesh core data contract.
 *
 * These types are the frozen wire between the Fleet orchestrator and every
 * vendor adapter. They encode the shape empirically verified across four
 * headless coding agents (Claude Code, Codex, Antigravity/Gemini, Cursor):
 * each exposes `-p`/JSON one-shot runs, resume-by-conversation-id, token
 * usage, a reverse-engineered quota endpoint, auth-mode-gated model lists,
 * and an observable latency class.
 *
 * An adapter that satisfies this contract is drivable by the Fleet without
 * the Fleet knowing anything vendor-specific.
 */

/**
 * A supported agent vendor. Kept as an open union: the four names get
 * autocomplete, but `(string & {})` lets third-party adapters register any
 * vendor id without a core release.
 */
export type Vendor = 'claude' | 'codex' | 'gemini' | 'cursor' | (string & {});

/** Observed responsiveness of a model. 'fast' ~ interactive; 'slow' ~ deep reasoning. */
export type LatencyClass = 'fast' | 'slow';

/** How a vendor accepts guidance after a run has started. */
export type SteerMode =
  /** Inject while the agent is actively working (Claude peer-wake; Codex app-server turn/steer). */
  | 'mid-run'
  /** Only between turns, via resume(conversationId, message). */
  | 'turn'
  /** No post-start guidance; the run is atomic. */
  | 'none';

/**
 * A login/identity for one vendor. Adapters resolve credentials from
 * `configDir` (an isolated home such as CLAUDE_CONFIG_DIR / CODEX_HOME) or,
 * when omitted, from the ambient CLI login on the machine.
 */
export interface Account {
  vendor: Vendor;
  /** Opaque human label ("work", "personal"). */
  label?: string;
  /** Isolated config/home dir for this login. Omit to use the ambient CLI login. */
  configDir?: string;
}

/** What an adapter can do beyond the mandatory run/resume/quota surface. */
export interface AdapterCapabilities {
  /** Can revise an existing conversation by id. Nearly universal; false only for one-shot vendors. */
  resume: boolean;
  /** How mid-conversation guidance is accepted. */
  steer: SteerMode;
  /** Native peer-to-peer session messaging (Claude mesh only, today). */
  peerMesh: boolean;
  /** quota() can return a usable snapshot for this vendor. */
  quota: boolean;
  /** stream() yields incremental events. */
  stream: boolean;
}

export interface AuthStatus {
  loggedIn: boolean;
  /** Vendor-specific auth mode: 'subscription' | 'api-key' | 'chatgpt' | ... */
  mode?: string;
  /** Account label / email / detail if resolvable. MUST NEVER contain a token or secret. */
  detail?: string;
}

export interface ModelInfo {
  id: string;
  /** Human label if distinct from id. */
  label?: string;
  latencyClass: LatencyClass;
  /**
   * Auth modes under which this model is selectable. Codex is the live
   * example: chatgpt-login exposes gpt-5.6-sol/terra/luna, while
   * -codex-max variants are api-key-only. Omit = available under any login.
   */
  authModes?: string[];
  /** True for the adapter's default pick when a task names no model. */
  default?: boolean;
  /**
   * Reasoning-effort levels the vendor's own model list says this model accepts
   * (e.g. 'low', 'medium', 'high'), in the vendor's order. Omit = not reported —
   * NOT "none accepted". Additive: adapters that never report it are unaffected.
   */
  efforts?: string[];
}

export interface QuotaWindow {
  /** Rolling-window label: "5h", "weekly", "primary", ... */
  label: string;
  /** 0..100. Percentage of the window already consumed. */
  usedPercent: number;
  /** ISO 8601 instant when this window resets, if the vendor reports it. */
  resetAt?: string;
}

export interface QuotaSnapshot {
  vendor: Vendor;
  windows: QuotaWindow[];
  /** Whether the vendor currently permits new work (the rate-limit gate). */
  allowed: boolean;
  /** ISO 8601 capture time. Stamped by the caller — core has no clock. */
  capturedAt?: string;
  /** Raw vendor payload for debugging. Shape is vendor-specific and unstable. */
  raw?: unknown;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Cached-input tokens if the vendor reports them separately. */
  cachedInputTokens?: number;
}

export type RunStatus =
  /** Completed normally. */
  | 'ok'
  /** The adapter/agent reported a failure. */
  | 'error'
  /** Externally stopped via stop(). */
  | 'stopped'
  /** Ended without a final answer (timeout, truncation, permission wall). */
  | 'incomplete';

export interface RunTask {
  prompt: string;
  /** Model id; omit to use the adapter default. Adapters validate against availableModels(). */
  model?: string;
  /** Working directory for the agent process. */
  cwd?: string;
  /** Account override; omit = adapter default account. */
  account?: Account;
  /** Vendor permission mode passthrough (e.g. 'acceptEdits'); adapters map to their CLI flag. */
  permissionMode?: string;
  /** Tool allow-list if the vendor supports one. */
  allowedTools?: string[];
  /** Hard wall-clock cap in milliseconds. */
  timeoutMs?: number;
  /** Escape hatch for vendor-specific args the contract does not model. */
  extra?: Record<string, unknown>;

  /* --- Since 0.1.3: the turn lane (headless turns that resume one conversation). All optional. --- */

  /**
   * Continue this conversation instead of starting one — honoured by `run()` AND `stream()`
   * with the vendor's own resume argv. `model` and `permissionMode` are passed again on a
   * resumed run; Codex REFUSES a resumed run without `model`. A blank or `-`-leading id throws
   * before anything is spawned. Cursor and Antigravity silently start a NEW conversation for an
   * id they do not know: compare this id with the `session` event the run reports.
   */
  resumeId?: string;
  /**
   * Start the conversation under this id where the CLI can (Claude `--session-id`, a UUID).
   * Elsewhere ignored with a note. Mutually exclusive with `resumeId` (both → throws).
   */
  sessionId?: string;
  /**
   * Absolute path of a system-prompt file to append. Claude: `--append-system-prompt-file`, on
   * every run, resumed or not. The other CLIs have no such flag: the adapter prefixes the file's
   * CONTENT to this run's prompt and notes it.
   */
  appendSystemPromptFile?: string;
  /** Nobody can answer a permission prompt (Claude: `--permission-prompts none`); the others ignore it. */
  unattended?: boolean;
  /** One stdio MCP server attached to THIS run only, wired the vendor's own way (see {@link McpAttachment}). */
  mcp?: McpAttachment;
  /** Claude only: tools to forbid (`--disallowedTools a,b`). Elsewhere ignored with a note. */
  disallowedTools?: string[];
  /** Claude only: the `--setting-sources` value (e.g. `'user,project'`). Elsewhere ignored with a note. */
  settingSources?: string;
  /**
   * Cursor: add `--force`; Antigravity: add `--dangerously-skip-permissions`. Never added unless
   * this is `true`. Claude and Codex have no equivalent (ignored with a note).
   */
  elevated?: boolean;
}

/**
 * One stdio MCP server attached to a single run (since 0.1.3). The shape is the same for every
 * vendor; each adapter wires it the vendor's own way — Claude `--mcp-config <files> --strict-mcp-config`,
 * Codex `-c mcp_servers.<name>.…` overrides, Cursor `--approve-mcps` over the `.cursor/mcp.json` the
 * caller wrote in the run's cwd, Antigravity the `.agents/mcp_config.json` the caller wrote there.
 * The adapters never write a file.
 */
export interface McpAttachment {
  /** The server's name: `/^[a-z][a-z0-9_]{0,31}$/`. It becomes part of tool names and config keys. */
  name: string;
  /** The stdio server's executable. */
  command: string;
  /**
   * Its arguments. Give the server its identity HERE: Codex starts an MCP server with a filtered
   * environment, so variables exported to the CLI do not reach it.
   */
  args: string[];
  /** Absolute path of a Claude-style `{"mcpServers":{"<name>":{"command":…,"args":[…]}}}` file the caller wrote. */
  configFile: string;
  /** Claude only: the project's own `.mcp.json`, passed BEFORE `configFile` so the project's servers are kept. */
  projectConfigFile?: string;
}

/**
 * A process an adapter asks a spawn seam to start (since 0.1.3). No shell is involved; `env`,
 * when present, IS the child's whole environment (keys whose value is `undefined` are dropped).
 * Each adapter package exports its own, structurally compatible `ExecRequest`.
 */
export interface SpawnRequest {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  stdin?: string;
}

/** What a {@link LineStreamFn} reports once, after the child's last stdout line (since 0.1.3). */
export interface StreamEndMeta {
  /** The seam's wall-clock cap tripped and the child was killed. */
  timedOut: boolean;
  /** The exit code, or `null` on a signal death / failed spawn. */
  exitCode: number | null;
  /** The last few KiB of the child's stderr. */
  stderrTail: string;
}

/**
 * A line-streaming spawn seam (since 0.1.3): yields the child's stdout one line at a time and
 * calls `onEnd` exactly once after the last line. Throws when the child cannot be started.
 */
export type LineStreamFn = (
  req: SpawnRequest,
  onEnd?: (meta: StreamEndMeta) => void,
) => AsyncIterable<string>;

/** Per-call options for `run()` / `stream()` (since 0.1.3). All optional. */
export interface RunOptions {
  /**
   * The spawn seam for THIS run: every process the run starts goes through it (`stream()` reads
   * its lines; `run()` drains them into one stdout). Overrides the adapter's own seams.
   */
  lineStream?: LineStreamFn;
  /**
   * The COMPLETE child environment, as the caller composed it. Used as is: the adapter's own
   * `env` seam is not merged under it, so a variable the caller removed stays removed, and the
   * adapter adds no account variable of its own (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `AGY_HOME`).
   */
  env?: Record<string, string | undefined>;
  /**
   * The caller has already checked the account: skip the adapter's own account introspection
   * before the spawn (Codex: the model-versus-login gate, which reads the login state).
   */
  skipAuthCheck?: boolean;
}

/**
 * How to open the vendor's INTERACTIVE terminal UI on an existing conversation (since 0.1.3) —
 * what a host runs in a PTY to hand a headless conversation to a person.
 */
export interface InteractiveResumeSpec {
  /** The executable (the adapter's configured binary). */
  command: string;
  args: string[];
  /** Variables to SET for the account (its config-dir binding). */
  env: Record<string, string>;
  /** Variables that must be ABSENT from the terminal's environment (a default config dir is expressed by unsetting it). */
  unsetEnv?: string[];
  /** True only when this exact take-over has been verified against the real CLI. */
  verified: boolean;
}

/**
 * Since 0.1.4. One MCP server's connection state as the vendor's own stream reported it at the
 * start of a run (Claude Code's `system/init` → `mcp_servers[]`). `status` is the vendor's word,
 * verbatim but trimmed — e.g. `connected`, `failed`, `needs-auth`, `pending` — so a consumer must
 * treat an unknown value as "not known to be connected".
 */
export interface McpServerStatus {
  /** The server's configured name (trimmed, at most 200 characters). */
  name: string;
  /** The vendor's status word (trimmed, at most 200 characters). */
  status: string;
}

export interface RunResult {
  vendor: Vendor;
  /**
   * Conversation/session id to feed resume(). Empty string ONLY when the
   * vendor genuinely returned none — callers must treat '' as "not resumable".
   */
  conversationId: string;
  /** Final assistant text. */
  text: string;
  status: RunStatus;
  /** The model that actually ran (may differ from the request if the vendor remapped it). */
  model?: string;
  usage?: TokenUsage;
  /** Non-fatal note surfaced to the operator, e.g. "permission downgraded to acceptEdits". */
  note?: string;
  /** Raw final vendor event/payload for debugging. */
  raw?: unknown;
  /**
   * Since 0.1.4, on a streamed run's `done` result. The MCP servers' status from the run's
   * session-start event (Claude Code's `system/init` `mcp_servers`, at most 64 entries). Absent
   * when the vendor reported none or a malformed list; `[]` when it reported an empty one.
   */
  mcpServers?: ReadonlyArray<McpServerStatus>;
}

export interface ResumeOptions {
  model?: string;
  timeoutMs?: number;
  account?: Account;
  extra?: Record<string, unknown>;
}

/**
 * Incremental event from an adapter's optional stream(). A stream ends with exactly one `done`
 * or `error`; nothing follows it.
 */
export type RunEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; detail?: unknown }
  | { type: 'usage'; usage: TokenUsage }
  /**
   * Since 0.1.3. The conversation id AS THE VENDOR'S OWN STREAM REPORTED IT (Claude `session_id`,
   * Codex `thread.started`'s `thread_id`, Cursor `session_id`, Antigravity `init`'s
   * `conversation_id`) — never synthesized from `sessionId` or `resumeId`. Emitted when the stream
   * first reports an id, and again only if it later reports a different one. A resumed run whose
   * `session` id differs from its `resumeId` continued in a NEW conversation.
   *
   * Since 0.1.4, `mcpServers`: the MCP servers' status when the line that reports the id is the
   * vendor's session-start event and carries a well-formed list (Claude Code's `system/init`
   * `mcp_servers`). Absent otherwise — the `done` result carries it too, so a list whose init line
   * did not open the session (an earlier line already reported the id) is not lost.
   */
  | { type: 'session'; conversationId: string; mcpServers?: ReadonlyArray<McpServerStatus> }
  | { type: 'done'; result: RunResult }
  | { type: 'error'; message: string };
