import { afterAll, describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/adapter.js';
import { fetchLiveModels, mapLiveModels, STATIC_MODELS } from '../src/models.js';
import { PACKAGE_VERSION } from '../src/version.js';
import { recordingExec, fixedReader } from './helpers.js';

// Every test here drives a FAKE `codex app-server`: a small node script written to a
// temp dir and handed to the adapter as its binary. The real codex is never run, no
// network is touched, and the env each fake receives is the synthetic one below.

const noExec = recordingExec().exec;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type FakeEvent = { kind: string; [k: string]: unknown };

interface Fake {
  bin: string;
  events(): FakeEvent[];
  received(): Array<Record<string, unknown>>;
  pids(): number[];
}

/**
 * Write a fake app-server. `scenario` is JS that may reassign `onMessage(msg)` and
 * `onEof()` (default: exit 0 on stdin EOF — the real app-server's behaviour), and may
 * use `send(obj)`, `raw(text)`, `log(obj)`, and `INIT_RESULT`.
 */
function fakeAppServer(scenario: string): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'agent-mesh-fake-codex-'));
  dirs.push(dir);
  const logPath = join(dir, 'log.jsonl');
  const bin = join(dir, 'codex');
  const source = `#!${process.execPath}
'use strict';
const fs = require('fs');
const LOG = ${JSON.stringify(logPath)};
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\\n');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const raw = (s) => process.stdout.write(s);
const INIT_RESULT = { userAgent: 'codex_cli_rs/0.162.1 (fake)', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' };
log({ kind: 'start', pid: process.pid, argv: process.argv.slice(2), env: process.env });
process.on('exit', (code) => log({ kind: 'exit', code }));
let onMessage = () => {};
let onEof = () => process.exit(0);
${scenario}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    log({ kind: 'recv', msg });
    onMessage(msg);
  }
});
process.stdin.on('end', () => { log({ kind: 'eof' }); onEof(); });
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
  return {
    bin,
    events,
    received: () => events().filter((e) => e.kind === 'recv').map((e) => e.msg as Record<string, unknown>),
    pids: () => events().filter((e) => e.kind === 'start').map((e) => e.pid as number),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Poll until `pid` is gone (an orphaned grandchild is reaped by init, not by us). */
async function gone(pid: number, withinMs = 3000): Promise<boolean> {
  const end = Date.now() + withinMs;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

/** Answer `initialize`, then serve `model/list` pages keyed by cursor ('' = first page). */
function pagedServer(pages: Record<string, unknown>): string {
  return `
const PAGES = ${JSON.stringify(pages)};
onMessage = (m) => {
  if (m.method === 'initialize') send({ id: m.id, result: INIT_RESULT });
  else if (m.method === 'model/list') send({ id: m.id, result: PAGES[(m.params && m.params.cursor) || ''] });
};`;
}

const TWO_PAGES = {
  '': {
    data: [
      {
        id: 'gpt-6.1-sol',
        model: 'gpt-6.1-sol',
        displayName: 'GPT-6.1 Sol',
        description: 'Latest frontier model.',
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast' },
          { reasoningEffort: 'medium', description: 'Balanced' },
          { reasoningEffort: 'high', description: 'Deep' },
        ],
      },
      { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'gpt-6-astra', isDefault: false, supportedReasoningEfforts: [] },
    ],
    nextCursor: 'page-2',
  },
  'page-2': {
    data: [
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
      { id: 'gpt-5.2', displayName: 'GPT-5.2', isDefault: false },
    ],
    nextCursor: null,
  },
};

const TWO_PAGES_MODELS = [
  { id: 'gpt-6.1-sol', latencyClass: 'fast', label: 'GPT-6.1 Sol', default: true, efforts: ['low', 'medium', 'high'] },
  { id: 'gpt-6-astra', latencyClass: 'fast' },
  { id: 'gpt-5.6-sol', latencyClass: 'fast', label: 'GPT-5.6 Sol', efforts: ['medium'] },
  { id: 'gpt-5.2', latencyClass: 'slow', label: 'GPT-5.2', authModes: ['api-key'] },
];

const STATIC_IDS = STATIC_MODELS.map((m) => m.id);
const API_KEY_ENV = { OPENAI_API_KEY: 'sk-test-not-real' };
const CHATGPT_AUTH = JSON.stringify({ tokens: { access_token: 'fake-token' } });

describe.skipIf(process.platform === 'win32' || process.execPath.includes(' '))(
  'live models via a fake `codex app-server`',
  () => {
    it('happy path: two pages, the exact protocol, mapped models, and a self-exit on stdin close', async () => {
      const fake = fakeAppServer(`
