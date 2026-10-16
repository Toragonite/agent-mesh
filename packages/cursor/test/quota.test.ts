import { afterEach, describe, it, expect, vi } from 'vitest';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { CursorAdapter, type CursorAdapterOptions } from '../src/adapter.js';
import { cursorAuthPaths } from '../src/quota.js';
import { fakeFetch, jwt, mapReader, recordingExec, recordingReader, scriptedFetch } from './helpers.js';

const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const TOKEN = 'SECRET_CURSOR_TOKEN_XYZ';
const AUTH = JSON.stringify({ accessToken: TOKEN, refreshToken: 'SECRET_REFRESH' });
const CYCLE_END_MS = 1787443666000;

/** The GetCurrentPeriodUsage body observed on a live Pro+ account, verbatim in shape. */
const LIVE_BODY = {
  billingCycleStart: '1784765266000',
  billingCycleEnd: String(CYCLE_END_MS),
  planUsage: {
    totalSpend: 951,
    includedSpend: 951,
    remaining: 6049,
    limit: 7000,
    autoPercentUsed: 0.4525,
    apiPercentUsed: 5.3545454545454545,
    totalPercentUsed: 1.0450549450549451,
  },
  displayMessage: "You've used 14% of your included usage",
};

/**
 * An adapter whose every quota seam is a stub; nothing reaches the disk, the network,
 * or the real `security`. The keychain defaults to not-found so, on a macOS host, the
 * existing file tests fall through to the files exactly as they do elsewhere; a test
 * that is about the keychain passes its own `readKeychain` (and usually `platform`).
 */
function adapter(opts: Partial<CursorAdapterOptions> = {}): CursorAdapter {
  return new CursorAdapter({
    exec: recordingExec().exec,
    env: {},
    readTextFile: recordingReader(AUTH).read,
    readKeychain: async () => ({ found: false, refused: false }),
    fetchFn: fakeFetch(LIVE_BODY).fn,
    ...opts,
  });
}

/** quota() over a body, with a valid login file. */
async function quotaOf(body: unknown) {
  return adapter({ fetchFn: fakeFetch(body).fn }).quota();
}

/** quota() over a planUsage record (billingCycleEnd as the live body sends it). */
async function quotaOfPlan(planUsage: Record<string, unknown>, billingCycleEnd: unknown = String(CYCLE_END_MS)) {
  return quotaOf({ billingCycleEnd, planUsage });
}

describe('quota() capability', () => {
  it('advertises capabilities.quota as true and never spawns for quota()', async () => {
    const { exec, calls } = recordingExec();
    const a = adapter({ exec });
    expect(a.capabilities).toEqual({
      resume: true,
      steer: 'turn',
      peerMesh: false,
      quota: true,
      stream: true,
    });
    await a.quota();
    expect(calls).toHaveLength(0);
  });
});

