/**
 * @toragonite/agent-mesh-codex — the Codex (OpenAI) adapter.
 *
 * Drives the official `codex` CLI headlessly behind the agent-mesh `Adapter`
 * contract: one-shot runs, resume-by-id, auth-gated model introspection, and a
 * user-runtime quota read. Unofficial.
 */
export { CodexAdapter, type CodexAdapterOptions } from './adapter.js';
// Process seams (duplicated-by-design across adapters). `nodeLineStream` is exported
// for parity with the streaming adapters even though codex exposes no stream().
export {
  nodeExec,
  nodeLineStream,
  type ExecFn,
  type ExecRequest,
  type ExecResult,
  type LineStreamFn,
  type StreamEndMeta,
} from './exec.js';
