/**
 * Cursor quota read.
 *
 * IMPORTANT: this runs ONLY in the user's own runtime, authenticated with the
 * user's own `cursor-agent` login — it is never proxied through a server. It reads
 * the access token the CLI stored and calls Cursor's dashboard endpoint
 * `DashboardService/GetCurrentPeriodUsage` (Connect-RPC over JSON) to ask for THAT
 * account's own usage. Every failure path (no credential, unreadable or malformed
 * data, no token, an expired token, network error, non-2xx, the deadline, a body of
 * another shape) returns `null` — it never throws. The token is read for exactly one
 * thing — the `Authorization` header of that one request — and is never logged,
 * returned, placed in `raw`, or used as a cache key.
 *
 * Where the token comes from (same places the CLI keeps it):
 * - On macOS with the CLI's DEFAULT credential store, the CLI keeps the token in the
 *   login keychain, so it is read FIRST — see {@link defaultReadCursorKeychain}.
 * - Otherwise (and as the fallback after the keychain), the CLI's login FILE — see
 *   {@link cursorAuthPaths}.
 *
 * Body shape (observed; every field optional):
 *
 *   { billingCycleStart: "<epoch ms>", billingCycleEnd: "<epoch ms>",
 *     planUsage: { totalPercentUsed, autoPercentUsed, apiPercentUsed,
 *                  limit, remaining, totalSpend, includedSpend },
 *     displayMessage }
 *
 * The three percentages are already on a 0..100 scale (1.045 means 1.045%, which
 * Cursor's own dashboard draws as "1%") — they are NOT fractions, and NOT
 * `totalSpend / limit`: their denominator is Cursor-internal. They are the bars the
 * dashboard shows (Total / First-party models / API), so they are read verbatim
 * and only clamped. The monetary fields are cents and are left in `raw`.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { QuotaSnapshot, QuotaWindow } from '@toragonite/agent-mesh';
import { isRecord } from './parse.js';

export type ReadTextFile = (path: string) => Promise<string | null>;

const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

/** The name the current CLI gives its credential store (`domain` in its own code). */
const STORE_NAME = 'cursor';

/** The name older CLI builds used for the same store — read as a fallback. */
const LEGACY_STORE_NAME = 'cursor-agent';

/** Which credential store the CLI uses, by its own `AGENT_CLI_CREDENTIAL_STORE` rule. */
export type CredentialStoreKind = 'file' | 'memory' | 'default';

/**
 * Classify the credential store exactly as the CLI does: `AGENT_CLI_CREDENTIAL_STORE`
 * is `"file"` or `"memory"` ONLY on an exact match (no trim, no case-fold), anything
 * else — including unset, `"keychain"`, `" memory"` — is the DEFAULT store.
 */
export function credentialStoreKind(env: Record<string, string | undefined>): CredentialStoreKind {
  const v = env.AGENT_CLI_CREDENTIAL_STORE;
  return v === 'file' ? 'file' : v === 'memory' ? 'memory' : 'default';
}

/** Window label → the `planUsage` percentage it is read from, in snapshot order. */
const WINDOW_FIELDS = [
  ['total', 'totalPercentUsed'],
  ['auto', 'autoPercentUsed'],
  ['api', 'apiPercentUsed'],
] as const;

