/**
 * Tolerant parser for `cursor-agent --output-format json` (and the terminal
 * `result` event of `--output-format stream-json`).
 *
 * `cursor-agent` does not guarantee stdout is a single JSON document — banners,
 * progress lines, or log noise can be interleaved — so the parser scans line by
 * line and keeps the LAST line that parses as a JSON OBJECT, ignoring arrays,
 * scalars, and non-JSON. Nothing here throws; garbage stdout yields `undefined`.
 *
 * The result mapper is shared by `run()`, `resume()`, and the stream's `result`
 * event so all three produce identical RunResult fields from the same payload.
 * Cursor's usage keys are camelCase (`inputTokens`, `cacheReadTokens`) — unlike
 * every other vendor in this repo — and the vendor supplies no total, so
 * `totalTokens` is derived from input+output; a vendor-supplied total, if one
 * ever appears, wins verbatim (U3).
 */
import type { RunStatus, TokenUsage } from '@toragonite/agent-mesh';

/** True for a plain object (not an array, not null) — gates every defensive read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number off `x`, or undefined. */
function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

/** A string field off a parsed record, or undefined when absent/non-string. */
export function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Keep the LAST line of `stdout` that parses as a JSON object. Blank lines,
 * non-JSON prose, and JSON arrays/scalars are skipped. Returns `undefined` when
 * no line parses to an object.
 */
export function parseCursorJson(stdout: string): Record<string, unknown> | undefined {
  let last: Record<string, unknown> | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // tolerate interleaved banners / progress / log noise
    }
    if (isRecord(parsed)) last = parsed;
  }
  return last;
}

/**
 * Map a cursor-agent `usage` object to {@link TokenUsage}. Cursor's keys are
 * camelCase; `cachedInputTokens` comes from `cacheReadTokens`. One rule governs
 * `totalTokens` (U3): a vendor-supplied `totalTokens` is used VERBATIM; otherwise,
 * when BOTH input and output are numbers, it is derived (input+output) — this
 * vendor supplies no total, so that is the live path; otherwise it is omitted.
 * `cacheWriteTokens` has no contract field and survives only in `raw`. Returns
 * `undefined` when the shape carries no recognized numeric field.
 */
export function mapUsage(u: unknown): TokenUsage | undefined {
  if (!isRecord(u)) return undefined;
  const inputTokens = num(u.inputTokens);
  const outputTokens = num(u.outputTokens);
  const cachedInputTokens = num(u.cacheReadTokens);
  const suppliedTotal = num(u.totalTokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    suppliedTotal === undefined
  ) {
    return undefined;
  }
  const usage: TokenUsage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (suppliedTotal !== undefined) {
    usage.totalTokens = suppliedTotal;
  } else if (inputTokens !== undefined && outputTokens !== undefined) {
    usage.totalTokens = inputTokens + outputTokens;
  }
  return usage;
}

/** The vendor-neutral fields a result payload maps to; assembled into a RunResult by the adapter. */
export interface MappedResult {
  /** `session_id` when a non-empty string, else ''. */
  conversationId: string;
  /** `result` when a string, else ''. */
  text: string;
  status: RunStatus;
  usage?: TokenUsage;
  /** The parsed payload object (for RunResult.raw). */
  raw: Record<string, unknown>;
}

/**
 * Derive the run status from a result payload:
 * - `is_error === true` → 'error';
 * - a `subtype` that is present and not 'success' → 'error';
 * - a non-empty `result` text → 'ok';
 * - otherwise → 'incomplete'.
 */
function computeStatus(payload: Record<string, unknown>, text: string): RunStatus {
  if (payload.is_error === true) return 'error';
  const subtype = payload.subtype;
  if (typeof subtype === 'string' && subtype !== 'success') return 'error';
  if (text.length > 0) return 'ok';
  return 'incomplete';
}

/** The single result mapper used by run(), resume(), and the stream's `result` event. */
export function mapResultPayload(payload: Record<string, unknown>): MappedResult {
  const sessionId = str(payload, 'session_id');
  const conversationId = sessionId && sessionId.length > 0 ? sessionId : '';
  const text = str(payload, 'result') ?? '';
  const mapped: MappedResult = {
    conversationId,
    text,
    status: computeStatus(payload, text),
    raw: payload,
  };
  const usage = mapUsage(payload.usage);
  if (usage) mapped.usage = usage;
  return mapped;
}