${pagedServer(TWO_PAGES)}
const answer = onMessage;
onMessage = (m) => {
  // Noise a client must ignore: a notification, a server request, a stray response id.
  if (m.method === 'initialize') {
    send({ method: 'thread/started', params: {} });
    send({ id: 99, method: 'item/requestApproval', params: {} });
    send({ id: 42, result: {} });
  }
  answer(m);
};`);
      const models = await fetchLiveModels({ binary: fake.bin, codexHome: '/acct/home', env: {} });
      expect(models).toEqual(TWO_PAGES_MODELS);

      expect(fake.received()).toEqual([
        {
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'agent-mesh', title: 'agent-mesh', version: PACKAGE_VERSION } },
        },
        { method: 'initialized' },
        { id: 2, method: 'model/list', params: {} },
        { id: 3, method: 'model/list', params: { cursor: 'page-2' } },
      ]);
      const events = fake.events();
      expect(events[0]!.argv).toEqual(['app-server']);
      // It was ended by closing stdin, and it exited by itself with 0.
      expect(events.map((e) => e.kind).slice(-2)).toEqual(['eof', 'exit']);
      expect(events.at(-1)!.code).toBe(0);
      expect(await gone(fake.pids()[0]!)).toBe(true);
    });

    it('availableModels() returns the live list, gated by auth mode exactly like the static one', async () => {
      const apiKey = fakeAppServer(pagedServer(TWO_PAGES));
      const a = new CodexAdapter({ exec: noExec, binary: apiKey.bin, env: API_KEY_ENV });
      expect(await a.availableModels()).toEqual(TWO_PAGES_MODELS);

      const chatgpt = fakeAppServer(pagedServer(TWO_PAGES));
      const b = new CodexAdapter({
        exec: noExec,
        binary: chatgpt.bin,
        env: {},
        readTextFile: fixedReader(CHATGPT_AUTH),
      });
      // gpt-5.2 is API-key-only in the catalog: filtered under a ChatGPT login, as today.
      expect((await b.availableModels({ vendor: 'codex', configDir: '/home/x' })).map((m) => m.id)).toEqual([
        'gpt-6.1-sol',
        'gpt-6-astra',
        'gpt-5.6-sol',
      ]);
    });

    it('a JSON-RPC error on model/list → the static list, and the process is gone', async () => {
      const fake = fakeAppServer(`
onEof = () => {}; setInterval(() => {}, 1000);
onMessage = (m) => {
  if (m.method === 'initialize') send({ id: m.id, result: INIT_RESULT });
  else if (m.method === 'model/list') send({ id: m.id, error: { code: -32603, message: 'internal error' } });
};`);
      const a = new CodexAdapter({ exec: noExec, binary: fake.bin, env: API_KEY_ENV, modelsTimeoutMs: 10_000 });
      const start = Date.now();
      expect((await a.availableModels()).map((m) => m.id)).toEqual(STATIC_IDS);
      expect(Date.now() - start).toBeLessThan(5_000); // failed at once, not at the deadline
      expect(await gone(fake.pids()[0]!)).toBe(true);
      expect(await fetchLiveModels({ binary: fakeAppServer(`
onMessage = (m) => { if (m.method === 'initialize') send({ id: m.id, error: { code: -32600, message: 'bad' } }); };`).bin, env: {} })).toEqual([]);
    });

    it('a JSON-RPC error with a null id (parse error) also ends it', async () => {
      const fake = fakeAppServer(`
onEof = () => {}; setInterval(() => {}, 1000);
onMessage = () => send({ id: null, error: { code: -32700, message: 'parse error' } });`);
      expect(await fetchLiveModels({ binary: fake.bin, env: {}, timeoutMs: 10_000 })).toEqual([]);
      expect(await gone(fake.pids()[0]!)).toBe(true);
    });

    it('malformed lines → the static list at once, and the process is gone', async () => {
      const answers = [
        `raw('this is not json\\n')`,
        `raw('[1,2,3]\\n')`,
        `raw('"a string"\\n')`,
        `raw('{"id":1,"result":\\n')`,
        `raw('x'.repeat(1100000))`, // one line past the 1 MiB cap, no newline
      ];
      for (const answer of answers) {
        const fake = fakeAppServer(`
