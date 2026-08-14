/**
 * Codex quota read.
 *
 * IMPORTANT: this runs ONLY in the user's own runtime, authenticated with the
 * user's local CLI login — it is never proxied through a server. It reads the
 * bearer access token out of auth.json and calls the `wham/usage` backend
 * endpoint. Every failure path (no file, no token, non-2xx, network error,
 * parse error) returns `null` — it never throws. The token is never logged,
 * returned, or placed in `raw`.
 */
import type { QuotaSnapshot, QuotaWindow } from '@toragonite/agent-mesh';
import { readAuthJson, type ReadTextFile } from './auth.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** True when a usage body carries at least one field we actually recognize. */
function hasRecognizedQuotaField(b: Record<string, unknown>): boolean {
  return (
    typeof b.allowed === 'boolean' || isRecord(b.primary_window) || isRecord(b.secondary_window)
  );
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

function clampPercent(x: unknown): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, x));
}

/** Convert an epoch (seconds or ms) or ISO string to an ISO instant, or undefined. */
function toIso(x: unknown): string | undefined {
  let ms: number | undefined;
  if (typeof x === 'number' && Number.isFinite(x)) {
    ms = x < 1e12 ? x * 1000 : x; // heuristic: < ~1e12 is epoch-seconds
  } else if (typeof x === 'string') {
    if (/^\d+$/.test(x)) {
      const n = Number(x);
      ms = n < 1e12 ? n * 1000 : n;
    } else {
      const parsed = Date.parse(x);
      ms = Number.isNaN(parsed) ? undefined : parsed;
    }
  }
  if (ms === undefined) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function mapWindow(label: string, w: unknown): QuotaWindow | undefined {
  if (!isRecord(w)) return undefined;
  const window: QuotaWindow = { label, usedPercent: clampPercent(w.used_percent) };
  const resetAt = toIso(w.resets_at ?? w.reset_at);
  if (resetAt) window.resetAt = resetAt;
  return window;
}

/** Map a wham/usage response body to a QuotaSnapshot. The body carries no token. */
function mapUsageBody(body: unknown): QuotaSnapshot {
  const b = isRecord(body) ? body : {};
  const windows: QuotaWindow[] = [];
  const primary = mapWindow('primary', b.primary_window);
  if (primary) windows.push(primary);
  const secondary = mapWindow('secondary', b.secondary_window);
  if (secondary) windows.push(secondary);
  // When the vendor states `allowed`, trust it verbatim. When it is ABSENT, derive
  // it — a fully-consumed window (usedPercent >= 100) means new work is refused, so
  // an exhausted body must never fabricate `allowed:true` and mislead the router.
  const allowed =
    typeof b.allowed === 'boolean' ? b.allowed : !windows.some((w) => w.usedPercent >= 100);
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
  // the AbortSignal still resolves null in time. Any outcome but a usable body → null.
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
    const body: unknown = await res.json();
    // A 200 with an unrelated JSON shape (e.g. `{}` or an error body) is NOT a
    // usable snapshot — return null so the router treats headroom as unknown
    // rather than fabricating a confident allowed-with-no-windows result.
    if (!isRecord(body) || !hasRecognizedQuotaField(body)) return null;
    return mapUsageBody(body);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
