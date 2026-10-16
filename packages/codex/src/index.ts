/**
 * @toragonite/agent-mesh-codex — the Codex (OpenAI) adapter.
 *
 * Drives the official `codex` CLI headlessly behind the agent-mesh `Adapter`
 * contract: one-shot runs, resume-by-id, auth-gated model introspection (the CLI's
 * own live list via `codex app-server`, with a static fallback), and a user-runtime
 * quota read. Unofficial.
 */
export { CodexAdapter, type CodexAdapterOptions } from './adapter.js';
export { fetchLiveModels, type FetchLiveModelsOptions, STATIC_MODELS } from './models.js';
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