describe('quota() mapping', () => {
  it('maps the live body: total / auto / api verbatim, reset at billingCycleEnd, allowed', async () => {
    const snap = await quotaOf(LIVE_BODY);
    const resetAt = new Date(CYCLE_END_MS).toISOString();
    expect(snap).toEqual({
      vendor: 'cursor',
      windows: [
        { label: 'total', usedPercent: 1.0450549450549451, resetAt },
        { label: 'auto', usedPercent: 0.4525, resetAt },
        { label: 'api', usedPercent: 5.3545454545454545, resetAt },
      ],
      allowed: true,
      raw: LIVE_BODY,
    });
    // Percentages are already 0..100 — 1.045 stays 1.045 (it is NOT a fraction to scale).
    expect(snap!.windows[0]!.usedPercent).toBeLessThan(2);
    expect(snap!.raw).toBe(LIVE_BODY);
    expect(snap).not.toHaveProperty('capturedAt');
  });

  it('leaves a missing percentage out instead of inventing a 0', async () => {
    const snap = await quotaOfPlan({ apiPercentUsed: 12 });
    expect(snap!.windows.map((w) => w.label)).toEqual(['api']);
    expect(snap!.windows[0]!.usedPercent).toBe(12);

    const two = await quotaOfPlan({ totalPercentUsed: 3, autoPercentUsed: 4 });
    expect(two!.windows.map((w) => w.label)).toEqual(['total', 'auto']);
  });

  it('leaves a string percentage out — numeric-looking or not', async () => {
    const snap = await quotaOfPlan({ totalPercentUsed: '12', autoPercentUsed: 'abc', apiPercentUsed: 7 });
    expect(snap!.windows).toEqual([
      { label: 'api', usedPercent: 7, resetAt: new Date(CYCLE_END_MS).toISOString() },
    ]);
  });

  it('leaves NaN, Infinity, null, a boolean, and an object out', async () => {
    const snap = await quotaOfPlan({
      totalPercentUsed: Number.NaN,
      autoPercentUsed: Number.POSITIVE_INFINITY,
      apiPercentUsed: 9,
    });
    expect(snap!.windows.map((w) => w.label)).toEqual(['api']);

    const none = await quotaOfPlan({ totalPercentUsed: null, autoPercentUsed: true, apiPercentUsed: {} });
    expect(none).toBeNull();
  });

  it('clamps 150 to 100 (and gates allowed:false) and a negative to 0', async () => {
    const snap = await quotaOfPlan({ totalPercentUsed: 150, autoPercentUsed: -5, apiPercentUsed: 40 });
    expect(snap!.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['total', 100],
      ['auto', 0],
      ['api', 40],
    ]);
    expect(snap!.allowed).toBe(false);
  });

  it('derives allowed from the windows: exactly 100 refuses, 99.9 permits', async () => {
    expect((await quotaOfPlan({ apiPercentUsed: 100 }))!.allowed).toBe(false);
    expect((await quotaOfPlan({ apiPercentUsed: 99.9, totalPercentUsed: 50 }))!.allowed).toBe(true);
  });

  it('returns null when no window is usable', async () => {
    expect(await quotaOfPlan({})).toBeNull();
    expect(await quotaOfPlan({ limit: 7000, remaining: 6049, totalSpend: 951 })).toBeNull();
  });

  it('returns null for a body of another shape', async () => {
    expect(await quotaOf({})).toBeNull();
    expect(await quotaOf({ planUsage: null })).toBeNull();
    expect(await quotaOf({ planUsage: [1, 2, 3] })).toBeNull();
    expect(await quotaOf({ planUsage: 'nope' })).toBeNull();
    expect(await quotaOf({ totalPercentUsed: 5 })).toBeNull(); // percentages at the wrong level
    expect(await quotaOf({ code: 'unauthenticated', message: 'Unauthorized' })).toBeNull();
    expect(await quotaOf([LIVE_BODY])).toBeNull();
    expect(await quotaOf(null)).toBeNull();
    expect(await quotaOf('{"planUsage":{}}')).toBeNull();
  });
});

describe('quota() billingCycleEnd → resetAt', () => {
  const iso = new Date(CYCLE_END_MS).toISOString();
  const resetOf = async (billingCycleEnd: unknown) =>
    (await quotaOfPlan({ totalPercentUsed: 10 }, billingCycleEnd))!.windows[0]!.resetAt;

  it('reads epoch ms as a number', async () => {
    expect(await resetOf(CYCLE_END_MS)).toBe(iso);
  });

  it('reads epoch ms as a digit string (the live form)', async () => {
    expect(await resetOf(String(CYCLE_END_MS))).toBe(iso);
  });

  it('reads an ISO string', async () => {
    expect(await resetOf('2026-08-23T00:07:46Z')).toBe('2026-08-23T00:07:46.000Z');
    expect(await resetOf('2026-08-23T09:07:46+09:00')).toBe('2026-08-23T00:07:46.000Z');
  });

  it('leaves resetAt absent for garbage — the window itself is still reported', async () => {
    for (const garbage of ['next tuesday', '', '   ', 'NaN', true, {}, [], null]) {
      const snap = await quotaOfPlan({ totalPercentUsed: 10 }, garbage);
      expect(snap!.windows).toEqual([{ label: 'total', usedPercent: 10 }]);
    }
  });

  it('leaves resetAt absent when billingCycleEnd is missing', async () => {
    const snap = await quotaOf({ planUsage: { totalPercentUsed: 10 } });
    expect(snap!.windows).toEqual([{ label: 'total', usedPercent: 10 }]);
  });

  it('leaves resetAt absent for a zero, negative, non-finite, or out-of-range epoch (never throws)', async () => {
    for (const bad of [0, '0', -1, Number.NaN, Number.POSITIVE_INFINITY, 1e20, '99999999999999999999']) {
      expect(await resetOf(bad)).toBeUndefined();
    }
  });
});

