/**
 * Cursor model catalog — parsed LIVE from `cursor-agent models`, with a small
 * curated fallback for offline/failure paths.
 *
 * `cursor-agent models` prints ~193 `id - Display Name` lines under an
 * "Available models" header and a trailing `Tip:` line. Hardcoding that volatile
 * list would be wrong within weeks, so the adapter reads the truth and memoizes
 * it. This module owns only the pure parsing/classification; the adapter owns the
 * subprocess and the memo.
 *
 * Two orthogonal facts are attached to every entry:
 * - a PROVISIONAL latency heuristic (see {@link latencyOf}), and
 * - whether the model is Cursor-native or RESOLD from another vendor. Selecting a
 *   resold model spends that vendor's quota rather than Cursor's, which defeats
 *   the point of a multi-vendor fleet, so resold entries carry a warning label.
 */
import type { LatencyClass, ModelInfo } from '@toragonite/agent-mesh';

/**
 * PROVISIONAL latency heuristic (unmeasured): an id hinting at heavy reasoning
 * — `xhigh`, `high`, `thinking`, `max`, or `opus` — is treated as 'slow';
 * everything else as 'fast'. A best guess, not a measurement.
 */
const SLOW_HINTS = ['xhigh', 'high', 'thinking', 'max', 'opus'] as const;

function latencyOf(id: string): LatencyClass {
  const lower = id.toLowerCase();
  return SLOW_HINTS.some((hint) => lower.includes(hint)) ? 'slow' : 'fast';
}

type ModelKind = 'auto' | 'native' | 'resold';

/**
 * Cursor-native vs resold: `auto`, or an id starting with `composer` or
 * `cursor-`, is native; every other id resells another vendor's model.
 */
function classify(id: string): ModelKind {
  if (id === 'auto') return 'auto';
  if (id.startsWith('composer') || id.startsWith('cursor-')) return 'native';
  return 'resold';
}

const RESOLD_WARNING =
  "resold model — selecting it spends that vendor's quota, not Cursor's, which defeats a multi-vendor fleet";
const AUTO_WARNING =
  "Cursor's automatic router — may itself pick a resold frontier model that spends that vendor's quota";

/** Build a ModelInfo for one id + display name, applying latency, default, and native/resold labelling. */
function buildModelInfo(id: string, displayName: string): ModelInfo {
  const info: ModelInfo = { id, latencyClass: latencyOf(id) };
  const kind = classify(id);
  if (kind === 'auto') {
    // The CLI reports `auto` as the current default; this is the one truthful default.
    info.default = true;
    info.label = displayName ? `${displayName} — ${AUTO_WARNING}` : AUTO_WARNING;
  } else if (kind === 'resold') {
    info.label = displayName ? `${displayName} — ${RESOLD_WARNING}` : RESOLD_WARNING;
  } else if (displayName) {
    // Native, non-auto: the plain display name, unwarned.
    info.label = displayName;
  }
  return info;
}

/**
 * Parse `cursor-agent models` stdout into a ModelInfo[]. Each model line is
 * `id - Display Name` (split on the FIRST ` - `). The "Available models" header,
 * blank lines, and the `Tip:` trailer are skipped; a first token containing
 * whitespace is treated as prose and skipped. Ids are de-duplicated. Never throws.
 */
export function parseModelsOutput(stdout: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (/^available models/i.test(line)) continue;
    if (/^tip:/i.test(line)) continue;
    const idx = line.indexOf(' - ');
    if (idx === -1) continue;
    const id = line.slice(0, idx).trim();
    const displayName = line.slice(idx + 3).trim();
    if (id.length === 0 || /\s/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(buildModelInfo(id, displayName));
  }
  return out;
}

/**
 * A small curated static list used ONLY when the live `models` read fails, so
 * `availableModels()` never throws and routing still works offline. Kept short
 * (four stable, native ids) deliberately: the live catalog is 193 volatile
 * entries, this is the durable core. Contrast the gemini adapter, whose catalog
 * is static because its vendor's list is small and stable.
 */
const CURATED_IDS = ['auto', 'composer-2.5', 'cursor-grok-4.5-high', 'cursor-grok-4.5-high-fast'];

export function curatedModels(): ModelInfo[] {
  return CURATED_IDS.map((id) => buildModelInfo(id, ''));
}

/** A shallow copy so callers can never mutate a memoized/curated entry. */
export function cloneModel(m: ModelInfo): ModelInfo {
  return { ...m, ...(m.authModes ? { authModes: [...m.authModes] } : {}) };
}
