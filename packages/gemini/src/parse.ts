/**
 * Tolerant parser + the single result mapper for the Antigravity `agy` CLI.
 *
 * The CLI's `--output-format json` prints ONE JSON object (sometimes preceded by
 * progress chatter), and `--output-format stream-json` prints one JSON object per
 * line whose terminal `result` event carries the SAME payload shape as the
 * non-stream output. So there is exactly one payload→RunResult mapper here
 * ({@link mapPayload}), shared by run(), resume(), and the stream's `result`
 * event. Nothing in this module throws; malformed input degrades to empty values.
 */
import type { RunStatus, TokenUsage } from '@toragonite/agent-mesh';

/** True for a plain object (excludes arrays and null) — gates every defensive read. */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Scan stdout line by line and return the LAST line that parses as a JSON object.
 * Non-JSON lines (progress banners, log noise) and JSON that is an array/scalar are
 * ignored — the CLI is not guaranteed to emit a single clean JSON document.
 */
export function pickLastJsonObject(stdout: string): Record<string, unknown> | undefined {
  let last: Record<string, unknown> | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // tolerate interleaved non-JSON chatter
    }
    if (isRecord(parsed)) last = parsed;
  }
  return last;
}

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

/**
 * Remove exactly ONE trailing newline (`\r\n` or `\n`) from the vendor's answer.
 * `agy` terminates its printed answer with a newline the other agent-mesh vendors
 * do not emit; stripping one keeps text cross-vendor comparable. Interior newlines
 * and a second trailing newline are preserved — only one terminator is removed.
 */
function stripOneTrailingNewline(s: string): string {
  if (s.endsWith('\r\n')) return s.slice(0, -2);
  if (s.endsWith('\n')) return s.slice(0, -1);
  return s;
}

/** `conversation_id` when it is a non-empty string, else '' — never fabricated. */
export function extractConversationId(payload: Record<string, unknown>): string {
  const id = payload.conversation_id;
  return typeof id === 'string' && id.length > 0 ? id : '';
}

/** `response` when a string (with one trailing newline stripped), else ''. */
export function extractText(payload: Record<string, unknown>): string {
  const r = payload.response;
  return typeof r === 'string' ? stripOneTrailingNewline(r) : '';
}

/**
 * Map the vendor `usage` object to a {@link TokenUsage}. `cachedInputTokens` comes
 * from `cache_read_tokens`; `totalTokens` is the vendor-supplied `total_tokens` when
 * present (used verbatim, never recomputed), and OTHERWISE the sum of `inputTokens`
 * and `outputTokens` when BOTH are numbers — else omitted. `thinking_tokens` has no
 * contract field and survives only in `raw`. A usage object carrying none of the
 * recognized numeric fields maps to undefined so callers never see an empty object.
 */
export function mapUsage(payload: Record<string, unknown>): TokenUsage | undefined {
  const u = payload.usage;
  if (!isRecord(u)) return undefined;
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  const cachedInputTokens = num(u.cache_read_tokens);
  const totalTokens = num(u.total_tokens);
  const usage: TokenUsage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  else if (inputTokens !== undefined && outputTokens !== undefined) {
    usage.totalTokens = inputTokens + outputTokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** The vendor `error` message when it is a non-empty string, else undefined. */
export function extractErrorNote(payload: Record<string, unknown>): string | undefined {
  const e = payload.error;
  return typeof e === 'string' && e.length > 0 ? e : undefined;
}

/**
 * Derive the run status from the payload:
 * - a `status` of 'SUCCESS' → 'ok';
 * - a `status` that is present (a non-empty string) and not 'SUCCESS' → 'error';
 * - `status` absent but `response` a non-empty string → 'ok' (absent is not invalid);
 * - otherwise → 'incomplete'.
 * A non-string / empty `status` is treated as absent.
 */
export function deriveStatus(payload: Record<string, unknown>): RunStatus {
  const status = payload.status;
  if (typeof status === 'string' && status.length > 0) {
    return status === 'SUCCESS' ? 'ok' : 'error';
  }
  const response = payload.response;
  return typeof response === 'string' && response.length > 0 ? 'ok' : 'incomplete';
}

/** The mapped view of a payload, before the adapter grafts on model / composed notes. */
export interface MappedPayload {
  conversationId: string;
  text: string;
  status: RunStatus;
  usage?: TokenUsage;
  /** The vendor `error` text, to be composed into RunResult.note by the adapter. */
  errorNote?: string;
}

/**
 * The single result mapper — used by run(), resume(), and the stream's `result`
 * event. Produces the vendor-neutral core of a RunResult; `model`, extra notes, and
 * `raw` are attached by the adapter (the caller knows the requested model; the
 * payload carries none).
 */
export function mapPayload(payload: Record<string, unknown>): MappedPayload {
  const usage = mapUsage(payload);
  const errorNote = extractErrorNote(payload);
  return {
    conversationId: extractConversationId(payload),
    text: extractText(payload),
    status: deriveStatus(payload),
    ...(usage ? { usage } : {}),
    ...(errorNote ? { errorNote } : {}),
  };
}
