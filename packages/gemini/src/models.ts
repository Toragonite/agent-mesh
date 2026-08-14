/**
 * Antigravity model catalog and the live-model probe.
 *
 * Two paths, by design:
 * - {@link STATIC_MODELS} / the adapter's `availableModels()` — a FAST, static
 *   catalog captured live, spawning nothing. `Fleet.route()` calls availableModels
 *   on the routing hot path, so it must not shell out.
 * - {@link fetchLiveModels} — the AUTHORITATIVE but SLOW path: it runs `agy models`
 *   and parses its output. Any failure resolves to `[]`; it never throws.
 *
 * There is no auth-mode gating for Antigravity: every catalog entry is selectable
 * under a single Google login. No entry is marked `default` — when a task names no
 * model the adapter omits `--model` and the CLI applies its own default, so
 * claiming a default here would be false.
 */
import type { LatencyClass, ModelInfo } from '@toragonite/agent-mesh';
import { nodeExec, type ExecFn } from './exec.js';

/**
 * Latency heuristic. NOTE: PROVISIONAL — these classes are a best guess at
 * interactive-vs-deep-reasoning behaviour, not measured. `pro`, `opus`, and
 * `thinking` ids read as deep-reasoning ('slow'); everything else as 'fast'. This
 * exactly reproduces the static catalog's classes and is reused for live results.
 */
export function latencyOf(id: string): LatencyClass {
  const s = id.toLowerCase();
  return s.includes('pro') || s.includes('opus') || s.includes('thinking') ? 'slow' : 'fast';
}

/**
 * The static, captured-live catalog (11 entries). The three RESOLD models are
 * selectable through `agy` but bill another vendor's quota — routing another
 * vendor's quota through the Gemini adapter defeats the purpose of a multi-vendor
 * fleet, so each carries that warning in its label. latencyClass values are the
 * PROVISIONAL pin described on {@link latencyOf}.
 */
export const STATIC_MODELS: readonly ModelInfo[] = [
  { id: 'gemini-3.6-flash-high', latencyClass: 'fast' },
  { id: 'gemini-3.6-flash-medium', latencyClass: 'fast' },
  { id: 'gemini-3.6-flash-low', latencyClass: 'fast' },
  { id: 'gemini-3.5-flash-high', latencyClass: 'fast' },
  { id: 'gemini-3.5-flash-medium', latencyClass: 'fast' },
  { id: 'gemini-3.5-flash-low', latencyClass: 'fast' },
  { id: 'gemini-3.1-pro-high', latencyClass: 'slow' },
  { id: 'gemini-3.1-pro-low', latencyClass: 'slow' },
  {
    id: 'claude-sonnet-4-6',
    label: "Claude Sonnet 4.6 (resold — selecting it spends Anthropic quota, not Gemini's)",
    latencyClass: 'fast',
  },
  {
    id: 'claude-opus-4-6-thinking',
    label: "Claude Opus 4.6 Thinking (resold — selecting it spends Anthropic quota, not Gemini's)",
    latencyClass: 'slow',
  },
  {
    id: 'gpt-oss-120b-medium',
    label: "GPT-OSS 120B (resold — selecting it spends the provider's quota, not Gemini's)",
    latencyClass: 'fast',
  },
];

/** Deep-clone a catalog entry so a caller can never mutate the shared catalog. */
function cloneModel(m: ModelInfo): ModelInfo {
  return { ...m };
}

/** The static catalog as a fresh, caller-owned array. */
export function staticModels(): ModelInfo[] {
  return STATIC_MODELS.map(cloneModel);
}

/** True when `id` is one of the statically known catalog ids. */
export function isKnownModel(id: string): boolean {
  return STATIC_MODELS.some((m) => m.id === id);
}

/**
 * Parse `agy models` output. Each model is a TAB-separated `id<TAB>label` line;
 * the leading `Fetching available models...` chatter line and any line without a
 * TAB are skipped. The label is optional (omitted when blank). Never throws.
 */
export function parseModelsOutput(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue; // skips the "Fetching available models..." line and blanks
    const id = line.slice(0, tab).trim();
    if (id.length === 0) continue;
    const label = line.slice(tab + 1).trim();
    const entry: ModelInfo = { id, latencyClass: latencyOf(id) };
    if (label.length > 0) entry.label = label;
    models.push(entry);
  }
  return models;
}

/** Options for {@link fetchLiveModels}. */
export interface FetchLiveModelsOptions {
  /** Process-exec seam. Defaults to a real child_process spawner. */
  exec?: ExecFn;
  /** CLI binary name/path. Defaults to `agy`. */
  binary?: string;
  /** Wall-clock cap for the `agy models` probe. */
  timeoutMs?: number;
}

/**
 * The authoritative-but-slow model list: run `agy models` and parse it. This is the
 * counterpart to the adapter's fast, static `availableModels()`. Any failure — spawn
 * error, non-zero exit, timeout, unparseable output — resolves to `[]`; never throws.
 */
export async function fetchLiveModels(opts: FetchLiveModelsOptions = {}): Promise<ModelInfo[]> {
  const exec = opts.exec ?? nodeExec;
  const binary = opts.binary ?? 'agy';
  try {
    const res = await exec({ cmd: binary, args: ['models'], timeoutMs: opts.timeoutMs });
    if (res.timedOut) return [];
    return parseModelsOutput(res.stdout);
  } catch {
    return [];
  }
}
