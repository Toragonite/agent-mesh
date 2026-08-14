/**
 * Tolerant parser for `codex exec --json` output.
 *
 * The CLI emits JSONL — one JSON event per line — but the event schema drifts
 * across CLI versions, so every field here is extracted defensively: lines that
 * are not valid JSON are skipped, and every key is probed under several aliases.
 * Nothing in here throws; a garbage stream yields an all-empty result.
 */
import type { TokenUsage } from '@toragonite/agent-mesh';

export interface ParsedRun {
  /** Conversation/thread id, or '' when the stream carried none. */
  conversationId: string;
  /** Final assistant text, or '' when none was found. */
  text: string;
  usage?: TokenUsage;
  /** A model id observed in the events, if any. */
  model?: string;
  /** Message from an explicit error event, if the stream reported one. */
  errorMessage?: string;
  /** The last successfully parsed event object (for RunResult.raw). */
  raw?: unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** First argument that is a non-empty string, else undefined. */
function firstString(...xs: unknown[]): string | undefined {
  for (const x of xs) {
    if (typeof x === 'string' && x.length > 0) return x;
  }
  return undefined;
}

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

/** Map a vendor `usage` object to TokenUsage, or undefined if it carries nothing. */
function mapUsage(u: unknown): TokenUsage | undefined {
  if (!isRecord(u)) return undefined;
  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  const cachedInputTokens = num(u.cached_input_tokens);
  const totalTokens = num(u.total_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  const usage: TokenUsage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  // A vendor-supplied total wins verbatim; otherwise derive it from input+output
  // when BOTH are present; otherwise omit the field entirely.
  if (totalTokens !== undefined) {
    usage.totalTokens = totalTokens;
  } else if (inputTokens !== undefined && outputTokens !== undefined) {
    usage.totalTokens = inputTokens + outputTokens;
  }
  return usage;
}

/** Count the recognized usage keys carried directly on an event object. */
function inlineUsageKeyCount(ev: Record<string, unknown>): number {
  let n = 0;
  if (num(ev.input_tokens) !== undefined) n++;
  if (num(ev.output_tokens) !== undefined) n++;
  if (num(ev.cached_input_tokens) !== undefined) n++;
  return n;
}

/** Pull the best usage candidate off an event, checking the known nesting spots. */
function usageFromEvent(ev: Record<string, unknown>): TokenUsage | undefined {
  const nested = mapUsage(ev.usage) ?? (isRecord(ev.item) ? mapUsage(ev.item.usage) : undefined);
  if (nested) return nested;
  // Inline usage on the event itself is accepted ONLY when the event carries at
  // least two recognized keys — a single stray `input_tokens` on an unrelated
  // event must not be mistaken for a usage report.
  return inlineUsageKeyCount(ev) >= 2 ? mapUsage(ev) : undefined;
}

/** Count the recognized (non-derived) fields a candidate defines — its completeness. */
function usageScore(u: TokenUsage): number {
  let n = 0;
  if (u.inputTokens !== undefined) n++;
  if (u.outputTokens !== undefined) n++;
  if (u.cachedInputTokens !== undefined) n++;
  return n;
}

/**
 * Merge a newer usage candidate into the accumulated one, FIELD-WISE:
 * - a defined field is never overwritten with undefined;
 * - on a field both candidates define, the more complete candidate wins
 *   (ties → the newer candidate, which arrives as `next`).
 * This keeps a complete `turn.completed` usage from being clobbered by a later
 * partial (item-level or interim) usage shape.
 */
function mergeUsage(prev: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!prev) return next;
  const [lo, hi] = usageScore(next) >= usageScore(prev) ? [prev, next] : [next, prev];
  return { ...lo, ...hi };
}

export function parseCodexEvents(stdout: string): ParsedRun {
  let conversationId: string | undefined;
  let lastAgentText: string | undefined;
  let usage: TokenUsage | undefined;
  let model: string | undefined;
  let errorMessage: string | undefined;
  let lastEvent: Record<string, unknown> | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue; // tolerate interleaved non-JSON (banners, progress, log noise)
    }
    if (!isRecord(ev)) continue;
    lastEvent = ev;

    const type = typeof ev.type === 'string' ? ev.type : '';

    // conversation id — first hit wins; prefer a thread.started event but accept
    // the id keys anywhere, and the nested thread.id form.
    if (conversationId === undefined) {
      const startish = type.includes('thread.started') || type.includes('session.created');
      const nestedThreadId = isRecord(ev.thread) ? ev.thread.id : undefined;
      const cand = firstString(
        ev.thread_id,
        ev.session_id,
        ev.conversation_id,
        nestedThreadId,
        startish ? ev.id : undefined,
      );
      if (cand) conversationId = cand;
    }

    // final assistant text — last completed agent_message item wins.
    if (type === 'item.completed' && isRecord(ev.item)) {
      const itemType = typeof ev.item.type === 'string' ? ev.item.type : '';
      if (itemType.includes('agent_message') && typeof ev.item.text === 'string') {
        lastAgentText = ev.item.text;
      }
    }

    // usage — merged field-wise so a later partial cannot clobber a complete one.
    const u = usageFromEvent(ev);
    if (u) usage = mergeUsage(usage, u);

    // model id observed in the stream — last hit wins.
    const m = firstString(ev.model, isRecord(ev.item) ? ev.item.model : undefined);
    if (m) model = m;

    // explicit error event — last message wins.
    if (type === 'error' || isRecord(ev.error) || typeof ev.error === 'string') {
      errorMessage =
        firstString(
          ev.message,
          isRecord(ev.error) ? ev.error.message : undefined,
          typeof ev.error === 'string' ? ev.error : undefined,
        ) ?? errorMessage;
    }
  }

  // fallback: a top-level result string on the final event.
  const fallbackText =
    lastEvent !== undefined
      ? firstString(lastEvent.result, lastEvent.response, lastEvent.last_agent_message)
      : undefined;

  const result: ParsedRun = {
    conversationId: conversationId ?? '',
    text: lastAgentText ?? fallbackText ?? '',
  };
  if (usage) result.usage = usage;
  if (model) result.model = model;
  if (errorMessage) result.errorMessage = errorMessage;
  if (lastEvent !== undefined) result.raw = lastEvent;
  return result;
}
