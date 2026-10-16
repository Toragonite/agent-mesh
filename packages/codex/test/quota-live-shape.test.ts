import { afterEach, describe, it, expect, vi } from 'vitest';
import { CodexAdapter } from '../src/adapter.js';
import { recordingExec, fixedReader, fakeFetch } from './helpers.js';

const noExec = recordingExec().exec;
const TOKEN = 'SECRET_BEARER_XYZ';
const AUTH_WITH_TOKEN = JSON.stringify({ tokens: { access_token: TOKEN } });
const ACCOUNT = { vendor: 'codex', configDir: '/home/x' } as const;

/** The live wham/usage body: windows nested under `rate_limit`, `reset_at` in epoch seconds. */
const LIVE_BODY = {
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 23,
      limit_window_seconds: 18000,
      reset_after_seconds: 9876,
      reset_at: 1792000000,
    },
    secondary_window: {
      used_percent: 61,
      limit_window_seconds: 604800,
      reset_after_seconds: 345600,
      reset_at: 1792300000,
    },
  },
  credits: { has_credits: false, unlimited: false, balance: '0' },
};

function adapter(fetchFn: typeof fetch, quotaTimeoutMs?: number): CodexAdapter {
  return new CodexAdapter({
    exec: noExec,
    env: {},
    readTextFile: fixedReader(AUTH_WITH_TOKEN),
    fetchFn,
    ...(quotaTimeoutMs !== undefined ? { quotaTimeoutMs } : {}),
  });
}

async function quotaOf(body: unknown) {
  return adapter(fakeFetch(body).fn).quota(ACCOUNT);
}

/** A body in the live shape around the given `rate_limit` record. */
function live(rateLimit: Record<string, unknown>) {
  return { plan_type: 'plus', rate_limit: rateLimit, credits: { has_credits: false } };
}

/** A fetch fake whose response's json() is supplied by the test (reject, never settle, ...). */
function fetchWithJson(json: () => Promise<unknown>): typeof fetch {
  return (async () => ({ ok: true, status: 200, json }) as unknown as Response) as unknown as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('quota() — live nested rate_limit shape', () => {
  it('maps both windows from rate_limit, reset_at as epoch seconds, allowed verbatim, raw = whole body', async () => {
    const snap = await quotaOf(LIVE_BODY);
    expect(snap).toEqual({
      vendor: 'codex',
      windows: [
        { label: 'primary', usedPercent: 23, resetAt: new Date(1792000000 * 1000).toISOString() },
        { label: 'secondary', usedPercent: 61, resetAt: new Date(1792300000 * 1000).toISOString() },
      ],
      allowed: true,
      raw: LIVE_BODY,
    });
    expect(snap!.raw).toBe(LIVE_BODY);
    expect(JSON.stringify(snap)).not.toContain(TOKEN);
  });

  it('reads reset_at given in epoch ms (>= 1e12) as ms', async () => {
    const snap = await quotaOf(live({ allowed: true, primary_window: { used_percent: 5, reset_at: 1792000000000 } }));
    expect(snap!.windows[0]!.resetAt).toBe(new Date(1792000000000).toISOString());
  });

  it('falls back to capture time + reset_after_seconds when reset_at is absent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'));
    const snap = await quotaOf(
      live({
        allowed: true,
        primary_window: { used_percent: 10, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 20, reset_after_seconds: 0 },
      }),
    );
    expect(snap!.windows).toEqual([
      { label: 'primary', usedPercent: 10, resetAt: '2026-10-14T01:00:00.000Z' },
      { label: 'secondary', usedPercent: 20, resetAt: '2026-10-14T00:00:00.000Z' },
    ]);
  });

  it('prefers reset_at over reset_after_seconds, and falls through an unusable reset_at', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'));
    const both = await quotaOf(
      live({ allowed: true, primary_window: { used_percent: 1, reset_at: 1792000000, reset_after_seconds: 60 } }),
    );
    expect(both!.windows[0]!.resetAt).toBe(new Date(1792000000 * 1000).toISOString());
    for (const badResetAt of [0, -5, 'soon', null, 1e20]) {
      const snap = await quotaOf(
        live({ allowed: true, primary_window: { used_percent: 1, reset_at: badResetAt, reset_after_seconds: 60 } }),
      );
      expect(snap!.windows[0]!.resetAt).toBe('2026-10-14T00:01:00.000Z');
    }
  });

  it('leaves resetAt absent when neither reset_at nor a finite non-negative reset_after_seconds is given', async () => {
    for (const after of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, '3600', null]) {
      const snap = await quotaOf(live({ allowed: true, primary_window: { used_percent: 7, reset_after_seconds: after } }));
      expect(snap!.windows).toEqual([{ label: 'primary', usedPercent: 7 }]);
    }
  });

  it('trusts rate_limit.allowed:false verbatim even with headroom in every window', async () => {
    const snap = await quotaOf(
      live({ allowed: false, limit_reached: false, primary_window: { used_percent: 3 }, secondary_window: { used_percent: 4 } }),
    );
    expect(snap!.allowed).toBe(false);
  });

  it('derives allowed:false from limit_reached:true when allowed is absent', async () => {
    const snap = await quotaOf(live({ limit_reached: true, primary_window: { used_percent: 40 } }));
    expect(snap!.allowed).toBe(false);
  });

  it('derives allowed:true from limit_reached:false even against a 100% window (the vendor gate wins)', async () => {
    const snap = await quotaOf(live({ limit_reached: false, primary_window: { used_percent: 100 } }));
    expect(snap!.allowed).toBe(true);
  });

  it('lets an explicit allowed win over a contradicting limit_reached', async () => {
    const snap = await quotaOf(live({ allowed: true, limit_reached: true, primary_window: { used_percent: 1 } }));
    expect(snap!.allowed).toBe(true);
  });

  it('derives allowed from the windows when neither allowed nor limit_reached is a boolean', async () => {
    expect((await quotaOf(live({ allowed: 'yes', primary_window: { used_percent: 100 } })))!.allowed).toBe(false);
    expect((await quotaOf(live({ limit_reached: 0, primary_window: { used_percent: 99 } })))!.allowed).toBe(true);
  });

  it('clamps used_percent, and reports a sent window with a non-finite or missing value as 0', async () => {
    const snap = await quotaOf(
      live({ primary_window: { used_percent: 150 }, secondary_window: { used_percent: -3 } }),
    );
    expect(snap!.windows.map((w) => w.usedPercent)).toEqual([100, 0]);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '50', null, undefined]) {
      const one = await quotaOf(live({ allowed: true, primary_window: { used_percent: value } }));
      expect(one!.windows).toEqual([{ label: 'primary', usedPercent: 0 }]);
    }
  });

  it('leaves out a window that is not an object', async () => {
    const snap = await quotaOf(live({ allowed: true, primary_window: null, secondary_window: { used_percent: 9 } }));
    expect(snap!.windows).toEqual([{ label: 'secondary', usedPercent: 9 }]);
  });

  it('reads the nested record whole — top-level windows beside a recognized rate_limit are ignored', async () => {
    const snap = await quotaOf({
      ...live({ allowed: true, primary_window: { used_percent: 12 } }),
      allowed: false,
      secondary_window: { used_percent: 99 },
    });
    expect(snap!.allowed).toBe(true);
    expect(snap!.windows).toEqual([{ label: 'primary', usedPercent: 12 }]);
  });
});

