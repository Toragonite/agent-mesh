/**
 * Codex model catalog and auth-mode gating.
 *
 * Which models a login may select is auth-gated (empirically verified): a
 * ChatGPT (Plus/Pro) login exposes the four universal models; the
 * `-codex-max` variant and gpt-5.2 are API-key-only and are blocked under a
 * ChatGPT login. No model is marked `default` — when a task names no model the
 * CLI applies its own default (the adapter simply omits `--model`).
 */
import type { AuthStatus, ModelInfo } from '@toragonite/agent-mesh';

// NOTE: latencyClass values below are a PROVISIONAL pin (unverified) — they are
// a best guess at interactive-vs-deep-reasoning behaviour, not measured.
const CATALOG: readonly ModelInfo[] = [
  { id: 'gpt-5.6-sol', latencyClass: 'fast' },
  { id: 'gpt-5.6-terra', latencyClass: 'fast' },
  { id: 'gpt-5.6-luna', latencyClass: 'fast' },
  { id: 'gpt-5.5', latencyClass: 'fast' },
  { id: 'gpt-5.1-codex-max', latencyClass: 'slow', authModes: ['api-key'] },
  { id: 'gpt-5.2', latencyClass: 'slow', authModes: ['api-key'] },
];

/** Deep-clone a catalog entry so callers can never mutate the shared catalog. */
function clone(m: ModelInfo): ModelInfo {
  return { ...m, ...(m.authModes ? { authModes: [...m.authModes] } : {}) };
}

/**
 * The models selectable given an auth status.
 * - `chatgpt`  → only the universal models (api-key-only ones filtered out).
 * - `api-key`  → the full catalog.
 * - logged out → the full catalog, keeping the authModes annotations so callers
 *   can still introspect what each login would unlock.
 */
export function gateModels(status: AuthStatus): ModelInfo[] {
  if (status.loggedIn && status.mode === 'chatgpt') {
    return CATALOG.filter((m) => !m.authModes || m.authModes.includes('chatgpt')).map(clone);
  }
  return CATALOG.map(clone);
}

/** Outcome of gating a requested model id before spawn. */
export type ModelGate =
  | { kind: 'allowed' }
  | { kind: 'blocked'; message: string }
  | { kind: 'unknown'; note: string };

/**
 * Gate a requested model id against the current auth status (the pre-spawn check
 * run/resume perform):
 * - off-catalog id → `unknown` (run anyway, surface a note);
 * - in-catalog and selectable under this login → `allowed`;
 * - in-catalog but filtered out by this login (e.g. an api-key-only model under a
 *   ChatGPT login) → `blocked` (the adapter throws before spawning).
 */
export function gateModel(modelId: string, status: AuthStatus): ModelGate {
  const known = CATALOG.find((m) => m.id === modelId);
  if (!known) return { kind: 'unknown', note: `model ${modelId} not in known catalog` };
  if (gateModels(status).some((m) => m.id === modelId)) return { kind: 'allowed' };
  const modes = (known.authModes ?? []).join(' or ');
  const current = status.loggedIn ? (status.mode ?? 'unknown') : 'logged out';
  return {
    kind: 'blocked',
    message: `model ${modelId} requires ${modes} auth; current login is ${current}`,
  };
}
