/**
 * Codex quota read.
 *
 * IMPORTANT: this runs ONLY in the user's own runtime, authenticated with the
 * user's local CLI login — it is never proxied through a server. It reads the
 * bearer access token out of auth.json and calls the `wham/usage` backend
 * endpoint. Every failure path (no file, no token, non-2xx, network error,
 * parse error) returns `null` — it never throws. The token is never logged,
 * returned, or placed in `raw`.
 *
 * Body shape. The live body nests the rate-limit fields under `rate_limit`, beside
 * a top-level `plan_type` / `credits`:
 *
 *   { plan_type, credits, rate_limit: { allowed, limit_reached,
 *       primary_window:   { used_percent, limit_window_seconds, reset_after_seconds, reset_at },
 *       secondary_window: { ...same } } }
 *
 * (`reset_at` is epoch seconds). An older body carried `allowed` / `primary_window`
 * / `secondary_window` at the TOP level; that shape is still read as a fallback.
 */
import type { QuotaSnapshot, QuotaWindow } from '@toragonite/agent-mesh';
import { readAuthJson, type ReadTextFile } from './auth.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** True when a rate-limit record carries at least one field we actually recognize. */
function hasRecognizedQuotaField(b: Record<string, unknown>): boolean {
  return (
    typeof b.allowed === 'boolean' ||
    typeof b.limit_reached === 'boolean' ||
    isRecord(b.primary_window) ||
    isRecord(b.secondary_window)
  );
}

/**
 * The record that carries the rate-limit fields: the nested `rate_limit` (the live
 * shape) when it carries a recognized field, else the top level (the older shape)
 * when IT does, else undefined — a body with neither is not a usage reading. One
 * record is read whole; windows and `allowed` are never mixed across the two shapes.
 */
function rateLimitRecord(body: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(body.rate_limit) && hasRecognizedQuotaField(body.rate_limit)) return body.rate_limit;
  return hasRecognizedQuotaField(body) ? body : undefined;
}

function firstString(...xs: unknown[]): string | undefined {
  for (const x of xs) {
    if (typeof x === 'string' && x.length > 0) return x;
  }
  return undefined;
}

/** Pull a bearer access token out of auth.json, trying the known shapes. Never emitted. */
function extractToken(parsed: Record<string, unknown>): string | undefined {
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  return firstString(tokens?.access_token, parsed.access_token, parsed.token);
}

/**
 * The ChatGPT workspace/account id (a plain UUID, not a secret) stored next to the
 * tokens. The backend rejects bearer-only requests for multi-workspace accounts, so
 * it rides along as the `chatgpt-account-id` header when present.
 */
function extractAccountId(parsed: Record<string, unknown>): string | undefined {
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  return firstString(tokens?.account_id, parsed.account_id);
}

/**
 * `used_percent` clamped to 0..100. A window OBJECT the vendor sent is always
 * reported, so a missing, non-numeric, or non-finite `used_percent` reads as 0 —
 * the window exists, its usage is simply unstated.
 */
function clampPercent(x: unknown): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, x));
}

/** A valid Date's ISO string, or undefined — `new Date(1e20).toISOString()` would throw. */
function isoAt(ms: number): string | undefined {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Convert an epoch (seconds or ms) or ISO string to an ISO instant, or undefined.
 * An epoch of 0 or below is not a reset time (it is an unset field), so it reads
 * as absent and the caller falls through to its next source.
 */
function toIso(x: unknown): string | undefined {
  let ms: number | undefined;
  if (typeof x === 'number' && Number.isFinite(x)) {
    if (x <= 0) return undefined;
    ms = x < 1e12 ? x * 1000 : x; // heuristic: < ~1e12 is epoch-seconds
  } else if (typeof x === 'string') {
    if (/^\d+$/.test(x)) {
      const n = Number(x);
      if (n <= 0) return undefined;
      ms = n < 1e12 ? n * 1000 : n;
    } else {
      const parsed = Date.parse(x);
      ms = Number.isNaN(parsed) ? undefined : parsed;
    }
  }
  return ms === undefined ? undefined : isoAt(ms);
}

/** `reset_after_seconds` from the capture instant, when it is a finite non-negative number. */
function resetAfter(x: unknown, capturedMs: number): string | undefined {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) return undefined;
  return isoAt(capturedMs + x * 1000);
}

function mapWindow(label: string, w: unknown, capturedMs: number): QuotaWindow | undefined {
  if (!isRecord(w)) return undefined;
  const window: QuotaWindow = { label, usedPercent: clampPercent(w.used_percent) };
  // `reset_at` is the live field; `resets_at` is kept for the older body. An absolute
  // instant wins; the relative `reset_after_seconds` is the fallback.
  const resetAt =
    toIso(w.reset_at) ?? toIso(w.resets_at) ?? resetAfter(w.reset_after_seconds, capturedMs);
  if (resetAt) window.resetAt = resetAt;
  return window;
}

/**
 * Map a wham/usage body to a QuotaSnapshot, reading the windows and the gate from
 * `limits` (see {@link rateLimitRecord}). `raw` is the WHOLE body. The body carries
 * no token.
 */
function mapUsageBody(
  body: Record<string, unknown>,
  limits: Record<string, unknown>,
  capturedMs: number,
): QuotaSnapshot {
  const windows: QuotaWindow[] = [];
  const primary = mapWindow('primary', limits.primary_window, capturedMs);
  if (primary) windows.push(primary);
  const secondary = mapWindow('secondary', limits.secondary_window, capturedMs);
  if (secondary) windows.push(secondary);
  // When the vendor states `allowed`, trust it verbatim; failing that, its
  // `limit_reached` is the same gate inverted. When BOTH are absent, derive it — a
  // fully-consumed window (usedPercent >= 100) means new work is refused, so an
  // exhausted body must never fabricate `allowed:true` and mislead the router.
  const allowed =
    typeof limits.allowed === 'boolean'
      ? limits.allowed
      : typeof limits.limit_reached === 'boolean'
        ? !limits.limit_reached
        : !windows.some((w) => w.usedPercent >= 100);
  return {
    vendor: 'codex',
    windows,
    allowed,
    raw: body,
  };
}

export async function readQuota(
  homeDir: string,
  readTextFile: ReadTextFile,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<QuotaSnapshot | null> {
  // Bound the fetch so a hung endpoint cannot stall Fleet.route(): abort the request
  // at the deadline AND race a deadline promise, so even a fetch seam that ignores
  // the AbortSignal still resolves null in time. The body read is raced too — a
  // response whose headers arrive but whose body never ends is the same hang.
  // Any outcome but a usable body → null.
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const parsed = await readAuthJson(homeDir, readTextFile);
    if (!parsed) return null;
    const token = extractToken(parsed);
    if (!token) return null;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const accountId = extractAccountId(parsed);
    if (accountId) headers['chatgpt-account-id'] = accountId;
    const res = await Promise.race([
      fetchFn(USAGE_URL, { headers, signal: controller.signal }),
      deadline,
    ]);
    if (res === null) return null; // deadline won — treat headroom as unknown
    if (!res.ok) return null;
    const body: unknown = await Promise.race([res.json() as Promise<unknown>, deadline]);
    // A 200 with an unrelated JSON shape (e.g. `{}` or an error body) is NOT a
    // usable snapshot — return null so the router treats headroom as unknown
    // rather than fabricating a confident allowed-with-no-windows result. (A won
    // deadline also lands here: it resolves null, which is not a record.)
    if (!isRecord(body)) return null;
    const limits = rateLimitRecord(body);
    if (!limits) return null;
    return mapUsageBody(body, limits, Date.now());
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