/** The CLI's own title-casing for its Windows directory: `cursor` → `Cursor`, `cursor-agent` → `Cursor-agent`. */
function toWindowsTitleCase(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

/**
 * The login files to try, in order — the first one that exists is the login.
 *
 * 1. Where the current CLI keeps its file store: its own `getAuthFilePath(domain)`
 *    with `domain = "cursor"` (as read from the cursor-agent 2026.09.18, 2026.10.12
 *    and 2026.10.14 bundles):
 *
 *      win32   %APPDATA%\Cursor\auth.json          (APPDATA unset → ~\AppData\Roaming)
 *      darwin  ~/.cursor/auth.json                  (XDG_CONFIG_HOME is not consulted)
 *      other   $XDG_CONFIG_HOME/cursor/auth.json    (unset → ~/.config)
 *
 * 2. The older `cursor-agent` location, kept as a fallback:
 *
 *      win32   %APPDATA%\Cursor-agent\auth.json
 *      other   $XDG_CONFIG_HOME/cursor-agent/auth.json (unset → ~/.config), darwin included
 *
 * `AGENT_CLI_CREDENTIAL_STORE=memory` tells the CLI to keep its login in memory
 * only, so there is no file to read and the list is EMPTY (compared exactly, as the
 * CLI compares it). An EMPTY `XDG_CONFIG_HOME` / `APPDATA` counts as unset — the CLI
 * resolves both with `||`, and an empty base would otherwise turn the path relative
 * to the current directory. Pure: the platform and home directory are parameters,
 * so tests never consult the real ones.
 *
 * Not read: on macOS the CLI's DEFAULT store is the system keychain, not a file. A
 * login kept there has no file at any of these paths, so quota() resolves null.
 */
export function cursorAuthPaths(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  if (credentialStoreKind(env) === 'memory') return [];
  if (platform === 'win32') {
    const appData = env.APPDATA || win32.join(home, 'AppData', 'Roaming');
    return [
      win32.join(appData, toWindowsTitleCase(STORE_NAME), 'auth.json'),
      win32.join(appData, toWindowsTitleCase(LEGACY_STORE_NAME), 'auth.json'),
    ];
  }
  const config = env.XDG_CONFIG_HOME || posix.join(home, '.config');
  const current =
    platform === 'darwin'
      ? posix.join(home, `.${STORE_NAME}`, 'auth.json')
      : posix.join(config, STORE_NAME, 'auth.json');
  return [current, posix.join(config, LEGACY_STORE_NAME, 'auth.json')];
}

/** The form the adapter uses: the real home directory (platform defaults to the real one). */
export function defaultCursorAuthPaths(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return cursorAuthPaths(env, platform, homedir());
}

/* ------------------------------------------------------------------------- *
 * The macOS keychain — where the CLI's DEFAULT store keeps the token
 * ------------------------------------------------------------------------- */

/** What one keychain read yielded. `refused` is macOS blocking it for interaction. */
export type KeychainReadResult =
  | { found: true; token: string }
  | { found: false; refused: boolean };

/** The injectable keychain-read seam (so tests never run the real `security`). */
export type ReadKeychain = () => Promise<KeychainReadResult>;

/** The absolute binary, account, service, and argv the CLI itself uses — matched exactly. */
export const KEYCHAIN_BINARY = '/usr/bin/security';
export const KEYCHAIN_ACCOUNT = 'cursor-user';
export const KEYCHAIN_SERVICE = 'cursor-access-token';
/** `-w` makes `security` print ONLY the password to stdout. */
export const KEYCHAIN_ARGS = [
  'find-generic-password',
  '-a',
  KEYCHAIN_ACCOUNT,
  '-s',
  KEYCHAIN_SERVICE,
  '-w',
] as const;
/** Kill the `security` child if it has not answered in this long. */
const KEYCHAIN_TIMEOUT_MS = 10_000;
/** The only variables the `security` child is given; nothing else of the user's env. */
const KEYCHAIN_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LANG'] as const;

/** The minimal child env: just PATH / HOME / USER / LANG, each only when a real string. */
function minimalSecurityEnv(base: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of KEYCHAIN_ENV_KEYS) {
    const value = base[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/**
 * Read the `cursor-agent` CLI's access token from the login keychain the way the CLI
 * does: spawn `/usr/bin/security find-generic-password -a cursor-user -s
 * cursor-access-token -w` with NO shell, piped stdio, and a minimal environment, and
 * take trimmed stdout as the token. `found:false` for an empty token, a non-zero
 * exit, the timeout, or a spawn error — the caller then falls back to the files.
 *
 * `refused` is set when `security` reported that it could not show (or the user
 * denied) the interaction prompt — exit 51 or 36, or an stderr saying interaction is
 * not allowed / the user canceled. The caller backs off on it so a denied prompt is
 * not re-raised on every quota poll (see the adapter's keychain backoff).
 */
export const defaultReadCursorKeychain: ReadKeychain = () =>
  new Promise<KeychainReadResult>((resolve) => {
    const notFound: KeychainReadResult = { found: false, refused: false };
    let child;
    try {
      child = spawn(KEYCHAIN_BINARY, [...KEYCHAIN_ARGS], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: minimalSecurityEnv(process.env),
      });
    } catch {
      resolve(notFound);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: KeychainReadResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      done(notFound);
    }, KEYCHAIN_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', () => done(notFound));
    child.on('close', (code) => {
      const refused =
        code === 51 ||
        code === 36 ||
        /interaction is not allowed|user canceled|user cancelled/i.test(stderr);
      if (refused) {
        done({ found: false, refused: true });
        return;
      }
      const token = stdout.trim();
      done(code === 0 && token.length > 0 ? { found: true, token } : notFound);
    });
  });

/**
 * The `accessToken` of the first login file that exists, or undefined. Never emitted.
 *
 * The first path the reader returns content for is AUTHORITATIVE: when it is
 * malformed or carries no token (e.g. `{ "apiKey": … }` alone, or the
 * `{ "bedrockCredentials": … }` a logout leaves), the answer is "no token" — a
 * later, older file is never consulted, since it would be a different or stale
 * login. A reader that throws stops the search the same way. Only an ABSENT file
 * (null) moves on to the next path.
 */
export async function readAccessToken(
  authPaths: string[],
  readTextFile: ReadTextFile,
): Promise<string | undefined> {
  for (const authPath of authPaths) {
    let raw: string | null;
    try {
      raw = await readTextFile(authPath);
    } catch {
      return undefined;
    }
    if (raw === null || raw === undefined) continue; // absent — try the next location
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    const token = parsed.accessToken;
    return typeof token === 'string' && token.trim().length > 0 ? token.trim() : undefined;
  }
  return undefined;
}

/**
 * The token's expiry in epoch ms, when it is a JWT that declares a numeric `exp`.
 * A token that is not a JWT, or whose claims do not decode, declares no expiry.
 * The claims are READ, never verified — Cursor's servers decide validity.
 */
function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    const exp = isRecord(claims) ? claims.exp : undefined;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** A percentage clamped to 0..100 — or undefined unless it is a finite NUMBER (never a 0 invented). */
function percent(x: unknown): number | undefined {
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined;
  return Math.max(0, Math.min(100, x));
}

/** A valid Date's ISO string, or undefined — `new Date(1e20).toISOString()` would throw. */
function isoAt(ms: number): string | undefined {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * `billingCycleEnd` as an ISO instant, or undefined. Cursor sends epoch
 * MILLISECONDS as a digit string ("1787443666000"); a number is read the same way.
 * Either must be positive. Any other non-blank string is read as an ISO instant.
 */
function cycleEnd(x: unknown): string | undefined {
  if (typeof x === 'number') return Number.isFinite(x) && x > 0 ? isoAt(x) : undefined;
  if (typeof x !== 'string' || x.trim() === '') return undefined;
  if (/^\d+$/.test(x)) {
    const ms = Number(x);
    return Number.isFinite(ms) && ms > 0 ? isoAt(ms) : undefined;
  }
  const parsed = Date.parse(x);
  return Number.isNaN(parsed) ? undefined : isoAt(parsed);
}

/**
 * Map a GetCurrentPeriodUsage body to a QuotaSnapshot, or null when it carries no
 * usable window. `raw` is the WHOLE body. The body carries no token.
 */
function mapUsageBody(body: Record<string, unknown>): QuotaSnapshot | null {
  const plan = body.planUsage;
  if (!isRecord(plan)) return null;
  const resetAt = cycleEnd(body.billingCycleEnd);
  const windows: QuotaWindow[] = [];
  for (const [label, field] of WINDOW_FIELDS) {
    const usedPercent = percent(plan[field]);
    if (usedPercent === undefined) continue; // unstated — left out, never reported as 0
    const window: QuotaWindow = { label, usedPercent };
    if (resetAt) window.resetAt = resetAt;
    windows.push(window);
  }
  if (windows.length === 0) return null;
  // Cursor states no gate of its own, so it is derived: a fully-consumed window
  // (usedPercent >= 100) means new work is refused.
  const allowed = !windows.some((w) => w.usedPercent >= 100);
  return { vendor: 'cursor', windows, allowed, raw: body };
}

/** Resolves the account's access token, or undefined when there is none to use. */
export type ResolveToken = () => Promise<string | undefined>;

export async function readQuota(
  resolveToken: ResolveToken,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<QuotaSnapshot | null> {
  // Resolve the token first (keychain and/or files). No token → no request at all.
  let token: string | undefined;
  try {
    token = await resolveToken();
  } catch {
    return null; // a token source that threw must never break quota()
  }
  if (!token) return null;
  // An expired token is refused BEFORE any request: the CLI refreshes it the next
  // time it runs, and this library never refreshes a credential itself.
  const expiresAt = jwtExpiryMs(token);
  if (expiresAt !== undefined && expiresAt <= Date.now()) return null;

  // Bound the request so a hung endpoint cannot stall Fleet.route(): abort it at the
  // deadline AND race a deadline promise — around the request and around the body
  // read — so even a fetch seam that ignores the AbortSignal still resolves null in
  // time. Any outcome but a usable body → null.
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
    const res = await Promise.race([
      fetchFn(USAGE_URL, {
        method: 'POST',
        // Connect-RPC: the empty JSON object is the whole request, and the protocol
        // version header is required (the server answers 415 without it). The token
        // is used HERE and nowhere else.
        headers: {
          Authorization: `Bearer ${token}`,
          'Connect-Protocol-Version': '1',
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (res === null) return null; // deadline won — treat headroom as unknown
    if (!res.ok) return null;
    const body: unknown = await Promise.race([res.json() as Promise<unknown>, deadline]);
    // A 200 with another shape (`{}`, an error body, no planUsage, no usable
    // percentage) is NOT a usable snapshot — null, so the router treats headroom
    // as unknown rather than trusting a fabricated reading. (A won deadline also
    // lands here: it resolves null, which is not a record.)
    if (!isRecord(body)) return null;
    return mapUsageBody(body);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
