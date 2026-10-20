import { afterAll, describe, it, expect, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account } from '@toragonite/agent-mesh';
import { GeminiAdapter, type GeminiAdapterOptions } from '../src/adapter.js';
import { nodeExec, type ExecFn, type ExecRequest, type ExecResult } from '../src/exec.js';
import { ensurePrivateDir, MAX_USAGE_STDOUT_BYTES, USAGE_DIR_NAME, usageCwd, usageDirName } from '../src/quota.js';
import { recordingExec, jsonl } from './helpers.js';

// Most tests here drive a FAKE `agy`: a small node script written to a temp dir and
// handed to the adapter as its binary, started through the adapter's own `exec` seam
// (the real nodeExec, wrapped to record each request). The real agy is never run, no
// network is touched, no credential store is read, and each fake gets the synthetic
// env below.

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------- *
 * Payloads
 * ------------------------------------------------------------------------- */

/** `command.data` of the live answer captured on agy 1.3.5 (2026-10-15), verbatim in shape. */
const LIVE_DATA = {
  groups: [
    {
      name: 'Gemini Models',
      buckets: [
        {
          id: 'gemini-weekly',
          name: 'Weekly Limit Remaining',
          window: 'weekly',
          remaining_fraction: 0.9996928572654724,
          reset_time: '2026-10-20T07:57:54Z',
        },
        {
          id: 'gemini-5h',
          name: 'Five Hour Limit Remaining',
          window: '5h',
          remaining_fraction: 1,
          reset_time: '2026-10-15T15:10:03Z',
        },
      ],
    },
    {
      name: 'Claude and GPT models',
      buckets: [
        {
          id: '3p-weekly',
          name: 'Weekly Limit Remaining',
          window: 'weekly',
          remaining_fraction: 1,
          reset_time: '2026-10-22T10:10:03Z',
        },
        {
          id: '3p-5h',
          name: 'Five Hour Limit Remaining',
          window: '5h',
          remaining_fraction: 1,
          reset_time: '2026-10-15T15:10:03Z',
        },
      ],
    },
  ],
};

/** The whole `agy -p /usage --output-format json` object around a `command.data`. */
function usagePayload(data: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation_id: '7f1c0a52-usage',
    status: 'SUCCESS',
    response: 'Usage summary',
    duration_seconds: 2.41,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    command: { name: 'usage', data },
    ...overrides,
  };
}

/** A one-group `command.data` holding the given buckets. */
function groupOf(buckets: unknown[], name = 'Gemini Models'): { groups: unknown[] } {
  return { groups: [{ name, buckets }] };
}

/** A minimal usable bucket. */
function bucket(id: string, remaining_fraction: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: `${id} name`, window: 'weekly', remaining_fraction, ...extra };
}

const LIVE_STDOUT = JSON.stringify(usagePayload(LIVE_DATA)) + '\n';

/* ------------------------------------------------------------------------- *
 * The fake agy
 * ------------------------------------------------------------------------- */

type FakeEvent = { kind: string; [k: string]: unknown };

interface FakeAgy {
  bin: string;
  events(): FakeEvent[];
  starts(): FakeEvent[];
}

/**
 * Write a fake agy. Its preamble logs one `start` event (pid, argv, cwd, env, and what
 * its stdin is: `char` for the null device, `pipe` for a pipe). `scenario` is JS that
 * may use `out(s)`, `err(s)`, `json(o)`, `log(o)`, and sets `process.exitCode` — never
 * `process.exit()`, which can cut a pipe write short on macOS.
 */
function fakeAgy(scenario: string): FakeAgy {
  const dir = mkdtempSync(join(tmpdir(), 'agent-mesh-fake-agy-'));
  dirs.push(dir);
  const logPath = join(dir, 'log.jsonl');
  const bin = join(dir, 'agy');
  const source = `#!${process.execPath}
'use strict';
const fs = require('fs');
const LOG = ${JSON.stringify(logPath)};
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\\n');
let stdin = 'unknown';
try {
  const st = fs.fstatSync(0);
  stdin = st.isFIFO() ? 'pipe' : st.isCharacterDevice() ? 'char' : st.isFile() ? 'file' : 'other';
} catch (e) {
  stdin = 'closed';
}
log({ kind: 'start', pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, stdin });
const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);
const json = (o) => out(JSON.stringify(o) + '\\n');
${scenario}
`;
  writeFileSync(bin, source);
  chmodSync(bin, 0o755);
  const events = (): FakeEvent[] =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => JSON.parse(l) as FakeEvent)
      : [];
  return { bin, events, starts: () => events().filter((e) => e.kind === 'start') };
}

