/**
 * Auth-state resolution for Codex.
 *
 * Two modes: an `OPENAI_API_KEY` in the environment, or a ChatGPT OAuth login
 * whose state lives at `<CODEX_HOME>/auth.json`. `CODEX_HOME` is isolated per
 * account via the account's `configDir`. Nothing here throws, and no token or
 * secret material is ever decoded or emitted — at most a plain email is
 * surfaced as `detail`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Account, AuthStatus } from '@toragonite/agent-mesh';

export type ReadTextFile = (path: string) => Promise<string | null>;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

/**
 * Resolve the CODEX_HOME directory for an account.
 *
 * An explicitly passed account is authoritative: when it carries no `configDir`
 * it means "use the ambient login", NOT the default account's dir. Only when NO
 * account is passed does the adapter's default account apply. Ambient resolution
 * is then `CODEX_HOME` env → `~/.codex`. This mirrors the run/resume env seam so
 * introspection and execution never resolve different accounts.
 */
export function resolveCodexHome(
  account: Account | undefined,
  defaultAccount: Account | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const configDir = account ? account.configDir : defaultAccount?.configDir;
  return configDir ?? env.CODEX_HOME ?? join(homedir(), '.codex');
}

/** Read and JSON-parse `<home>/auth.json`; null on any missing/unreadable/invalid file. */
export async function readAuthJson(
  homeDir: string,
  readTextFile: ReadTextFile,
): Promise<Record<string, unknown> | null> {
  let raw: string | null;
  try {
    raw = await readTextFile(join(homeDir, 'auth.json'));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Return the first string that looks like an email, or undefined. Never a token. */
function looksLikeEmail(x: unknown): string | undefined {
  return typeof x === 'string' && x.includes('@') && !x.includes(' ') ? x : undefined;
}

/** Extract a plain email from auth.json — top level or under tokens/account. Never decodes tokens. */
export function extractEmail(parsed: Record<string, unknown>): string | undefined {
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  const account = isRecord(parsed.account) ? parsed.account : undefined;
  const tokensAccount = tokens && isRecord(tokens.account) ? tokens.account : undefined;
  return (
    looksLikeEmail(parsed.email) ??
    looksLikeEmail(account?.email) ??
    looksLikeEmail(tokens?.email) ??
    looksLikeEmail(tokensAccount?.email)
  );
}

/** True when auth.json carries a real ChatGPT OAuth bearer (access_token or id_token). */
function hasChatgptToken(parsed: Record<string, unknown>): boolean {
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  if (!tokens) return false;
  return isNonEmptyString(tokens.access_token) || isNonEmptyString(tokens.id_token);
}

/** True when auth.json embeds an API key (`codex login --api-key` with no env var). */
function hasApiKeyField(parsed: Record<string, unknown>): boolean {
  return isNonEmptyString(parsed.OPENAI_API_KEY);
}

/**
 * Compute auth status by VALUE, not by file presence.
 *
 * Precedence:
 * 1. An ambient `OPENAI_API_KEY` → `api-key`.
 * 2. A parseable auth.json with a real ChatGPT bearer token → `chatgpt`.
 * 3. A parseable auth.json embedding `OPENAI_API_KEY` (and no bearer) → `api-key`.
 * 4. Anything else (missing/empty/token-less file, e.g. `{}` or `{tokens:null}`)
 *    → logged out. A bare parseable file is NOT proof of login.
 */
export async function resolveAuthStatus(
  apiKey: string | undefined,
  homeDir: string,
  readTextFile: ReadTextFile,
): Promise<AuthStatus> {
  if (apiKey && apiKey.trim().length > 0) {
    return { loggedIn: true, mode: 'api-key' };
  }
  const parsed = await readAuthJson(homeDir, readTextFile);
  if (!parsed) return { loggedIn: false };
  if (hasChatgptToken(parsed)) {
    const email = extractEmail(parsed);
    return { loggedIn: true, mode: 'chatgpt', ...(email ? { detail: email } : {}) };
  }
  if (hasApiKeyField(parsed)) {
    return { loggedIn: true, mode: 'api-key' };
  }
  return { loggedIn: false };
}