onEof = () => {}; setInterval(() => {}, 1000);
onMessage = (m) => { if (m.method === 'initialize') ${answer}; };`);
        const start = Date.now();
        expect(await fetchLiveModels({ binary: fake.bin, env: {}, timeoutMs: 10_000 })).toEqual([]);
        expect(Date.now() - start).toBeLessThan(5_000);
        expect(await gone(fake.pids()[0]!)).toBe(true);
      }
    });

    it('a result of the wrong shape → the static list', async () => {
      const shapes = [
        `onMessage = (m) => send({ id: m.id, result: null });`, // initialize result not an object
        `onMessage = (m) => send({ id: m.id, result: m.method === 'initialize' ? INIT_RESULT : { data: 'nope' } });`,
        `onMessage = (m) => send({ id: m.id, result: m.method === 'initialize' ? INIT_RESULT : { models: [] } });`,
        `onMessage = (m) => send({ id: m.id, result: m.method === 'initialize' ? INIT_RESULT : { data: [] } });`, // nothing usable
        `onMessage = (m) => send({ id: m.id, result: m.method === 'initialize' ? INIT_RESULT : { data: [{ id: 7 }, { name: 'x' }] } });`,
      ];
      for (const shape of shapes) {
        const fake = fakeAppServer(shape);
        expect(await fetchLiveModels({ binary: fake.bin, env: {}, timeoutMs: 10_000 })).toEqual([]);
        expect(await gone(fake.pids()[0]!)).toBe(true);
      }
    });

    it('never answers → the static list at the timeout; it and its child process are gone', async () => {
      const fake = fakeAppServer(`
const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
log({ kind: 'grandchild', pid: child.pid });
onEof = () => {}; setInterval(() => {}, 1000);`);
      const a = new CodexAdapter({ exec: noExec, binary: fake.bin, env: API_KEY_ENV, modelsTimeoutMs: 400 });
      const start = Date.now();
      expect((await a.availableModels()).map((m) => m.id)).toEqual(STATIC_IDS);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(350);
      expect(elapsed).toBeLessThan(4_000);
      expect(await gone(fake.pids()[0]!)).toBe(true);
      const grandchild = fake.events().find((e) => e.kind === 'grandchild')!.pid as number;
      expect(await gone(grandchild)).toBe(true); // the whole process group was killed
    });

    it('answers but does not exit on stdin close → killed at the timeout, the static list', async () => {
      const fake = fakeAppServer(`
${pagedServer(TWO_PAGES)}
onEof = () => { log({ kind: 'ignoring-eof' }); };
setInterval(() => {}, 1000);`);
      const start = Date.now();
      expect(await fetchLiveModels({ binary: fake.bin, env: {}, timeoutMs: 600 })).toEqual([]);
      expect(Date.now() - start).toBeLessThan(4_000);
      const kinds = fake.events().map((e) => e.kind);
      expect(kinds).toContain('ignoring-eof'); // stdin WAS closed — the server just would not go
      expect(await gone(fake.pids()[0]!)).toBe(true);
    });

    it('an exit before the listing ends, or a non-zero exit after it → the static list', async () => {
      const early = fakeAppServer(`onMessage = (m) => { if (m.method === 'initialize') process.exit(0); };`);
      expect(await fetchLiveModels({ binary: early.bin, env: {} })).toEqual([]);

      const nonZero = fakeAppServer(`${pagedServer(TWO_PAGES)}\nonEof = () => process.exit(3);`);
      expect(await fetchLiveModels({ binary: nonZero.bin, env: {} })).toEqual([]);
      expect(nonZero.events().at(-1)).toMatchObject({ kind: 'exit', code: 3 });
    });

    it('a spawn error (no such binary) → the static list, never a throw', async () => {
      const a = new CodexAdapter({ exec: noExec, binary: '/nonexistent/agent-mesh-test/codex', env: API_KEY_ENV });
      expect((await a.availableModels()).map((m) => m.id)).toEqual(STATIC_IDS);
      expect(await fetchLiveModels({ binary: '/nonexistent/agent-mesh-test/codex', env: {} })).toEqual([]);
      const notExecutable = join(mkdtempSync(join(tmpdir(), 'agent-mesh-fake-codex-')), 'codex');
      dirs.push(join(notExecutable, '..'));
      writeFileSync(notExecutable, 'not a program');
      expect(await fetchLiveModels({ binary: notExecutable, env: {} })).toEqual([]);
    });

    it('follows nextCursor for at most 10 pages', async () => {
      const fake = fakeAppServer(`
