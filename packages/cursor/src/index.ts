/**
 * @toragonite/agent-mesh-cursor — the Cursor adapter.
 *
 * Drives Cursor's official `cursor-agent` CLI headlessly behind the agent-mesh
 * `Adapter` contract: one-shot runs, resume-by-id, incremental streaming, a
 * live-and-memoized model catalog, CLI-backed auth introspection, and a
 * user-runtime quota read of the current billing period. Unofficial.
 */
export { CursorAdapter, createChat, type CursorAdapterOptions, type CreateChatOptions } from './adapter.js';
// Process seams, plus the 0.1.3 helpers: the leader-only interrupt ladder and a
// run-to-completion over any line seam.
export { nodeExec, nodeLineStream, interruptLadder, execOverLineStream } from './exec.js';
export type {
  ExecFn,
  ExecRequest,
  ExecResult,
  LineStreamFn,
  StreamEndMeta,
  SpawnedProcess,
  InterruptLadderStages,
} from './exec.js';
