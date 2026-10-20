import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAdapter, fetchLiveModels, type SpawnFn, type SpawnedChild } from '../src/index.js';
import { STATIC_MODELS } from '../src/models.js';
import { recordingExec } from './helpers.js';

// The `codex app-server` spawn seam (0.1.4). Every child here is an in-memory fake: no process
// is started, and `process.kill` is stubbed so a stray group kill would be SEEN, never sent.

// Type-level pin: the real `child_process.spawn` IS a SpawnFn (it is the default).
const realSpawnIsASpawnFn: SpawnFn = spawn;
void realSpawnIsASpawnFn;

const noExec = recordingExec().exec;
const API_KEY_ENV = { OPENAI_API_KEY: 'sk-test-not-real' };
const STATIC_IDS = STATIC_MODELS.map((m) => m.id);

interface FakeChild extends SpawnedChild {
  readonly kills: Array<NodeJS.Signals | number | undefined>;
  readonly received: Array<Record<string, unknown>>;
  emitError(err: Error): void;
}

interface Call {
  command: string;
  args: string[];
  options: SpawnOptions;
}

type Behaviour = 'answer' | 'silent' | 'answer-no-exit';

/**
 * A fake app-server child. 'answer' speaks the protocol (one page) and exits 0 on stdin close;
 * 'silent' never answers; 'answer-no-exit' answers but ignores stdin close. A kill emits
 * `exit(null, signal)`, like a real child.
 */
function fakeChild(behaviour: Behaviour, pid = 424_242): FakeChild {
  const ee = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kills: Array<NodeJS.Signals | number | undefined> = [];
  const received: Array<Record<string, unknown>> = [];
  let exited = false;
  const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exited) return;
    exited = true;
    setImmediate(() => ee.emit('exit', code, signal));
  };
  const send = (o: unknown): void => {
    stdout.write(`${JSON.stringify(o)}\n`);
  };
  let buf = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
      buf = buf.slice(i + 1);
      received.push(msg);
      if (behaviour === 'silent') continue;
      if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake' } });
      if (msg.method === 'model/list') {
        send({ id: msg.id, result: { data: [{ id: 'seam-model', isDefault: true }], nextCursor: null } });
      }
    }
  });
  stdin.on('end', () => {
    if (behaviour === 'answer') exit(0, null);
  });
  const child: FakeChild = {
    pid,
    stdin,
    stdout,
    stderr,
    kills,
    received,
    emitError(err: Error) {
      ee.emit('error', err);
    },
    kill(signal?: NodeJS.Signals | number) {
      kills.push(signal);
      exit(null, typeof signal === 'string' ? signal : 'SIGKILL');
      return true;
    },
    on(event: string, listener: (...args: never[]) => void) {
      ee.on(event, listener as (...args: unknown[]) => void);
      return child;
    },
  } as FakeChild;
  return child;
}