/** A scenario that prints `stdout` / `stderr` after `delayMs`, then exits with `exit`. */
function answers(stdout: string, opts: { exit?: number; stderr?: string; delayMs?: number } = {}): string {
  return `
setTimeout(() => {
  err(${JSON.stringify(opts.stderr ?? '')});
  out(${JSON.stringify(stdout)});
  process.exitCode = ${opts.exit ?? 0};
}, ${opts.delayMs ?? 0});`;
}

/** The real nodeExec, wrapped so every request the adapter makes is recorded. */
function recordingNodeExec(): { exec: ExecFn; calls: ExecRequest[] } {
  const calls: ExecRequest[] = [];
  return {
    exec: (req) => {
      calls.push(req);
      return nodeExec(req);
    },
    calls,
  };
}

/** An adapter over a fake agy, through the recorded real seam. Cache off unless asked. */
function adapterFor(bin: string, opts: Partial<GeminiAdapterOptions> = {}) {
  const seam = recordingNodeExec();
  const adapter = new GeminiAdapter({
    exec: seam.exec,
    binary: bin,
    env: {},
    quotaCacheMs: 0,
    quotaTimeoutMs: 20_000,
    ...opts,
  });
  return { adapter, calls: seam.calls };
}

/** quota() of a fake agy that runs `scenario`. */
async function quotaOf(scenario: string, opts: Partial<GeminiAdapterOptions> = {}) {
  const fake = fakeAgy(scenario);
  const { adapter, calls } = adapterFor(fake.bin, opts);
  const snap = await adapter.quota();
  return { snap, fake, calls };
}