describe('quota() — older top-level shape (fallback)', () => {
  it('still maps windows and allowed from the top level when there is no rate_limit', async () => {
    const snap = await quotaOf({
      allowed: true,
      primary_window: { used_percent: 37, reset_at: 1893456000 },
      secondary_window: { used_percent: 80 },
    });
    expect(snap!.windows).toEqual([
      { label: 'primary', usedPercent: 37, resetAt: new Date(1893456000 * 1000).toISOString() },
      { label: 'secondary', usedPercent: 80 },
    ]);
    expect(snap!.allowed).toBe(true);
  });

  it('falls back to the top level when rate_limit is null or carries nothing recognized', async () => {
    for (const rateLimit of [null, {}, 'limited', { plan: 'x' }]) {
      const snap = await quotaOf({ rate_limit: rateLimit, primary_window: { used_percent: 55 } });
      expect(snap!.windows).toEqual([{ label: 'primary', usedPercent: 55 }]);
      expect(snap!.allowed).toBe(true);
    }
  });
});

describe('quota() — failures', () => {
  it('returns null for a body with neither shape', async () => {
    expect(await quotaOf({ plan_type: 'plus', credits: { has_credits: true } })).toBeNull();
    expect(await quotaOf({ plan_type: 'plus', rate_limit: null, credits: null })).toBeNull();
    expect(await quotaOf({ rate_limit: {} })).toBeNull();
    expect(await quotaOf({ rate_limit: { used_percent: 50 } })).toBeNull();
    expect(await quotaOf({ rate_limit: { primary_window: 'nope' } })).toBeNull();
    expect(await quotaOf([LIVE_BODY])).toBeNull();
    expect(await quotaOf(null)).toBeNull();
    expect(await quotaOf('{"rate_limit":{}}')).toBeNull();
  });

  it('returns null on a non-2xx response even when its body is the live shape', async () => {
    const { fn } = fakeFetch(LIVE_BODY, false);
    expect(await adapter(fn).quota(ACCOUNT)).toBeNull();
  });

  it('returns null on malformed JSON (json() rejects)', async () => {
    const fn = fetchWithJson(async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    });
    expect(await adapter(fn).quota(ACCOUNT)).toBeNull();
  });

  it('returns null within the deadline when the fetch never settles, and aborts it', async () => {
    let signal: AbortSignal | undefined;
    const neverSettles = ((_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const start = Date.now();
    expect(await adapter(neverSettles, 50).quota(ACCOUNT)).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(signal?.aborted).toBe(true);
  });

  it('returns null within the deadline when the headers arrive but the body never ends', async () => {
    const fn = fetchWithJson(() => new Promise<unknown>(() => {}));
    const start = Date.now();
    expect(await adapter(fn, 50).quota(ACCOUNT)).toBeNull();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('returns null when the fetch rejects (network error)', async () => {
    const rejecting = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await adapter(rejecting).quota(ACCOUNT)).toBeNull();
  });
});
