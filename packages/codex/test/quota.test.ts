import { describe, it, expect } from 'vitest';
import { CodexAdapter } from '../src/adapter.js';
import { recordingExec, fixedReader, fakeFetch } from './helpers.js';

const noExec = recordingExec().exec;
const AUTH_WITH_TOKEN = JSON.stringify({ tokens: { access_token: 'SECRET_BEARER_XYZ' } });

describe('quota()', () => {
  it('maps the wham/usage body (windows, used_percent clamp, reset, allowed)', async () => {
    const body = {
      allowed: true,
      primary_window: { used_percent: 37, resets_at: 1893456000 },
      secondary_window: { used_percent: 150 },
    };
    const { fn, calls } = fakeFetch(body);
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(AUTH_WITH_TOKEN),
      fetchFn: fn,
    });
    const snap = await a.quota({ vendor: 'codex', configDir: '/home/x' });
    expect(snap).not.toBeNull();
    expect(snap!.vendor).toBe('codex');
    expect(snap!.allowed).toBe(true);
    expect(snap!.windows[0]).toMatchObject({ label: 'primary', usedPercent: 37 });
    expect(snap!.windows[0]!.resetAt).toBe(new Date(1893456000 * 1000).toISOString());
    expect(snap!.windows[1]).toMatchObject({ label: 'secondary', usedPercent: 100 });

    // token used as the bearer, but NEVER present in the returned snapshot.
    const init = calls[0]!.init as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer SECRET_BEARER_XYZ');
    expect(JSON.stringify(snap)).not.toContain('SECRET_BEARER_XYZ');
  });

  it('sends chatgpt-account-id from tokens.account_id, and omits it when absent', async () => {
    const withAccount = JSON.stringify({
      tokens: { access_token: 'SECRET_BEARER_XYZ', account_id: 'acct-uuid-1234' },
    });
    const first = fakeFetch({ allowed: true });
    await new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(withAccount),
      fetchFn: first.fn,
    }).quota({ vendor: 'codex', configDir: '/home/x' });
    const withHeaders = first.calls[0]!.init as { headers: Record<string, string> };
    expect(withHeaders.headers['chatgpt-account-id']).toBe('acct-uuid-1234');

    const second = fakeFetch({ allowed: true });
    await new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(AUTH_WITH_TOKEN),
      fetchFn: second.fn,
    }).quota({ vendor: 'codex', configDir: '/home/x' });
    const withoutHeaders = second.calls[0]!.init as { headers: Record<string, string> };
    expect(withoutHeaders.headers['chatgpt-account-id']).toBeUndefined();
  });

  it('returns null when auth.json is missing', async () => {
    const { fn } = fakeFetch({});
    const a = new CodexAdapter({ exec: noExec, env: {}, readTextFile: fixedReader(null), fetchFn: fn });
    expect(await a.quota({ vendor: 'codex', configDir: '/home/x' })).toBeNull();
  });

  it('returns null when no token can be extracted', async () => {
    const { fn } = fakeFetch({ allowed: true });
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(JSON.stringify({ tokens: {} })),
      fetchFn: fn,
    });
    expect(await a.quota({ vendor: 'codex', configDir: '/home/x' })).toBeNull();
  });

  it('returns null on a non-2xx response', async () => {
    const { fn } = fakeFetch({ allowed: false }, false);
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(AUTH_WITH_TOKEN),
      fetchFn: fn,
    });
    expect(await a.quota({ vendor: 'codex', configDir: '/home/x' })).toBeNull();
  });

  it('returns null when a 200 body carries no recognized quota field ({}) (L1)', async () => {
    const { fn } = fakeFetch({});
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(AUTH_WITH_TOKEN),
      fetchFn: fn,
    });
    expect(await a.quota({ vendor: 'codex', configDir: '/home/x' })).toBeNull();
  });

  it('returns null when a 200 body is an unrelated JSON shape (L1)', async () => {
    const { fn } = fakeFetch({ error: 'nope', detail: 'unexpected' });
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(AUTH_WITH_TOKEN),
      fetchFn: fn,
    });
    expect(await a.quota({ vendor: 'codex', configDir: '/home/x' })).toBeNull();
  });
});

describe('quota() allowed derivation (A2)', () => {
  it('derives allowed=false when allowed is absent and a window is fully consumed', async () => {
    const { fn } = fakeFetch({ primary_window: { used_percent: 100 } });
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(AUTH_WITH_TOKEN),
      fetchFn: fn,
    });
    const snap = await a.quota({ vendor: 'codex', configDir: '/home/x' });
    expect(snap).not.toBeNull();
    expect(snap!.allowed).toBe(false);
  });

  it('derives allowed=true when allowed is absent and all windows have headroom', async () => {
    const { fn } = fakeFetch({
      primary_window: { used_percent: 42 },
      secondary_window: { used_percent: 80 },
    });
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(AUTH_WITH_TOKEN),
      fetchFn: fn,
    });
    const snap = await a.quota({ vendor: 'codex', configDir: '/home/x' });
    expect(snap!.allowed).toBe(true);
  });

  it('trusts an explicit allowed verbatim even against a fully-consumed window', async () => {
    const { fn } = fakeFetch({ allowed: true, primary_window: { used_percent: 100 } });
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(AUTH_WITH_TOKEN),
      fetchFn: fn,
    });
    const snap = await a.quota({ vendor: 'codex', configDir: '/home/x' });
    expect(snap!.allowed).toBe(true);
  });
});

describe('quota() fetch deadline (A3)', () => {
  it('resolves null within the deadline when the fetch never settles', async () => {
    const neverSettles = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(AUTH_WITH_TOKEN),
      fetchFn: neverSettles,
      quotaTimeoutMs: 50,
    });
    const start = Date.now();
    const snap = await a.quota({ vendor: 'codex', configDir: '/home/x' });
    expect(snap).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('passes an AbortSignal to the fetch seam', async () => {
    const { fn, calls } = fakeFetch({ allowed: true });
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(AUTH_WITH_TOKEN),
      fetchFn: fn,
    });
    await a.quota({ vendor: 'codex', configDir: '/home/x' });
    const init = calls[0]!.init as { signal?: unknown };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
