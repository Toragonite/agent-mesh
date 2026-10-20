/**
 * Codex model catalog, auth-mode gating, and the live model list.
 *
 * Two sources:
 * - {@link fetchLiveModels} asks the CLI itself (`codex app-server`, `model/list`)
 *   for the models the signed-in account can pick — the authoritative list. Any
 *   failure resolves to `[]`; it never throws.
 * - {@link STATIC_MODELS}, the fallback when the CLI cannot answer: the list
 *   `codex app-server` returned on 2026-10-14 (codex-cli 0.162.1), its default
 *   marked, plus the API-key-only variants.
 *
 * Which models a login may select is auth-gated (empirically verified): a
 * ChatGPT (Plus/Pro) login exposes the universal models; the `-codex-max`
 * variant and gpt-5.2 are API-key-only and are blocked under a ChatGPT login.
 * The same gate applies to a live list (an id the static catalog marks
 * API-key-only keeps that mark). When a task names no model the adapter omits
 * `--model` and the CLI applies its own default.
 */
import type { AuthStatus, LatencyClass, ModelInfo } from '@toragonite/agent-mesh';
import { listAppServerModels, type SpawnFn } from './app-server.js';
import { resolveCodexHome } from './auth.js';
import { PACKAGE_VERSION } from './version.js';

// NOTE: latencyClass values below are a PROVISIONAL pin (unverified) — they are
// a best guess at interactive-vs-deep-reasoning behaviour, not measured.
export const STATIC_MODELS: readonly ModelInfo[] = [
  { id: 'gpt-6.1-sol', latencyClass: 'fast', default: true },
  { id: 'gpt-6-astra', latencyClass: 'fast' },
  { id: 'gpt-6-sol', latencyClass: 'fast' },
  { id: 'gpt-6-luna', latencyClass: 'fast' },
  { id: 'gpt-5.6-sol', latencyClass: 'fast' },
  { id: 'gpt-5.6-terra', latencyClass: 'fast' },
  { id: 'gpt-5.6-luna', latencyClass: 'fast' },
  { id: 'gpt-5.1-codex-max', latencyClass: 'slow', authModes: ['api-key'] },
  { id: 'gpt-5.2', latencyClass: 'slow', authModes: ['api-key'] },
];
const CATALOG = STATIC_MODELS;

/** latencyClass for a live entry the static catalog does not know (provisional, like the table). */
const NEUTRAL_LATENCY: LatencyClass = 'fast';

/** Deep-clone a catalog entry so callers can never mutate the shared catalog. */
export function cloneModel(m: ModelInfo): ModelInfo {
  return {
    ...m,
    ...(m.authModes ? { authModes: [...m.authModes] } : {}),
    ...(m.efforts ? { efforts: [...m.efforts] } : {}),
  };
}
const clone = cloneModel;

/**
 * Filter a model list by an auth status, cloning every entry.
 * - `chatgpt`  → only entries with no `authModes` or one naming `chatgpt`.
 * - `api-key`  → everything.
 * - logged out → everything, keeping the authModes annotations so callers can
 *   still introspect what each login would unlock.
 */
export function gateList(models: readonly ModelInfo[], status: AuthStatus): ModelInfo[] {
  if (status.loggedIn && status.mode === 'chatgpt') {
    return models.filter((m) => !m.authModes || m.authModes.includes('chatgpt')).map(clone);
  }
  return models.map(clone);
}

