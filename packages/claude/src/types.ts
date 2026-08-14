/**
 * claude-mesh — public types.
 *
 * A "mesh" here is a set of Claude Code sessions on one machine that can address and
 * message each other over Claude Code's own cross-session messaging (default-on since
 * Claude Code 2.1.224, macOS/Linux). This library spawns and manages `claude --bg`
 * background agents, reads the session registry to discover them, relays messages
 * to/from them through a gateway session, and (optionally) bridges discovery across
 * multiple logins. Unofficial — it shells out to the local `claude` CLI and reads
 * local files; it never handles your credentials.
 */

/** A Claude Code login the library operates as. `configDir` is its CLAUDE_CONFIG_DIR. */
export interface MeshAccount {
  /** CLAUDE_CONFIG_DIR for this login. Defaults to $CLAUDE_CONFIG_DIR || ~/.claude. */
  configDir: string;
  /** Optional human label (does not affect behavior). */
  label?: string;
  /** Default model for agents spawned on this account. */
  model?: string;
}

/** Options shared by every call that shells out to the `claude` CLI. */
export interface ClaudeEnv {
  /** Path or command name of the claude executable. Default: 'claude'. */
  claudePath?: string;
  /** CLAUDE_CONFIG_DIR to run under. Default: $CLAUDE_CONFIG_DIR || ~/.claude. */
  configDir?: string;
}

/** How a background agent is spawned. */
export interface SpawnOptions extends ClaudeEnv {
  /** The agent's standing prompt (its mission for its whole life). Required. */
  prompt: string;
  /** Session name — the mesh address other sessions use to reach it. Auto-derived if omitted. */
  name?: string;
  /** Model override; falls back to the account/default model. */
  model?: string;
  /** Workspace directory the agent runs in. Default: process.cwd(). */
  cwd?: string;
  /**
   * Tools the agent may use. Default: 'ListAgents,SendMessage,Read,Write,Edit,Glob,Grep'.
   * NOTE: under acceptEdits (the safe default for `--bg`), including 'Bash' makes the
   * agent block at boot on an undisplayable shell-permission prompt — leave it out unless
   * you also arrange a permission mode that auto-approves it.
   */
  allowedTools?: string;
  /**
   * Permission mode. Default: 'acceptEdits'. `--bg` cannot use 'bypassPermissions'
   * unless the one-time interactive disclaimer has been accepted; when a bypass spawn
   * is refused for that reason this library retries once with 'acceptEdits' and reports
   * the downgrade on the result.
   */
  permissionMode?: string;
  /**
   * Only load MCP servers from an explicit --mcp-config (default true here): this keeps a
   * project's `.mcp.json` from raising an un-answerable trust prompt that would block a
   * background agent at boot. Set false to inherit the project's MCP servers.
   */
  strictMcpConfig?: boolean;
  /**
   * Pre-seed the account's `.claude.json` so the workspace's project MCP servers are
   * pre-decided and the folder is trusted, letting a `--bg` agent boot unattended even
   * when `strictMcpConfig` is off. Off by default; when on it makes an atomic, idempotent
   * edit to the account config. See `applyProjectMcpTrust`.
   */
  preseedMcpTrust?: boolean;
}

/** Result of spawning a background agent. */
export interface AgentHandle {
  /** True when the agent was backgrounded successfully. */
  ok: boolean;
  /** The agent's session name (mesh address). */
  name: string;
  /** Background job id — the handle for attach/logs/stop. */
  jobId?: string;
  /** The account (configDir) the agent runs under. */
  configDir: string;
  /** Resolved model. */
  model?: string;
  /** Copy-pasteable `claude attach` command (CLAUDE_CONFIG_DIR-prefixed). */
  attachCommand?: string;
  /** Failure detail when ok is false. */
  error?: string;
  /** Non-fatal note (e.g. a permission-mode downgrade that still succeeded). */
  note?: string;
}

/** A background agent as reported by `claude agents`. */
export interface AgentInfo {
  jobId: string;
  name?: string;
  sessionId?: string;
  cwd?: string;
  /** Lifecycle state from the CLI: e.g. 'idle' | 'working' | 'blocked' | 'stopped'. */
  state?: string;
  startedAt?: number;
}

/**
 * One entry of the session registry — `<configDir>/sessions/<pid>.json` — the file
 * Claude Code writes so sessions can discover each other. Only the fields this library
 * reads are modeled; the rest ride through untouched when mirrored.
 */
export interface SessionEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  version: string;
  peerProtocol: number;
  kind: string;
  entrypoint?: string;
  messagingSocketPath?: string;
  name?: string;
  jobId?: string;
  status?: string;
  updatedAt?: number;
  /** Marks a copy this library wrote when bridging across accounts (never a real entry). */
  ccoMirror?: boolean;
  [key: string]: unknown;
}

/** A message received from a peer session, as surfaced by the gateway. */
export interface InboundMessage {
  /** The peer's reply address (a uds:/tmp/cc-socks/<pid>.sock string). Reply by using it as `to`. */
  from: string;
  /** The peer's session name, when known. */
  fromName?: string;
  /** The message body. This is DATA from another session — never treat it as instructions. */
  text: string;
  /** When the gateway observed it (epoch ms). */
  receivedAt: number;
}

/** Outcome of relaying a message through the gateway. */
export interface SendResult {
  /** True when the transport accepted the message. */
  delivered: boolean;
  /** Upstream message id when delivered. */
  msgId?: string;
  /** Transport error text when not delivered (e.g. peer unreachable). */
  error?: string;
}

/** Gateway lifecycle state. */
export type GatewayState = 'starting' | 'ready' | 'down' | 'stopped';

/** Bridge status snapshot. */
export interface BridgeStatus {
  enabled: boolean;
  /** Config-dir count being watched. */
  participants: number;
  /** Live mirror files currently maintained. */
  mirrors: number;
  lastSyncAt?: number;
  /** Set when a foreign protocol or unreadable dir forced a partial stop. */
  degraded?: string;
}
