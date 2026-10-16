/**
 * @toragonite/agent-mesh-cursor — the Cursor adapter.
 *
 * Drives Cursor's official `cursor-agent` CLI headlessly behind the agent-mesh
 * `Adapter` contract: one-shot runs, resume-by-id, incremental streaming, a
 * live-and-memoized model catalog, CLI-backed auth introspection, and a
 * user-runtime quota read of the current billing period. Unofficial.
 */
export { CursorAdapter, createChat, type CursorAdapterOptions, type CreateChatOptions } from './adapter.js';
export { nodeExec, nodeLineStream } from './exec.js';
export type {
  ExecFn,
  ExecRequest,
  ExecResult,
  LineStreamFn,
  StreamEndMeta,
} from './exec.js';
