/**
 * @toragonite/agent-mesh-gemini — the Google Antigravity adapter.
 *
 * Drives the official `agy` CLI headlessly behind the agent-mesh `Adapter`
 * contract: one-shot runs, resume-by-id, incremental streaming, a fast static
 * model catalog (plus a slow authoritative live probe), and an `agy models`-based
 * auth check. Antigravity exposes no verified quota endpoint, so `quota()` is
 * `null` by design. Unofficial.
 */
export { GeminiAdapter, type GeminiAdapterOptions } from './adapter.js';
export {
  fetchLiveModels,
  type FetchLiveModelsOptions,
  STATIC_MODELS,
  parseModelsOutput,
} from './models.js';
export {
  nodeExec,
  nodeLineStream,
  type ExecFn,
  type ExecRequest,
  type ExecResult,
  type LineStreamFn,
  type StreamEndMeta,
} from './exec.js';
