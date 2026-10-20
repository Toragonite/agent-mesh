/**
 * @toragonite/agent-mesh-codex — the Codex (OpenAI) adapter.
 *
 * Drives the official `codex` CLI headlessly behind the agent-mesh `Adapter`
 * contract: one-shot runs, resume-by-id, incremental streaming over `codex exec
 * --json` (since 0.1.3), auth-gated model introspection (the CLI's own live list via
 * `codex app-server`, with a static fallback), and a user-runtime quota read. Unofficial.
 */
export { CodexAdapter, type CodexAdapterOptions } from './adapter.js';
export { fetchLiveModels, type FetchLiveModelsOptions, STATIC_MODELS } from './models.js';
// The `codex app-server` spawn seam (since 0.1.4): `CodexAdapterOptions.spawn` / `FetchLiveModelsOptions.spawn`.
export type { SpawnFn, SpawnedChild } from './app-server.js';
// Process seams (duplicated-by-design across adapters), plus the 0.1.3 helpers: the
// leader-only interrupt ladder and a run-to-completion over any line seam.
export {
  nodeExec,
  nodeLineStream,
  interruptLadder,
  execOverLineStream,
  type ExecFn,
  type ExecRequest,
  type ExecResult,
  type LineStreamFn,
  type StreamEndMeta,
  type SpawnedProcess,
  type InterruptLadderStages,
} from './exec.js';