describe('quota() credential', () => {
  const HOME = homedir();
  /** The two locations, in order, for THIS platform with the given env (via the pure rule). */
  const here = (env: Record<string, string | undefined> = {}) => cursorAuthPaths(env, process.platform, HOME);

  it.runIf(process.platform === 'darwin')(
    'guard (darwin): tries ~/.cursor/auth.json, then ~/.config/cursor-agent/auth.json (asserted on the reader, never read)',
    async () => {
      const { read, paths } = recordingReader(null);
      await adapter({ env: {}, readTextFile: read }).quota();
      expect(paths).toEqual([join(HOME, '.cursor', 'auth.json'), join(HOME, '.config', 'cursor-agent', 'auth.json')]);
    },
  );

  it.runIf(process.platform === 'linux')(
    'guard (linux): tries ~/.config/cursor/auth.json, then ~/.config/cursor-agent/auth.json (asserted on the reader, never read)',
    async () => {
      const { read, paths } = recordingReader(null);
      await adapter({ env: {}, readTextFile: read }).quota();
      expect(paths).toEqual([
        join(HOME, '.config', 'cursor', 'auth.json'),
        join(HOME, '.config', 'cursor-agent', 'auth.json'),
      ]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'guard (win32): tries %APPDATA%\\Cursor\\auth.json, then %APPDATA%\\Cursor-agent\\auth.json',
    async () => {
      const { read, paths } = recordingReader(null);
      await adapter({ env: { APPDATA: 'D:\\Roam' }, readTextFile: read }).quota();
      expect(paths).toEqual(['D:\\Roam\\Cursor\\auth.json', 'D:\\Roam\\Cursor-agent\\auth.json']);
    },
  );

  it.skipIf(process.platform === 'win32')('honours XDG_CONFIG_HOME where the CLI does', async () => {
    const { read, paths } = recordingReader(null);
    await adapter({ env: { XDG_CONFIG_HOME: '/xdg/conf' }, readTextFile: read }).quota();
    const current = process.platform === 'darwin' ? join(HOME, '.cursor', 'auth.json') : '/xdg/conf/cursor/auth.json';
    expect(paths).toEqual([current, '/xdg/conf/cursor-agent/auth.json']);
  });

  it('uses the CURRENT location when it exists — the older one is never read', async () => {
    const [current, legacy] = here() as [string, string];
    const { read, paths } = mapReader({ [current]: AUTH, [legacy]: JSON.stringify({ accessToken: 'LEGACY_TOKEN' }) });
    const { fn, calls } = fakeFetch(LIVE_BODY);
    expect(await adapter({ readTextFile: read, fetchFn: fn }).quota()).not.toBeNull();
    expect(paths).toEqual([current]);
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('falls back to the OLDER location when the current one is absent', async () => {
    const [current, legacy] = here() as [string, string];
    const { read, paths } = mapReader({ [legacy]: JSON.stringify({ accessToken: 'LEGACY_TOKEN' }) });
    const { fn, calls } = fakeFetch(LIVE_BODY);
    expect(await adapter({ readTextFile: read, fetchFn: fn }).quota()).not.toBeNull();
    expect(paths).toEqual([current, legacy]);
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer LEGACY_TOKEN');
  });

  it('treats an existing current file as authoritative: unusable → null, the older file is not read', async () => {
    const [current, legacy] = here() as [string, string];
    const unusable = [
      '{not json',
      '',
      JSON.stringify({ apiKey: 'k' }),
      JSON.stringify({ bedrockCredentials: { accessKey: 'a', secretKey: 's' } }),
      JSON.stringify({ accessToken: jwt({ exp: 1 }) }),
    ];
    for (const content of unusable) {
      const { read, paths } = mapReader({ [current]: content, [legacy]: AUTH });
      const { fn, calls } = fakeFetch(LIVE_BODY);
      expect(await adapter({ readTextFile: read, fetchFn: fn }).quota()).toBeNull();
      expect(paths).toEqual([current]);
      expect(calls).toHaveLength(0);
    }
  });

  it('stops at a reader that throws on the current location (never falls back past it)', async () => {
    const [current] = here() as [string, string];
    const paths: string[] = [];
    const throwing = async (path: string) => {
      paths.push(path);
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    const { fn, calls } = fakeFetch(LIVE_BODY);
    expect(await adapter({ readTextFile: throwing, fetchFn: fn }).quota()).toBeNull();
    expect(paths).toEqual([current]);
    expect(calls).toHaveLength(0);
  });

  it('AGENT_CLI_CREDENTIAL_STORE=memory → null with no file read and no request', async () => {
    const { read, paths } = recordingReader(AUTH);
    const { fn, calls } = fakeFetch(LIVE_BODY);
    const a = adapter({ env: { AGENT_CLI_CREDENTIAL_STORE: 'memory' }, readTextFile: read, fetchFn: fn });
    expect(await a.quota()).toBeNull();
    expect(paths).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('AGENT_CLI_CREDENTIAL_STORE=file reads the same locations as the default', async () => {
    const { read, paths } = recordingReader(null);
    await adapter({ env: { AGENT_CLI_CREDENTIAL_STORE: 'file' }, readTextFile: read }).quota();
    expect(paths).toEqual(here());
  });

  it.skipIf(process.platform === 'win32')('treats an EMPTY XDG_CONFIG_HOME as unset', async () => {
    const { read, paths } = recordingReader(null);
    await adapter({ env: { XDG_CONFIG_HOME: '' }, readTextFile: read }).quota();
    expect(paths).toEqual(here({}));
    expect(paths[1]).toBe(join(HOME, '.config', 'cursor-agent', 'auth.json'));
  });

  it('ignores account.configDir (cursor-agent has no config-dir isolation)', async () => {
    const { read, paths } = recordingReader(AUTH);
    const a = adapter({ readTextFile: read, defaultAccount: { vendor: 'cursor', configDir: '/default/dir' } });
    await a.quota({ vendor: 'cursor', configDir: '/some/other/dir' });
    await a.quota();
    const [current] = here() as [string, string];
    expect(paths).toEqual([current, current]);
  });

  it('returns null and makes no request when no login file exists at either location', async () => {
    const { read, paths } = recordingReader(null);
    const { fn, calls } = fakeFetch(LIVE_BODY);
    expect(await adapter({ readTextFile: read, fetchFn: fn }).quota()).toBeNull();
    expect(paths).toEqual(here());
    expect(calls).toHaveLength(0);
  });

  it('returns null and makes no request when the login file is unreadable (reader throws)', async () => {
    const { fn, calls } = fakeFetch(LIVE_BODY);
    const throwing = async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    expect(await adapter({ readTextFile: throwing, fetchFn: fn }).quota()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null and makes no request when the login file is malformed', async () => {
    for (const content of ['', '{not json', '[]', 'null', '42', '"a string"', JSON.stringify([{ accessToken: TOKEN }])]) {
      const { fn, calls } = fakeFetch(LIVE_BODY);
      expect(await adapter({ readTextFile: recordingReader(content).read, fetchFn: fn }).quota()).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });

  it('returns null and makes no request when there is no usable accessToken', async () => {
    for (const auth of [{}, { accessToken: '' }, { accessToken: '   ' }, { accessToken: 123 }, { accessToken: null }, { refreshToken: 'r' }, { access_token: TOKEN }]) {
      const { fn, calls } = fakeFetch(LIVE_BODY);
      const a = adapter({ readTextFile: recordingReader(JSON.stringify(auth)).read, fetchFn: fn });
      expect(await a.quota()).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });

  it('returns null and makes no request for an expired JWT', async () => {
    const expired = jwt({ sub: 'auth0|user_x', exp: Math.floor(Date.now() / 1000) - 60 });
    const { fn, calls } = fakeFetch(LIVE_BODY);
    const a = adapter({ readTextFile: recordingReader(JSON.stringify({ accessToken: expired })).read, fetchFn: fn });
    expect(await a.quota()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('sends an unexpired JWT, and a JWT that declares no numeric exp', async () => {
    const tokens = [
      jwt({ sub: 'auth0|user_x', exp: Math.floor(Date.now() / 1000) + 3600 }),
      jwt({ sub: 'auth0|user_x' }),
      jwt({ sub: 'auth0|user_x', exp: '1' }),
    ];
    for (const token of tokens) {
      const { fn, calls } = fakeFetch(LIVE_BODY);
      const a = adapter({ readTextFile: recordingReader(JSON.stringify({ accessToken: token })).read, fetchFn: fn });
      expect(await a.quota()).not.toBeNull();
      expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    }
  });

  it('accepts a non-JWT token (no expiry to check) and one whose claims do not decode', async () => {
    for (const token of ['opaque-session-token', 'a.!!!.c', 'one.two', 'a.b.c.d']) {
      const { fn, calls } = fakeFetch(LIVE_BODY);
      const a = adapter({ readTextFile: recordingReader(JSON.stringify({ accessToken: token })).read, fetchFn: fn });
      expect(await a.quota()).not.toBeNull();
      expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    }
  });

  it('never places the token in the snapshot', async () => {
    const snap = await adapter().quota();
    expect(JSON.stringify(snap)).not.toContain(TOKEN);
    expect(JSON.stringify(snap)).not.toContain('SECRET_REFRESH');
  });
});

describe('quota() keychain (macOS)', () => {
  const KC_TOKEN = 'KEYCHAIN_SECRET_TOKEN_ABC';
  const FOUND = { found: true as const, token: KC_TOKEN };
  const NOT_FOUND = { found: false as const, refused: false };
  const REFUSED = { found: false as const, refused: true };

  /** A keychain seam that records its calls and returns a fixed (or scripted) result. */
  function keychainStub(result: typeof FOUND | typeof NOT_FOUND | typeof REFUSED) {
    let count = 0;
    const read = async () => {
      count += 1;
      return result;
    };
    return { read, calls: () => count };
  }

  const header = (calls: Array<{ init: RequestInit | undefined }>) =>
    (calls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization;

  /** Every string anywhere in a value — to prove a token reached none of them. */
  function deepStrings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) deepStrings(v, out);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) deepStrings(v, out);
    return out;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('on darwin + default store reads the keychain FIRST and sends its token; the files are not read', async () => {
    const kc = keychainStub(FOUND);
    const { read: file, paths } = recordingReader(AUTH);
    const { fn, calls } = fakeFetch(LIVE_BODY);
    const snap = await adapter({ platform: 'darwin', readKeychain: kc.read, readTextFile: file, fetchFn: fn }).quota();
    expect(snap).not.toBeNull();
    expect(kc.calls()).toBe(1);
    expect(header(calls)).toBe(`Bearer ${KC_TOKEN}`);
    expect(paths).toHaveLength(0); // the keychain won — no file was touched
  });

  it('on darwin, an empty keychain falls back to the files', async () => {
    const kc = keychainStub(NOT_FOUND);
    const { read: file, paths } = recordingReader(AUTH);
    const { fn, calls } = fakeFetch(LIVE_BODY);
    const snap = await adapter({ platform: 'darwin', readKeychain: kc.read, readTextFile: file, fetchFn: fn }).quota();
    expect(snap).not.toBeNull();
    expect(kc.calls()).toBe(1);
    expect(paths.length).toBeGreaterThan(0);
    expect(header(calls)).toBe(`Bearer ${TOKEN}`);
  });

  it('does not read the keychain under the file store (reads the files)', async () => {
    const kc = keychainStub(FOUND);
    const { read: file, paths } = recordingReader(AUTH);
    const { fn, calls } = fakeFetch(LIVE_BODY);
    const a = adapter({
      platform: 'darwin',
      env: { AGENT_CLI_CREDENTIAL_STORE: 'file' },
      readKeychain: kc.read,
      readTextFile: file,
      fetchFn: fn,
    });
    expect(await a.quota()).not.toBeNull();
    expect(kc.calls()).toBe(0);
    expect(paths.length).toBeGreaterThan(0);
    expect(header(calls)).toBe(`Bearer ${TOKEN}`);
  });

  it('does not read the keychain under the memory store, and makes no request', async () => {
    const kc = keychainStub(FOUND);
    const { fn, calls } = fakeFetch(LIVE_BODY);
    const a = adapter({
      platform: 'darwin',
      env: { AGENT_CLI_CREDENTIAL_STORE: 'memory' },
      readKeychain: kc.read,
      fetchFn: fn,
    });
    expect(await a.quota()).toBeNull();
    expect(kc.calls()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('does not read the keychain off darwin (reads the files)', async () => {
    const kc = keychainStub(FOUND);
    const { read: file, paths } = recordingReader(AUTH);
    const { fn, calls } = fakeFetch(LIVE_BODY);
    for (const platform of ['linux', 'win32'] as const) {
      const a = adapter({ platform, readKeychain: kc.read, readTextFile: file, fetchFn: fn });
      expect(await a.quota()).not.toBeNull();
    }
    expect(kc.calls()).toBe(0);
    expect(paths.length).toBeGreaterThan(0);
    expect(header(calls)).toBe(`Bearer ${TOKEN}`);
  });

  it('backs off for 6 h after an interaction refusal — no further keychain read, the files are still used', async () => {
    const t0 = Date.parse('2026-10-14T00:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const kc = keychainStub(REFUSED);
    const { read: file, paths } = recordingReader(AUTH);
    const a = adapter({ platform: 'darwin', readKeychain: kc.read, readTextFile: file, fetchFn: fakeFetch(LIVE_BODY).fn });

    expect(await a.quota()).not.toBeNull(); // refused → the files carry it
    expect(kc.calls()).toBe(1);
    const filesAfterFirst = paths.length;
    expect(filesAfterFirst).toBeGreaterThan(0);

    vi.setSystemTime(t0 + 5 * 60 * 60 * 1000 + 59 * 60 * 1000); // +5h59m: still inside the window
    expect(await a.quota()).not.toBeNull();
    expect(kc.calls()).toBe(1); // NOT read again
    expect(paths.length).toBeGreaterThan(filesAfterFirst); // but the files were

    vi.setSystemTime(t0 + 6 * 60 * 60 * 1000 + 1000); // past 6h: asked again
    expect(await a.quota()).not.toBeNull();
    expect(kc.calls()).toBe(2);
  });

  it('a keychain reader that throws falls back to the files and never breaks quota()', async () => {
    const throwing = async () => {
      throw new Error('spawn security EACCES');
    };
    const { read: file, paths } = recordingReader(AUTH);
    const { fn, calls } = fakeFetch(LIVE_BODY);
    const snap = await adapter({ platform: 'darwin', readKeychain: throwing, readTextFile: file, fetchFn: fn }).quota();
    expect(snap).not.toBeNull();
    expect(paths.length).toBeGreaterThan(0);
    expect(header(calls)).toBe(`Bearer ${TOKEN}`);
  });

  it('never lets the keychain token into the snapshot (deep search) — only the request header', async () => {
    const kc = keychainStub(FOUND);
    const { fn, calls } = fakeFetch(LIVE_BODY);
    const snap = await adapter({ platform: 'darwin', readKeychain: kc.read, readTextFile: recordingReader(null).read, fetchFn: fn }).quota();
    expect(snap).not.toBeNull();
    expect(deepStrings(snap)).not.toContain(KC_TOKEN);
    expect(JSON.stringify(snap)).not.toContain(KC_TOKEN);
    // It WAS used, exactly once, in the Authorization header and nowhere else.
    expect(header(calls)).toBe(`Bearer ${KC_TOKEN}`);
  });

  it('a non-2xx with a keychain token still resolves null, and leaks the token nowhere', async () => {
    const kc = keychainStub(FOUND);
    const { fn } = fakeFetch(LIVE_BODY, { ok: false, status: 401 });
    const snap = await adapter({ platform: 'darwin', readKeychain: kc.read, readTextFile: recordingReader(null).read, fetchFn: fn }).quota();
    expect(snap).toBeNull();
  });
});

describe('cursorAuthPaths()', () => {
  const WIN_HOME = 'C:\\Users\\u';

  it('darwin: ~/.cursor/auth.json first (the CLI file store), then the older ~/.config/cursor-agent/auth.json', () => {
    expect(cursorAuthPaths({}, 'darwin', '/Users/u')).toEqual([
      '/Users/u/.cursor/auth.json',
      '/Users/u/.config/cursor-agent/auth.json',
    ]);
  });

  it('darwin: XDG_CONFIG_HOME moves only the older path — the CLI ignores it on darwin', () => {
    expect(cursorAuthPaths({ XDG_CONFIG_HOME: '/xdg' }, 'darwin', '/Users/u')).toEqual([
      '/Users/u/.cursor/auth.json',
      '/xdg/cursor-agent/auth.json',
    ]);
  });

  it('linux (and every other non-win32 platform): $XDG_CONFIG_HOME|~/.config + /cursor, then /cursor-agent', () => {
    for (const platform of ['linux', 'freebsd', 'openbsd', 'sunos', 'aix'] as const) {
      expect(cursorAuthPaths({}, platform, '/home/u')).toEqual([
        '/home/u/.config/cursor/auth.json',
        '/home/u/.config/cursor-agent/auth.json',
      ]);
      expect(cursorAuthPaths({ XDG_CONFIG_HOME: '/xdg' }, platform, '/home/u')).toEqual([
        '/xdg/cursor/auth.json',
        '/xdg/cursor-agent/auth.json',
      ]);
    }
  });

  it('win32: %APPDATA%\\Cursor\\auth.json first, then %APPDATA%\\Cursor-agent\\auth.json (title-cased)', () => {
    expect(cursorAuthPaths({ APPDATA: 'D:\\Roam' }, 'win32', WIN_HOME)).toEqual([
      'D:\\Roam\\Cursor\\auth.json',
      'D:\\Roam\\Cursor-agent\\auth.json',
    ]);
  });

  it('win32: APPDATA unset → ~\\AppData\\Roaming; XDG_CONFIG_HOME is not consulted', () => {
    const roaming = win32.join(WIN_HOME, 'AppData', 'Roaming');
    const expected = [win32.join(roaming, 'Cursor', 'auth.json'), win32.join(roaming, 'Cursor-agent', 'auth.json')];
    expect(cursorAuthPaths({}, 'win32', WIN_HOME)).toEqual(expected);
    expect(cursorAuthPaths({ XDG_CONFIG_HOME: '/xdg' }, 'win32', WIN_HOME)).toEqual(expected);
  });

  it('treats an EMPTY XDG_CONFIG_HOME / APPDATA as unset (the CLI resolves both with ||)', () => {
    expect(cursorAuthPaths({ XDG_CONFIG_HOME: '' }, 'linux', '/home/u')).toEqual(cursorAuthPaths({}, 'linux', '/home/u'));
    expect(cursorAuthPaths({ XDG_CONFIG_HOME: '' }, 'darwin', '/Users/u')).toEqual(cursorAuthPaths({}, 'darwin', '/Users/u'));
    expect(cursorAuthPaths({ APPDATA: '' }, 'win32', WIN_HOME)).toEqual(cursorAuthPaths({}, 'win32', WIN_HOME));
  });

  it('ignores APPDATA off win32', () => {
    expect(cursorAuthPaths({ APPDATA: 'D:\\Roam' }, 'linux', '/home/u')).toEqual(cursorAuthPaths({}, 'linux', '/home/u'));
  });

  it('AGENT_CLI_CREDENTIAL_STORE=memory → no file to read, on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(cursorAuthPaths({ AGENT_CLI_CREDENTIAL_STORE: 'memory' }, platform, '/h')).toEqual([]);
    }
  });

  it('any other AGENT_CLI_CREDENTIAL_STORE value reads the files — matched exactly, as the CLI matches it', () => {
    for (const store of ['file', 'default', '', 'MEMORY', ' memory', 'memory ', 'keychain']) {
      expect(cursorAuthPaths({ AGENT_CLI_CREDENTIAL_STORE: store }, 'linux', '/home/u')).toEqual([
        '/home/u/.config/cursor/auth.json',
        '/home/u/.config/cursor-agent/auth.json',
      ]);
    }
  });
});

describe('quota() request', () => {
  it('POSTs {} to GetCurrentPeriodUsage with exactly the three Connect headers and an AbortSignal', async () => {
    const { fn, calls } = fakeFetch(LIVE_BODY);
    await adapter({ fetchFn: fn }).quota();
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(USAGE_URL);
    expect(init!.method).toBe('POST');
    expect(init!.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Connect-Protocol-Version': '1',
      'Content-Type': 'application/json',
    });
    expect(init!.body).toBe('{}');
    expect(JSON.parse(init!.body as string)).toEqual({});
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('quota() failures', () => {
  it('returns null on a non-2xx response, whatever its body', async () => {
    for (const status of [400, 401, 403, 415, 429, 500, 503]) {
      const { fn } = fakeFetch(LIVE_BODY, { ok: false, status });
      expect(await adapter({ fetchFn: fn }).quota()).toBeNull();
    }
  });

  it('returns null when the fetch throws (network error) or rejects synchronously', async () => {
    const rejecting = scriptedFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await adapter({ fetchFn: rejecting.fn }).quota()).toBeNull();
    const throwingSync = (() => {
      throw new TypeError('invalid header value');
    }) as unknown as typeof fetch;
    expect(await adapter({ fetchFn: throwingSync }).quota()).toBeNull();
  });

  it('returns null when the body is not JSON (json() rejects)', async () => {
    const { fn } = fakeFetch(undefined, {
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });
    expect(await adapter({ fetchFn: fn }).quota()).toBeNull();
  });

  it('resolves null within the deadline, and aborts the request, when the fetch never settles', async () => {
    const { fn, calls } = scriptedFetch(() => new Promise<Response>(() => {}));
    const start = Date.now();
    expect(await adapter({ fetchFn: fn, quotaTimeoutMs: 50 }).quota()).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000);
    expect((calls[0]!.init!.signal as AbortSignal).aborted).toBe(true);
  });

  it('resolves null within the deadline when the headers arrive but the body never ends', async () => {
    const { fn } = fakeFetch(undefined, { json: () => new Promise<unknown>(() => {}) });
    const start = Date.now();
    expect(await adapter({ fetchFn: fn, quotaTimeoutMs: 50 }).quota()).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('resolves null, never throws, when even resolving the login path fails', async () => {
    const hostileEnv = new Proxy({} as Record<string, string | undefined>, {
      get() {
        throw new Error('env is not readable');
      },
    });
    const { read, paths } = recordingReader(AUTH);
    await expect(adapter({ env: hostileEnv, readTextFile: read }).quota()).resolves.toBeNull();
    expect(paths).toHaveLength(0);
  });

  it('resolves null when the response object is not a Response at all', async () => {
    const bogus = (async () => ({ ok: true })) as unknown as typeof fetch;
    expect(await adapter({ fetchFn: bogus }).quota()).toBeNull();
  });
});
