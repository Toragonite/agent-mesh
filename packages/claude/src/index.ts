/**
 * @toragonite/agent-mesh-claude — the Claude Code adapter for agent-mesh.
 *
 * Exports {@link ClaudeAdapter} (the vendor-neutral `Adapter` implementation the Fleet drives),
 * the process seams it is built on, the absorbed live claude.ai plan-usage reader, and the
 * absorbed claude-mesh layers — background-agent lifecycle, session discovery, the messaging
 * gateway, and the cross-account bridge — each still usable on its own.
 *
 * Unofficial. Everything here shells out to your local `claude` CLI and reads local files; it
 * never reads, proxies, or logs your credentials.
 */

// The Adapter implementation + its constructor seams.
export { ClaudeAdapter } from './adapter';
export type { ClaudeAdapterOptions } from './adapter';

// Process seams (duplicated-by-design across adapters), plus the 0.1.3 helpers: the
// leader-only interrupt ladder and a run-to-completion over any line seam.
export type {
  ExecRequest,
  ExecResult,
  ExecFn,
  LineStreamFn,
  StreamEndMeta,
  SpawnedProcess,
  InterruptLadderStages,
} from './exec';
export { nodeExec, nodeLineStream, interruptLadder, execOverLineStream } from './exec';

// Live claude.ai plan rate-limit usage reader (absorbed from claude-plan-usage).
export type {
  UsageWindowKind,
  UsageWindow,
  ExtraUsage,
  LiveUsage,
  LiveUsageOptions,
  MergedLiveUsage,
} from './usage';
export {
  parseLiveUsage,
  getLiveUsage,
  getLiveUsageForAccounts,
  mergeStaleWindows,
  defaultConfigDir,
  defaultWindowLabel,
} from './usage';

// ---- Absorbed claude-mesh surface (background agents / gateway / bridge) ----

export type {
  MeshAccount,
  ClaudeEnv,
  SpawnOptions,
  AgentHandle,
  AgentInfo,
  SessionEntry,
  InboundMessage,
  SendResult,
  GatewayState,
  BridgeStatus,
} from './types';

// Background-agent lifecycle + session discovery.
export {
  spawnAgent,
  listAgents,
  stopAgent,
  agentLogs,
  attachCommand,
  preseedProjectMcpTrust,
  listSessions,
  findSession,
  isSessionAlive,
} from './agents';

// Cross-session messaging relay.
export { MeshGateway, createGateway } from './gateway';

// Cross-account discovery bridge.
export { MeshBridge } from './bridge';

// Protocol helpers — for callers building their own coordination on top.
export {
  MESH_MIN_CLAUDE_VERSION,
  MESH_PEER_PROTOCOL,
  MESH_NAME_PREFIX,
  meshPlatformSupported,
  resolveConfigDir,
  sessionsDir,
  accountConfigFile,
  gatewayName,
  agentName,
  workspaceHash,
  parseSessionEntry,
  isPidAlive,
  isMirrorableEntry,
  applyProjectMcpTrust,
  renderInboundMessage,
  validateSendInput,
  newGatewayNonce,
} from './protocol';