function recordingSpawner(make: () => FakeChild): { spawn: SpawnFn; calls: Call[]; children: FakeChild[] } {
  const calls: Call[] = [];
  const children: FakeChild[] = [];
  return {
    calls,
    children,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      const c = make();
      children.push(c);
      return c;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('codex app-server spawn seam (0.1.4)', () => {
  it('fetchLiveModels() uses an injected spawner — the exact call, the protocol, the mapped list', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const s = recordingSpawner(() => fakeChild('answer'));
    const models = await fetchLiveModels({ binary: 'codex-fake', codexHome: '/acct/home', env: { KEEP: '1' }, spawn: s.spawn });
    expect(models).toEqual([{ id: 'seam-model', latencyClass: 'fast', default: true }]);
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0]!;
    expect(call.command).toBe('codex-fake');
    expect(call.args).toEqual(['app-server']);
    expect(call.options).toMatchObject({ shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(call.options.env).toMatchObject({ KEEP: '1', CODEX_HOME: '/acct/home' });
    expect(s.children[0]!.received.map((m) => m.method)).toEqual(['initialize', 'initialized', 'model/list']);
    expect(s.children[0]!.kills).toEqual([]); // it exited by itself
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('CodexAdapter({ spawn }) threads the seam into availableModels(), memoized per CODEX_HOME', async () => {
    const s = recordingSpawner(() => fakeChild('answer'));
    const a = new CodexAdapter({ exec: noExec, binary: 'codex-fake', env: API_KEY_ENV, spawn: s.spawn });
    expect((await a.availableModels()).map((m) => m.id)).toEqual(['seam-model']);
    expect((await a.availableModels()).map((m) => m.id)).toEqual(['seam-model']);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.command).toBe('codex-fake');
    await a.availableModels({ vendor: 'codex', configDir: '/other/home' });
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]!.options.env).toMatchObject({ CODEX_HOME: '/other/home' });
  });

  it('at the deadline an injected child is killed by itself — never by process group', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    for (const behaviour of ['silent', 'answer-no-exit'] as const) {
      const s = recordingSpawner(() => fakeChild(behaviour));
      const a = new CodexAdapter({ exec: noExec, binary: 'codex-fake', env: API_KEY_ENV, spawn: s.spawn, modelsTimeoutMs: 50 });
      expect((await a.availableModels()).map((m) => m.id)).toEqual(STATIC_IDS);
      expect(s.children[0]!.kills).toEqual(['SIGKILL']);
    }
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('a failure (JSON-RPC error) kills only the injected child', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = fakeChild('silent');
    child.stdin!.on('data', () => (child.stdout as PassThrough).write(`${JSON.stringify({ id: 1, error: { code: 1, message: 'x' } })}\n`));
    expect(await fetchLiveModels({ binary: 'codex-fake', env: {}, spawn: () => child })).toEqual([]);
    expect(child.kills).toEqual(['SIGKILL']);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('a spawner that throws, returns nothing usable, or a child without pipes → [] and never a throw', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(
      await fetchLiveModels({
        env: {},
        spawn: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toEqual([]);
    expect(await fetchLiveModels({ env: {}, spawn: (() => undefined) as unknown as SpawnFn })).toEqual([]);
    expect(await fetchLiveModels({ env: {}, spawn: (() => null) as unknown as SpawnFn })).toEqual([]);
    const noPipes = fakeChild('answer');
    const broken = { ...noPipes, stdout: null, on: noPipes.on, kill: noPipes.kill } as unknown as SpawnedChild;
    expect(await fetchLiveModels({ env: {}, spawn: () => broken })).toEqual([]);
    expect(noPipes.kills).toEqual(['SIGKILL']);
    // Streams that are not streams (no setEncoding/on): resolved null, the child told to stop.
    const notStreams = fakeChild('answer');
    const odd = { ...notStreams, stdout: {}, on: notStreams.on, kill: notStreams.kill } as unknown as SpawnedChild;
    expect(await fetchLiveModels({ env: {}, spawn: () => odd })).toEqual([]);
    expect(notStreams.kills).toEqual(['SIGKILL']);
    const a = new CodexAdapter({
      exec: noExec,
      env: API_KEY_ENV,
      spawn: () => {
        throw new Error('EACCES');
      },
    });
    expect((await a.availableModels()).map((m) => m.id)).toEqual(STATIC_IDS);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("an injected child's 'error' event (e.g. ENOENT) → [] and the child is told to stop", async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = fakeChild('silent');
    const pending = fetchLiveModels({ env: {}, spawn: () => child, timeoutMs: 5_000 });
    child.emitError(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
    expect(await pending).toEqual([]);
    expect(child.kills).toEqual(['SIGKILL']);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('an injected child that dies before answering → []', async () => {
    const child = fakeChild('silent');
    const pending = fetchLiveModels({ env: {}, spawn: () => child, timeoutMs: 5_000 });
    child.kill('SIGTERM');
    expect(await pending).toEqual([]);
  });
});