/** The static catalog gated by an auth status (see {@link gateList}). */
export function gateModels(status: AuthStatus): ModelInfo[] {
  return gateList(CATALOG, status);
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

/**
 * The catalog half of {@link gateModel}, with no login read: the "not in known catalog" note for
 * an off-catalog id, else `undefined`. Used when the caller has already checked the account
 * (`RunOptions.skipAuthCheck`), so the login-dependent `blocked` verdict is not computed.
 */
export function catalogNote(modelId: string): string | undefined {
  return CATALOG.some((m) => m.id === modelId) ? undefined : `model ${modelId} not in known catalog`;
}

/* ------------------------------------------------------------------------- *
 * The live list — `codex app-server` `model/list`
 * ------------------------------------------------------------------------- */

/** Default deadline for the whole app-server session (answer AND self-exit), in ms. */
export const DEFAULT_LIVE_MODELS_TIMEOUT_MS = 15_000;

/** At most this many models are taken from one listing. */
const MAX_LIVE_MODELS = 512;
/** Model ids and effort names longer than this are not ids. */
const MAX_ID_CHARS = 256;
/** A display name is cut to this length. */
const MAX_LABEL_CHARS = 120;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** A trimmed, single-token string (no whitespace, no control characters), or undefined. */
function idValue(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined;
  const s = x.trim();
  if (s === '' || s.length > MAX_ID_CHARS || /[\s\u0000-\u001f\u007f]/.test(s)) return undefined;
  return s;
}

/** A display name as one line — whitespace runs collapsed, control characters dropped, cut — or undefined. */
function labelValue(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined;
  const s = x.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s === '' ? undefined : s.slice(0, MAX_LABEL_CHARS);
}

/**
 * One `model/list` `data` entry → ModelInfo, or undefined when it carries no usable id.
 * `{ id, displayName, isDefault, supportedReasoningEfforts: [{ reasoningEffort }] }` →
 * `{ id, label (only when it differs from the id), default (only when true), efforts
 * (only when any), latencyClass and authModes from the static catalog (else a neutral
 * provisional class) }`.
 */
function toModelInfo(entry: unknown): ModelInfo | undefined {
  if (!isRecord(entry)) return undefined;
  const id = idValue(entry.id);
  if (!id) return undefined;
  const known = CATALOG.find((m) => m.id === id);
  const info: ModelInfo = { id, latencyClass: known?.latencyClass ?? NEUTRAL_LATENCY };
  const label = labelValue(entry.displayName);
  if (label && label !== id) info.label = label;
  if (known?.authModes) info.authModes = [...known.authModes];
  if (entry.isDefault === true) info.default = true;
  if (Array.isArray(entry.supportedReasoningEfforts)) {
    const efforts: string[] = [];
    for (const e of entry.supportedReasoningEfforts) {
      const effort = isRecord(e) ? idValue(e.reasoningEffort) : undefined;
      if (effort && !efforts.includes(effort)) efforts.push(effort);
    }
    if (efforts.length > 0) info.efforts = efforts;
  }
  return info;
}

/**
 * Map the raw `data` entries of every page to ModelInfo: unusable entries are skipped,
 * a repeated id keeps its first entry, only the FIRST `isDefault` entry stays the
 * default (a list has one default pick), and at most {@link MAX_LIVE_MODELS} are kept.
 */
export function mapLiveModels(entries: readonly unknown[]): ModelInfo[] {
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  let haveDefault = false;
  for (const entry of entries) {
    if (out.length >= MAX_LIVE_MODELS) break;
    const info = toModelInfo(entry);
    if (!info || seen.has(info.id)) continue;
    seen.add(info.id);
    if (info.default) {
      if (haveDefault) delete info.default;
      haveDefault = true;
    }
    out.push(info);
  }
  return out;
}

/** True for an environment variable that belongs to Anthropic's tooling, never passed to codex. */
function isAnthropicVar(key: string): boolean {
  const k = key.toUpperCase();
  return k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_') || k === 'CLAUDECODE';
}

/**
 * The app-server's env: the base env WITHOUT any Anthropic / Claude Code variable
 * (an API key or session marker of another vendor has no business in codex's
 * process), with `CODEX_HOME` set to the account's home.
 */
export function appServerEnv(
  base: Record<string, string | undefined>,
  codexHome: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!isAnthropicVar(key)) env[key] = value;
  }
  env.CODEX_HOME = codexHome;
  return env;
}

/** Options for {@link fetchLiveModels}. */
export interface FetchLiveModelsOptions {
  /** CLI binary name/path. Defaults to `codex`. */
  binary?: string;
  /** `CODEX_HOME` for the app-server. Defaults to `env.CODEX_HOME`, else `~/.codex`. */
  codexHome?: string;
  /**
   * Base environment for the app-server (defaults to `process.env`). It IS the child
   * env, minus every `ANTHROPIC_*` / `CLAUDE_*` / `CLAUDECODE` variable, with
   * `CODEX_HOME` set.
   */
  env?: Record<string, string | undefined>;
  /**
   * Deadline for the whole session in ms (default 15000): the app-server must answer
   * AND exit by itself on stdin close within it, or its process group is killed.
   */
  timeoutMs?: number;
  /**
   * Spawn seam (since 0.1.4), the shape of `child_process.spawn` — which is the default. Called
   * once as `spawn(binary, ['app-server'], options)`. With the default a failure or the deadline
   * kills the app-server's whole process group; with an injected spawner only the child it
   * returned is killed (`child.kill('SIGKILL')`).
   */
  spawn?: SpawnFn;
}

/**
 * The models the signed-in account can pick, as the CLI itself lists them: one
 * `codex app-server` session (`initialize` → `initialized` → `model/list`, following
 * `nextCursor` for at most 10 pages), ended by closing its stdin. NOT auth-gated —
 * the adapter's `availableModels()` applies the gate. Any failure — spawn error,
 * JSON-RPC error, a malformed line, an early or non-zero exit, the deadline, or a
 * listing with no usable entry — resolves to `[]`, with nothing left running; never
 * throws.
 */
export async function fetchLiveModels(opts: FetchLiveModelsOptions = {}): Promise<ModelInfo[]> {
  try {
    const base = opts.env ?? process.env;
    const codexHome = opts.codexHome ?? resolveCodexHome(undefined, undefined, base);
    const timeoutMs =
      typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : DEFAULT_LIVE_MODELS_TIMEOUT_MS;
    const entries = await listAppServerModels({
      cmd: opts.binary ?? 'codex',
      env: appServerEnv(base, codexHome),
      timeoutMs,
      clientVersion: PACKAGE_VERSION,
      ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
    });
    return entries ? mapLiveModels(entries) : [];
  } catch {
    return [];
  }
}