onMessage = (m) => {
  if (m.method === 'initialize') return send({ id: m.id, result: INIT_RESULT });
  const n = m.params && m.params.cursor ? Number(m.params.cursor.slice(1)) : 0;
  send({ id: m.id, result: { data: [{ id: 'model-' + n }], nextCursor: 'c' + (n + 1) } });
};`);
      const models = await fetchLiveModels({ binary: fake.bin, env: {} });
      expect(models.map((m) => m.id)).toEqual(Array.from({ length: 10 }, (_, i) => `model-${i}`));
      expect(fake.received().filter((m) => m.method === 'model/list')).toHaveLength(10);
      expect(fake.events().at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    });

    it('stops at a repeated cursor instead of looping', async () => {
      const fake = fakeAppServer(`
onMessage = (m) => {
  if (m.method === 'initialize') return send({ id: m.id, result: INIT_RESULT });
  send({ id: m.id, result: { data: [{ id: 'm-' + m.id }], nextCursor: 'same' } });
};`);
      const models = await fetchLiveModels({ binary: fake.bin, env: {} });
      expect(models.map((m) => m.id)).toEqual(['m-2', 'm-3']);
      expect(fake.received().filter((m) => m.method === 'model/list')).toHaveLength(2);
    });

    it('the env it is given: CODEX_HOME = the account home, nothing Anthropic, the rest kept', async () => {
      const env = {
        CODEX_HOME: '/ambient/codex',
        ANTHROPIC_API_KEY: 'sk-ant-not-real',
        ANTHROPIC_BASE_URL: 'https://example.invalid',
        CLAUDE_CONFIG_DIR: '/some/claude',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDECODE: '1',
        claude_lowercase: 'x',
        OPENAI_API_KEY: 'sk-test-not-real',
        KEEP_ME: 'yes',
        DROPPED_UNDEFINED: undefined,
      };
      const envOf = (fake: Fake) => fake.events()[0]!.env as Record<string, string>;
      const assertClean = (childEnv: Record<string, string>) => {
        expect(Object.keys(childEnv).filter((k) => /^(anthropic_|claude)/i.test(k))).toEqual([]);
        expect(childEnv.KEEP_ME).toBe('yes');
        expect(childEnv.OPENAI_API_KEY).toBe('sk-test-not-real');
        expect('DROPPED_UNDEFINED' in childEnv).toBe(false);
      };

      // An explicit account → its configDir.
      const withAccount = fakeAppServer(pagedServer(TWO_PAGES));
      await new CodexAdapter({ exec: noExec, binary: withAccount.bin, env }).availableModels({
        vendor: 'codex',
        configDir: '/acct/home',
      });
      expect(envOf(withAccount).CODEX_HOME).toBe('/acct/home');
      assertClean(envOf(withAccount));

      // No account → the default account's configDir.
      const withDefault = fakeAppServer(pagedServer(TWO_PAGES));
      await new CodexAdapter({
        exec: noExec,
        binary: withDefault.bin,
        env,
        defaultAccount: { vendor: 'codex', configDir: '/default/home' },
      }).availableModels();
      expect(envOf(withDefault).CODEX_HOME).toBe('/default/home');

      // Ambient → the env's own CODEX_HOME (the adapter's existing resolution).
      const ambient = fakeAppServer(pagedServer(TWO_PAGES));
      await new CodexAdapter({ exec: noExec, binary: ambient.bin, env }).availableModels();
      expect(envOf(ambient).CODEX_HOME).toBe('/ambient/codex');
      assertClean(envOf(ambient));
    });

    it('memoizes a successful listing per CODEX_HOME — one app-server for repeated and concurrent calls', async () => {
      const fake = fakeAppServer(pagedServer(TWO_PAGES));
      const a = new CodexAdapter({ exec: noExec, binary: fake.bin, env: API_KEY_ENV });
      await Promise.all([a.availableModels(), a.availableModels()]);
      const again = await a.availableModels();
      expect(again).toEqual(TWO_PAGES_MODELS);
      expect(fake.pids()).toHaveLength(1);
      again[0]!.efforts!.push('mutated'); // callers get copies
      expect((await a.availableModels())[0]!.efforts).toEqual(['low', 'medium', 'high']);
      // A different account home is a different listing.
      await a.availableModels({ vendor: 'codex', configDir: '/other/home' });
      expect(fake.pids()).toHaveLength(2);
    });

    it('caches a FAILED listing for modelsCacheMs, then asks again', async () => {
      const failing = fakeAppServer(`onMessage = (m) => send({ id: m.id, error: { code: 1, message: 'x' } });`);
      const a = new CodexAdapter({ exec: noExec, binary: failing.bin, env: API_KEY_ENV });
      await a.availableModels();
      await a.availableModels();
      expect(failing.pids()).toHaveLength(1);

      const retrying = fakeAppServer(`onMessage = (m) => send({ id: m.id, error: { code: 1, message: 'x' } });`);
      const b = new CodexAdapter({ exec: noExec, binary: retrying.bin, env: API_KEY_ENV, modelsCacheMs: 0 });
      await b.availableModels();
      await b.availableModels();
      expect(retrying.pids()).toHaveLength(2);
    });
  },
);

describe('mapLiveModels()', () => {
  it('skips unusable entries, keeps the first of a repeated id and the first default only', () => {
    const models = mapLiveModels([
      null,
      'gpt-x',
      { id: 7 },
      { id: '' },
      { id: '   ' },
      { id: 'has space' },
      { id: 'line\nbreak' },
      { id: 'x'.repeat(257) },
      { id: ' gpt-6-sol ', isDefault: true },
      { id: 'gpt-6-sol', displayName: 'duplicate' },
      { id: 'gpt-6-luna', isDefault: true },
      { id: '__proto__' },
    ]);
    expect(models).toEqual([
      { id: 'gpt-6-sol', latencyClass: 'fast', default: true },
      { id: 'gpt-6-luna', latencyClass: 'fast' },
      { id: '__proto__', latencyClass: 'fast' },
    ]);
  });

  it('makes a display name one line and cuts it; drops one equal to the id', () => {
    const [a, b, c] = mapLiveModels([
      { id: 'm1', displayName: 'Line one\nline\ttwo\u0007' },
      { id: 'm2', displayName: 'y'.repeat(10_000) },
      { id: 'm3', displayName: '  m3  ' },
    ]);
    expect(a!.label).toBe('Line one line two');
    expect(b!.label).toHaveLength(120);
    expect(c!.label).toBeUndefined();
  });

  it('reads efforts from supportedReasoningEfforts[].reasoningEffort only, de-duplicated, in order', () => {
    const [m] = mapLiveModels([
      {
        id: 'm',
        supportedReasoningEfforts: [
          { reasoningEffort: 'high' },
          { reasoningEffort: 'low' },
          { reasoningEffort: 'high' },
          { reasoningEffort: '' },
          { reasoningEffort: 5 },
          'medium',
          null,
        ],
      },
    ]);
    expect(m!.efforts).toEqual(['high', 'low']);
    expect(mapLiveModels([{ id: 'n', supportedReasoningEfforts: 'high' }])[0]).not.toHaveProperty('efforts');
  });

  it('takes latencyClass and authModes from the static catalog, else a neutral class', () => {
    const models = mapLiveModels([{ id: 'gpt-5.1-codex-max' }, { id: 'brand-new-model' }]);
    expect(models).toEqual([
      { id: 'gpt-5.1-codex-max', latencyClass: 'slow', authModes: ['api-key'] },
      { id: 'brand-new-model', latencyClass: 'fast' },
    ]);
  });

  it('keeps at most 512 models', () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ id: `m-${i}` }));
    expect(mapLiveModels(many)).toHaveLength(512);
  });
});
