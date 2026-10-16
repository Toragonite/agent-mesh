/**
 * @toragonite/agent-mesh-gemini — the Google Antigravity adapter.
 *
 * Drives the official `agy` CLI headlessly behind the agent-mesh `Adapter`
 * contract: one-shot runs, resume-by-id, incremental streaming, a fast static
 * model catalog (plus a slow authoritative live probe), an `agy models`-based
 * auth check, and a `quota()` read from agy's own `/usage` command
 * (`agy -p /usage --output-format json` — no agent turn, no quota spent). Unofficial.
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