/** quota() of a fake agy that prints a usage answer around `data`. */
async function quotaOfData(data: unknown) {
  return (await quotaOf(answers(JSON.stringify(usagePayload(data))))).snap;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Poll until `pid` is gone. */
async function gone(pid: number, withinMs = 5000): Promise<boolean> {
  const end = Date.now() + withinMs;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A `#!<node>` fake needs a POSIX exec and a shebang-safe node path (as the codex fakes do). */
const NO_FAKE_AGY = process.platform === 'win32' || process.execPath.includes(' ');

/* ------------------------------------------------------------------------- *
 * Capability and the seam (no process)
 * ------------------------------------------------------------------------- */

describe('quota() capability and seam', () => {
  it('advertises capabilities.quota true', () => {
    const a = new GeminiAdapter({ exec: recordingExec().exec, env: {} });
    expect(a.capabilities).toEqual({ resume: true, steer: 'turn', peerMesh: false, quota: true, stream: true });
  });

  it('starts agy through the injected exec seam with the pinned request (no direct child_process)', async () => {
    // The seam returns a canned answer and starts nothing: a snapshot can only come from it.
    const { exec, calls } = recordingExec({ stdout: LIVE_STDOUT });
    const a = new GeminiAdapter({ exec, binary: '/opt/agy/bin/agy', env: {}, quotaCacheMs: 0 });
    const snap = await a.quota();
    expect(snap?.windows.map((w) => w.label)).toEqual(['gemini-weekly', 'gemini-5h', '3p-weekly', '3p-5h']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cmd: '/opt/agy/bin/agy',
      args: ['-p', '/usage', '--output-format', 'json'],
      cwd: join(tmpdir(), usageDirName()),
      env: {},
      timeoutMs: 90_000,
      ignoreStdin: true,
      maxStdoutBytes: 1_048_576,
    });
    expect(usageCwd()).toBe(join(tmpdir(), usageDirName()));
  });

  it('no module on the quota path imports child_process — the seam is the only spawner', () => {
    const src = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');
    const imports = /from\s+['"](node:)?child_process['"]|require\(\s*['"](node:)?child_process['"]\s*\)/;
    expect(src('quota.ts')).not.toMatch(imports);
    expect(src('adapter.ts')).not.toMatch(imports);
  });

  it('uses the account env exactly as run() builds it', async () => {
    const { exec, calls } = recordingExec({ stdout: jsonl({ conversation_id: 'c1', status: 'SUCCESS', response: 'ok' }) });
    const a = new GeminiAdapter({ exec, env: { KEEP: 'yes', PATH: '/usr/bin' }, quotaCacheMs: 0 });
    const account: Account = { vendor: 'gemini', configDir: '/acct/home' };
    await a.run({ prompt: 'hi', account });
    await a.quota(account);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.env).toEqual(calls[0]!.env);
    expect(calls[1]!.env).toEqual({ KEEP: 'yes', PATH: '/usr/bin', AGY_HOME: '/acct/home' });
  });

  it('follows run()’s account precedence: defaultAccount when none is passed, ambient for an explicit account without configDir', async () => {
    const { exec, calls } = recordingExec({ stdout: '' });
    const a = new GeminiAdapter({
      exec,
      env: {},
      defaultAccount: { vendor: 'gemini', configDir: '/default/home' },
      quotaCacheMs: 0,
    });
    await a.quota();
    await a.quota({ vendor: 'gemini' });
    await a.quota(null as never);
    expect(calls.map((c) => c.env?.AGY_HOME)).toEqual(['/default/home', undefined, '/default/home']);
  });

  it('defaults the timeout to 90 s, honours an override, and never runs unbounded', async () => {
    const timeouts: Array<number | undefined> = [];
    for (const quotaTimeoutMs of [undefined, 1234, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { exec, calls } = recordingExec({ stdout: '' });
      await new GeminiAdapter({ exec, env: {}, quotaCacheMs: 0, quotaTimeoutMs }).quota();
      timeouts.push(calls[0]!.timeoutMs);
    }
    expect(timeouts).toEqual([90_000, 1234, 90_000, 90_000, 90_000, 90_000]);
  });

  it('never throws: a seam that throws, rejects, or returns garbage resolves null', async () => {
    const throwing: ExecFn = () => {
      throw new Error('boom');
    };
    const rejecting: ExecFn = async () => {
      throw Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' });
    };
    const garbage: ExecFn = async () => ({ stdout: undefined, stderr: null, exitCode: 0, timedOut: false }) as never;
    for (const exec of [throwing, rejecting, garbage]) {
      await expect(new GeminiAdapter({ exec, env: {}, quotaCacheMs: 0 }).quota()).resolves.toBeNull();
    }
  });

  it('a host seam that ignores maxStdoutBytes: a valid answer over 1 MiB is still null', async () => {
    const big = usagePayload({ ...LIVE_DATA, description: 'x'.repeat(MAX_USAGE_STDOUT_BYTES) });
    const { exec } = recordingExec({ stdout: JSON.stringify(big) });
    await expect(new GeminiAdapter({ exec, env: {}, quotaCacheMs: 0 }).quota()).resolves.toBeNull();
    // A seam that reports the overflow is believed even when the bytes it kept parse.
    const flagged = recordingExec({ stdout: LIVE_STDOUT, stdoutOverflow: true });
    await expect(new GeminiAdapter({ exec: flagged.exec, env: {}, quotaCacheMs: 0 }).quota()).resolves.toBeNull();
  });

  it('a seam that never settles: the caller gets null after quotaTimeoutMs + the settle grace, and no second agy starts', async () => {
    const calls: ExecRequest[] = [];
    let called!: () => void;
    const wasCalled = new Promise<void>((r) => {
      called = r;
    });
    const exec: ExecFn = (req) => {
      calls.push(req);
      called();
      return new Promise<ExecResult>(() => {});
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const a = new GeminiAdapter({ exec, env: {}, quotaTimeoutMs: 1_000, quotaCacheMs: 0 });
      const first = a.quota();
      await wasCalled;
      await vi.advanceTimersByTimeAsync(1_000 + 10_000);
      await expect(first).resolves.toBeNull();
      // The stuck read is still in flight: a later caller joins it instead of starting another agy.
      const second = a.quota();
      await vi.advanceTimersByTimeAsync(1_000 + 10_000);
      await expect(second).resolves.toBeNull();
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * The private working directory
 * ------------------------------------------------------------------------- */

describe.skipIf(process.platform === 'win32')('the private working directory', () => {
  function base(): string {
    const d = mkdtempSync(join(tmpdir(), 'agent-mesh-privdir-'));
    dirs.push(d);
    return d;
  }

  it('is created 0700', async () => {
    const dir = join(base(), 'usage');
    expect(await ensurePrivateDir(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('an existing directory we own with group/other bits is tightened to 0700', async () => {
    const dir = join(base(), 'usage');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    expect(await ensurePrivateDir(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('a symlink is refused, even to a private directory; so is a regular file', async () => {
    const b = base();
    const target = join(b, 'target');
    mkdirSync(target, { mode: 0o700 });
    const link = join(b, 'usage');
    symlinkSync(target, link);
    expect(await ensurePrivateDir(link)).toBe(false);
    const file = join(b, 'file');
    writeFileSync(file, '');
    expect(await ensurePrivateDir(file)).toBe(false);
  });

  it('quota() refuses to start agy when the per-user path is not private, and spawns nothing', async () => {
    const b = base();
    const target = join(b, 'elsewhere');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(b, usageDirName()));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = b; // os.tmpdir() reads it at call time
    try {
      const { exec, calls } = recordingExec({ stdout: LIVE_STDOUT });
      await expect(new GeminiAdapter({ exec, env: {}, quotaCacheMs: 0 }).quota()).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});

/* ------------------------------------------------------------------------- *
 * The per-user directory name (0.1.4)
 * ------------------------------------------------------------------------- */

/** Run `fn` with os.tmpdir() pointing at `dir` (it reads TMPDIR at call time). */
async function withTmpdir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

describe('the per-user usage directory name (0.1.4)', () => {
  it('keeps USAGE_DIR_NAME as the prefix', () => {
    expect(USAGE_DIR_NAME).toBe('agent-mesh-agy-usage');
    expect(usageDirName().startsWith(`${USAGE_DIR_NAME}-`)).toBe(true);
    expect(usageCwd()).toBe(join(tmpdir(), usageDirName()));
  });

  it.skipIf(typeof process.getuid !== 'function')('is agent-mesh-agy-usage-<uid> where process.getuid exists', () => {
    expect(usageDirName()).toBe(`agent-mesh-agy-usage-${process.getuid!()}`);
    const spy = vi.spyOn(process as { getuid: () => number }, 'getuid').mockReturnValue(4242);
    try {
      expect(usageDirName()).toBe('agent-mesh-agy-usage-4242');
    } finally {
      spy.mockRestore();
    }
  });

  it('without process.getuid: a sanitized username — one path component, never blank', () => {
    const saved = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true, writable: true });
    try {
      const name = usageDirName();
      expect(name).toMatch(/^agent-mesh-agy-usage-[A-Za-z0-9._-]{1,64}$/);
      expect(name).not.toMatch(/-\.+$/);
      // The OS username (when it is already safe) is used verbatim.
      let username = '';
      try {
        username = userInfo().username;
      } catch {
        username = '';
      }
      if (/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(username)) {
        expect(name).toBe(`agent-mesh-agy-usage-${username}`);
      }
    } finally {
      if (saved) Object.defineProperty(process, 'getuid', saved);
      else delete (process as { getuid?: unknown }).getuid;
    }
    expect(typeof process.getuid).toBe(saved ? typeof saved.value : 'undefined');
  });

  it.skipIf(process.platform === 'win32')(
    "another user's directory at the shared name no longer blocks the read; a foreign one at OUR name still refuses",
    async () => {
      const b = mkdtempSync(join(tmpdir(), 'agent-mesh-peruser-'));
      dirs.push(b);
      // The pre-0.1.4 shared name, taken by "someone else": a symlink we must never follow.
      const elsewhere = join(b, 'elsewhere');
      mkdirSync(elsewhere, { mode: 0o700 });
      symlinkSync(elsewhere, join(b, USAGE_DIR_NAME));
      await withTmpdir(b, async () => {
        const { exec, calls } = recordingExec({ stdout: LIVE_STDOUT });
        const snap = await new GeminiAdapter({ exec, env: {}, quotaCacheMs: 0 }).quota();
        expect(snap).not.toBeNull();
        expect(calls).toHaveLength(1);
        expect(calls[0]!.cwd).toBe(join(b, usageDirName()));
        expect(statSync(join(b, usageDirName())).mode & 0o777).toBe(0o700);
      });

      // Simulate a directory at OUR per-user name that is owned by someone else: the uid the
      // process reports is not the directory's owner. It is refused, and nothing spawns.
      const c = mkdtempSync(join(tmpdir(), 'agent-mesh-peruser-'));
      dirs.push(c);
      const realUid = process.getuid!();
      const otherUid = realUid + 1;
      const spy = vi.spyOn(process as { getuid: () => number }, 'getuid').mockReturnValue(otherUid);
      try {
        expect(usageDirName()).toBe(`agent-mesh-agy-usage-${otherUid}`);
        mkdirSync(join(c, usageDirName()), { mode: 0o700 }); // owned by realUid, not "us"
        expect(await ensurePrivateDir(join(c, usageDirName()))).toBe(false);
        await withTmpdir(c, async () => {
          const { exec, calls } = recordingExec({ stdout: LIVE_STDOUT });
          await expect(new GeminiAdapter({ exec, env: {}, quotaCacheMs: 0 }).quota()).resolves.toBeNull();
          expect(calls).toHaveLength(0);
        });
      } finally {
        spy.mockRestore();
      }
    },
  );
});

/* ------------------------------------------------------------------------- *
 * Through a fake agy: mapping
 * ------------------------------------------------------------------------- */

describe.skipIf(NO_FAKE_AGY)('quota() mapping, through a fake agy', { timeout: 30_000 }, () => {
  it('maps the live sample: 4 windows with exact usedPercent / resetAt, allowed, raw = command.data', async () => {
    const { snap, fake, calls } = await quotaOf(answers(LIVE_STDOUT));
    expect(snap).toEqual({
      vendor: 'gemini',
      windows: [
        { label: 'gemini-weekly', usedPercent: 0, resetAt: '2026-10-20T07:57:54.000Z' },
        { label: 'gemini-5h', usedPercent: 0, resetAt: '2026-10-15T15:10:03.000Z' },
        { label: '3p-weekly', usedPercent: 0, resetAt: '2026-10-22T10:10:03.000Z' },
        { label: '3p-5h', usedPercent: 0, resetAt: '2026-10-15T15:10:03.000Z' },
      ],
      allowed: true,
      raw: LIVE_DATA,
    });
    expect(snap).not.toHaveProperty('capturedAt');
    // 0.9996928572654724 remaining → 0.0307% used → 0 at one decimal (and +0, not -0).
    expect(Object.is(snap!.windows[0]!.usedPercent, 0)).toBe(true);
    expect(Object.is(snap!.windows[1]!.usedPercent, 0)).toBe(true);

    // What agy was given: the pinned argv, the private cwd, the null device on stdin.
    const start = fake.starts()[0]!;
    expect(start.argv).toEqual(['-p', '/usage', '--output-format', 'json']);
    expect(start.cwd).toBe(realpathSync(usageCwd()));
    expect(start.stdin).toBe('char');
    expect(statSync(usageCwd()).mode & 0o777).toBe(0o700);
    expect(calls).toHaveLength(1);
  });

  it('rounds float32 noise to one decimal', async () => {
    const snap = await quotaOfData(
      groupOf([bucket('a', 0.93780001), bucket('b', 0.33333334), bucket('c', 0.25), bucket('d', 0.9999999)]),
    );
    expect(snap!.windows.map((w) => w.usedPercent)).toEqual([6.2, 66.7, 75, 0]);
  });

  it('a fraction of exactly 0 is 100% used, and gates allowed:false', async () => {
    const snap = await quotaOfData(groupOf([bucket('a', 0.5), bucket('b', 0)]));
    expect(snap!.windows).toEqual([
      { label: 'a', usedPercent: 50 },
      { label: 'b', usedPercent: 100 },
    ]);
    expect(snap!.allowed).toBe(false);
  });

  it('every window exhausted → allowed false', async () => {
    const snap = await quotaOfData({
      groups: [
        { name: 'Gemini Models', buckets: [bucket('gemini-weekly', 0), bucket('gemini-5h', 0)] },
        { name: 'Claude and GPT models', buckets: [bucket('3p-weekly', 0), bucket('3p-5h', 0)] },
      ],
    });
    expect(snap!.windows.map((w) => w.usedPercent)).toEqual([100, 100, 100, 100]);
    expect(snap!.allowed).toBe(false);
  });

  it('allowed is per model group: an exhausted Claude/GPT group does not shut out Gemini work', async () => {
    const snap = await quotaOfData({
      groups: [
        { name: 'Gemini Models', buckets: [bucket('gemini-weekly', 0.4), bucket('gemini-5h', 0.9)] },
        { name: 'Claude and GPT models', buckets: [bucket('3p-weekly', 0.2), bucket('3p-5h', 0)] },
      ],
    });
    expect(snap!.windows.map((w) => w.usedPercent)).toEqual([60, 10, 80, 100]);
    expect(snap!.allowed).toBe(true);
  });

  it('skips a bucket with only remaining_amount, or neither — amount 0 with no fraction is unknown, not exhausted', async () => {
    const snap = await quotaOfData(
      groupOf([
        { id: 'amount-only', window: 'weekly', remaining_amount: 120 },
        { id: 'zero-amount', window: '5h', remaining_amount: 0 },
        { id: 'neither', window: '5h' },
        bucket('fraction', 0.8),
      ]),
    );
    expect(snap!.windows.map((w) => w.label)).toEqual(['fraction']);
    expect(snap!.allowed).toBe(true); // the 0 amount did NOT read as exhausted

    // Nothing but amounts → no usable window → null.
    expect(await quotaOfData(groupOf([{ id: 'x', remaining_amount: 0 }, { id: 'y', remaining_amount: 5 }]))).toBeNull();
  });

  it('skips disabled buckets (only disabled: true)', async () => {
    const snap = await quotaOfData(
      groupOf([bucket('off', 0, { disabled: true }), bucket('on', 0.4, { disabled: false }), bucket('plain', 0.9)]),
    );
    expect(snap!.windows.map((w) => w.label)).toEqual(['on', 'plain']);
    expect(snap!.allowed).toBe(true); // the exhausted bucket was disabled
  });

  it('a fraction above 1 is not a fraction (skipped); below 0 clamps to 100; non-numbers are skipped', async () => {
    const snap = await quotaOfData(
      groupOf([
        bucket('percent-not-fraction', 99.97),
        bucket('just-over-one', 1.0000001),
        bucket('over-consumed', -0.2),
        bucket('string', '0.5'),
        bucket('null', null),
        bucket('bool', true),
      ]),
    );
    expect(snap!.windows).toEqual([
      { label: 'just-over-one', usedPercent: 0 },
      { label: 'over-consumed', usedPercent: 100 },
    ]);
    expect(Object.is(snap!.windows[0]!.usedPercent, 0)).toBe(true);
  });

  it('labels: id, else "<group name> <window>", else the bucket name, else "usage"', async () => {
    const snap = await quotaOfData({
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 1 },
            { window: 'weekly', remaining_fraction: 1 },
            { id: '   ', window: '5h', remaining_fraction: 1 },
            { name: 'Some Limit', remaining_fraction: 1 },
          ],
        },
        { buckets: [{ name: 'Nameless Group Limit', remaining_fraction: 1 }, { remaining_fraction: 1 }] },
      ],
    });
    expect(snap!.windows.map((w) => w.label)).toEqual([
      'gemini-weekly',
      'Gemini Models weekly',
      'Gemini Models 5h',
      'Gemini Models',
      'Nameless Group Limit',
      'usage',
    ]);
  });

  it('resetAt: an RFC 3339 instant normalised to ISO; anything else (or an unset zero time) is left out', async () => {
    const reset = (reset_time: unknown) => bucket('w', 1, { reset_time });
    const snap = await quotaOfData(
      groupOf([
        reset('2026-10-20T09:57:54+02:00'),
        reset('2026-10-20T07:57:54.123456Z'),
        reset('soon'),
        reset('1'),
        reset('2026-10-20'),
        reset('0001-01-01T00:00:00Z'),
        reset(1787443666),
        reset('2026-13-45T99:99:99Z'),
      ]),
    );
    expect(snap!.windows.map((w) => w.resetAt)).toEqual([
      '2026-10-20T07:57:54.000Z',
      '2026-10-20T07:57:54.123Z',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(snap!.windows.filter((w) => 'resetAt' in w)).toHaveLength(2);
  });

  it('keeps groups in order, then buckets in order; skips a malformed group or bucket', async () => {
    const snap = await quotaOfData({
      groups: [
        'not a group',
        { name: 'No buckets' },
        { name: 'G1', buckets: [bucket('g1-a', 1), 'not a bucket', null, bucket('g1-b', 0.5)] },
        { name: 'G2', buckets: [bucket('g2-a', 0.1)] },
      ],
    });
    expect(snap!.windows.map((w) => w.label)).toEqual(['g1-a', 'g1-b', 'g2-a']);
  });
});

/* ------------------------------------------------------------------------- *
 * Through a fake agy: every failure is null
 * ------------------------------------------------------------------------- */

describe.skipIf(NO_FAKE_AGY)('quota() failures, through a fake agy — all null', { timeout: 30_000 }, () => {
  it('status other than SUCCESS', async () => {
    for (const status of ['ERROR', 'success', '', undefined]) {
      const out = JSON.stringify(usagePayload(LIVE_DATA, { status }));
      expect((await quotaOf(answers(out))).snap).toBeNull();
    }
  });

  it('a non-zero exit, even with a valid answer on stdout (1, 2 usage, 3 agent/API)', async () => {
    for (const exit of [1, 2, 3]) {
      expect((await quotaOf(answers(LIVE_STDOUT, { exit }))).snap).toBeNull();
    }
    const usage = await quotaOf(answers('', { exit: 2, stderr: 'Usage: agy [flags]\nerror: unknown flag --output-format\n' }));
    expect(usage.snap).toBeNull();
  });

  it('an AGY_ERROR line — with a failing exit, and even beside a valid answer with exit 0', async () => {
    const line = 'AGY_ERROR: {"code":"UNAVAILABLE","message":"quota service unavailable"}\n';
    expect((await quotaOf(answers('', { exit: 3, stderr: line }))).snap).toBeNull();
    expect((await quotaOf(answers(LIVE_STDOUT, { stderr: line }))).snap).toBeNull();
    expect((await quotaOf(answers(line + LIVE_STDOUT))).snap).toBeNull(); // on stdout too
  });

  it('an "error:" line beside a valid answer', async () => {
    expect((await quotaOf(answers(LIVE_STDOUT, { stderr: 'error: failed to start language server\n' }))).snap).toBeNull();
  });

  it('not logged in, no terminal: the authentication-required text', async () => {
    const text = "Error: authentication required. Run 'agy' to log in.\n";
    expect((await quotaOf(answers('', { exit: 1, stderr: text }))).snap).toBeNull();
    expect((await quotaOf(answers(text))).snap).toBeNull(); // same text on stdout, exit 0
    expect((await quotaOf(answers(text + LIVE_STDOUT))).snap).toBeNull(); // even before a valid answer
  });

  it('an API-key / ADC session: "no quota summary is available for this account"', async () => {
    const text = 'no quota summary is available for this account';
    expect((await quotaOf(answers(text + '\n'))).snap).toBeNull();
    expect((await quotaOf(answers('', { exit: 1, stderr: text + '\n' }))).snap).toBeNull();
    const asPayload = JSON.stringify(usagePayload({ groups: [] }, { response: text }));
    expect((await quotaOf(answers(asPayload))).snap).toBeNull();
    const noCommand = JSON.stringify({ status: 'SUCCESS', response: text, num_turns: 0 });
    expect((await quotaOf(answers(noCommand))).snap).toBeNull();
  });

  it('malformed or other-shaped JSON', async () => {
    const outs = [
      '',
      '{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[',
      '[1,2,3]',
      '"SUCCESS"',
      JSON.stringify(usagePayload(LIVE_DATA, { command: { name: 'help', data: LIVE_DATA } })),
      JSON.stringify(usagePayload(LIVE_DATA, { command: { data: LIVE_DATA } })),
      JSON.stringify(usagePayload({ groups: { 0: LIVE_DATA.groups[0] } })),
      JSON.stringify(usagePayload(null)),
      JSON.stringify(usagePayload(LIVE_DATA, { command: 'usage' })),
      // A normal agent answer (what `-p` prints when no slash command ran).
      JSON.stringify({ conversation_id: 'c1', status: 'SUCCESS', response: 'Here is your usage…', num_turns: 1 }),
    ];
    for (const out of outs) {
      expect((await quotaOf(answers(out))).snap).toBeNull();
    }
  });

  it('more than 1 MiB of stdout — a valid answer padded past the cap', async () => {
    const scenario = `
const p = ${JSON.stringify(usagePayload(LIVE_DATA))};
p.command.data.description = 'x'.repeat(${MAX_USAGE_STDOUT_BYTES + 1024});
out(JSON.stringify(p) + '\\n');
process.exitCode = 0;`;
    const { snap, calls } = await quotaOf(scenario);
    expect(snap).toBeNull();
    expect(calls[0]!.maxStdoutBytes).toBe(1_048_576);
  });

  it('a runaway stdout is stopped at the cap: null well before the timeout, and the process is gone', async () => {
    const fake = fakeAgy(`out('x'.repeat(${4 * MAX_USAGE_STDOUT_BYTES})); setInterval(() => {}, 1000);`);
    const { adapter } = adapterFor(fake.bin, { quotaTimeoutMs: 30_000 });
    const start = Date.now();
    expect(await adapter.quota()).toBeNull();
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(await gone(fake.starts()[0]!.pid as number)).toBe(true);
  });

  it('agy is not installed (ENOENT)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mesh-no-agy-'));
    dirs.push(dir);
    const { adapter } = adapterFor(join(dir, 'agy'));
    await expect(adapter.quota()).resolves.toBeNull();
  });

  it('the timeout: null, and the whole process group is killed (grandchild included)', async () => {
    const fake = fakeAgy(`
const gc = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
log({ kind: 'grandchild', pid: gc.pid });
setInterval(() => {}, 1000);`);
    // A budget a loaded machine cannot outrun: the fake (and its grandchild) must have started
    // before the deadline kills the group, or there is nothing to assert about.
    const { adapter, calls } = adapterFor(fake.bin, { quotaTimeoutMs: 3_000 });
    const start = Date.now();
    expect(await adapter.quota()).toBeNull();
    expect(Date.now() - start).toBeLessThan(12_000);
    expect(calls[0]!.timeoutMs).toBe(3_000);
    const pid = fake.starts()[0]!.pid as number;
    const grandchild = fake.events().find((e) => e.kind === 'grandchild')?.pid as number | undefined;
    expect(grandchild).toBeTypeOf('number');
    expect(await gone(pid)).toBe(true);
    expect(await gone(grandchild!)).toBe(true);
  });
});

/* ------------------------------------------------------------------------- *
 * Through a fake agy: single flight and the cache
 * ------------------------------------------------------------------------- */

describe.skipIf(NO_FAKE_AGY)('quota() single flight and cache, through a fake agy', { timeout: 30_000 }, () => {
  it('concurrent calls for one account share ONE agy, and each gets its own copy', async () => {
    const fake = fakeAgy(answers(LIVE_STDOUT, { delayMs: 400 }));
    const { adapter, calls } = adapterFor(fake.bin);
    const [x, y, z] = await Promise.all([adapter.quota(), adapter.quota(), adapter.quota()]);
    expect(fake.starts()).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(x).not.toBeNull();
    expect(y).toEqual(x);
    expect(z).toEqual(x);
    expect(y).not.toBe(x);
    expect(y!.windows).not.toBe(x!.windows);
  });

  it('different accounts do not share a flight; each agy gets its own account env', async () => {
    const fake = fakeAgy(answers(LIVE_STDOUT, { delayMs: 300 }));
    const { adapter } = adapterFor(fake.bin, { env: { KEEP: 'yes' } });
    await Promise.all([
      adapter.quota({ vendor: 'gemini', configDir: '/acct/a' }),
      adapter.quota({ vendor: 'gemini', configDir: '/acct/a' }),
      adapter.quota({ vendor: 'gemini', configDir: '/acct/b' }),
    ]);
    const envs = fake.starts().map((s) => s.env as Record<string, string>);
    expect(envs).toHaveLength(2);
    expect(envs.map((e) => e.AGY_HOME).sort()).toEqual(['/acct/a', '/acct/b']);
    expect(envs.every((e) => e.KEEP === 'yes')).toBe(true);
  });

  it('a cache hit within the TTL spawns nothing; a call after it spawns again', async () => {
    const fake = fakeAgy(answers(LIVE_STDOUT));
    const { adapter } = adapterFor(fake.bin, { quotaCacheMs: 400 });
    const first = await adapter.quota();
    const second = await adapter.quota();
    expect(fake.starts()).toHaveLength(1);
    expect(second).toEqual(first);
    await sleep(600);
    expect(await adapter.quota()).toEqual(first);
    expect(fake.starts()).toHaveLength(2);
  });

  it('the default cache (60 s) reuses the outcome — a null too — and a returned snapshot cannot corrupt it', async () => {
    const ok = fakeAgy(answers(LIVE_STDOUT));
    const { adapter } = adapterFor(ok.bin, { quotaCacheMs: undefined });
    const first = await adapter.quota();
    first!.windows[0]!.usedPercent = 99;
    first!.windows.push({ label: 'injected', usedPercent: 100 });
    const second = await adapter.quota();
    expect(second!.windows).toHaveLength(4);
    expect(second!.windows[0]!.usedPercent).toBe(0);
    expect(ok.starts()).toHaveLength(1);

    const loggedOut = fakeAgy(answers('', { exit: 1, stderr: "Error: authentication required. Run 'agy' to log in.\n" }));
    const b = adapterFor(loggedOut.bin, { quotaCacheMs: 60_000 }).adapter;
    expect(await b.quota()).toBeNull();
    expect(await b.quota()).toBeNull();
    expect(loggedOut.starts()).toHaveLength(1); // a logged-out agy is not re-booted on every poll
  });

  it('quotaCacheMs 0: every sequential call asks agy again', async () => {
    const fake = fakeAgy(answers(LIVE_STDOUT));
    const { adapter } = adapterFor(fake.bin, { quotaCacheMs: 0 });
    await adapter.quota();
    await adapter.quota();
    expect(fake.starts()).toHaveLength(2);
  });
});
