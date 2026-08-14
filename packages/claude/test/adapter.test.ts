import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Fleet,
  AgentMeshError,
  AdapterExecError,
  type Adapter,
  type ModelInfo,
  type QuotaSnapshot,
  type RunEvent,
  type RunResult,
  type RunTask,
  type Vendor,
} from '@toragonite/agent-mesh';
import { ClaudeAdapter } from '../src/adapter';
import type { ExecFn, ExecRequest, ExecResult, LineStreamFn } from '../src/exec';
import type { LiveUsage } from '../src/usage';
import type { MeshGateway } from '../src/gateway';

/* ------------------------------------------------------------------------- *
 * Fakes — the adapter's every side-effecting seam is injectable.
 * ------------------------------------------------------------------------- */

/** A canned successful `claude -p --output-format json` payload. */
const OK_JSON = JSON.stringify({
  result: 'hello world',
  session_id: 'sess-123',
  is_error: false,
  model: 'claude-sonnet-5',
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
  },
});

/** An exec seam that records every request and returns a fixed (overridable) result. */
function recorder(result: Partial<ExecResult> = {}): { calls: ExecRequest[]; exec: ExecFn } {
  const calls: ExecRequest[] = [];
  const exec: ExecFn = async (req) => {
    calls.push(req);
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...result };
  };
  return { calls, exec };
}

/** A canned LiveUsage reading. */
function liveUsage(over: Partial<LiveUsage> = {}): LiveUsage {
  return {
    available: true,
    subscriptionType: 'max',
    windows: [
      { kind: 'session', percent: 42, severity: 'warning', resetsAt: '2026-08-11T18:00:00.000Z' },
      { kind: 'weekly_all', percent: 10, severity: 'normal', resetsAt: null },
    ],
    sessionCostUsd: 1,
    extraUsage: null,
    fetchedAt: 0,
    raw: {},
    ...over,
  };
}

/* ------------------------------------------------------------------------- *
 * run() — argv construction
 * ------------------------------------------------------------------------- */

describe('run() argv', () => {
  it('places value flags first and the prompt LAST, fenced behind -- with allowedTools comma-joined', async () => {
    const rec = recorder({ stdout: OK_JSON });
    // env:{} makes the composed child-env base empty, so the request env below is exactly
    // { CLAUDE_CONFIG_DIR } — the seam now uses req.env AS the child env (no process.env merge).
    const adapter = new ClaudeAdapter({ exec: rec.exec, env: {} });
    await adapter.run({
      prompt: 'do the thing',
      model: 'claude-opus-4-8',
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Write'],
      account: { vendor: 'claude', configDir: '/cfg/work' },
    });

    const args = rec.calls[0]!.args;
    expect(args).toEqual([
      '--model',
      'claude-opus-4-8',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Read,Write',
      '-p',
      '--output-format',
      'json',
      '--',
      'do the thing',
    ]);
    // Prompt is the final element; the `--` terminator immediately precedes it.
    expect(args[args.length - 1]).toBe('do the thing');
    expect(args[args.length - 2]).toBe('--');
    // --allowedTools carries ONE comma-joined value, so nothing after it is swallowed.
    const at = args.indexOf('--allowedTools');
    expect(args[at + 1]).toBe('Read,Write');
    expect(args[at + 2]).toBe('-p');
    // CLAUDE_CONFIG_DIR is taken from the task account.
    expect(rec.calls[0]!.env).toEqual({ CLAUDE_CONFIG_DIR: '/cfg/work' });
    expect(rec.calls[0]!.cmd).toBe('claude');
  });

  it('omits absent value flags and carries no CLAUDE_CONFIG_DIR when no account', async () => {
    const rec = recorder({ stdout: OK_JSON });
    // env:{} pins the fully-ambient case (no CLAUDE_CONFIG_DIR in the seam).
    const adapter = new ClaudeAdapter({ exec: rec.exec, env: {} });
    await adapter.run({ prompt: 'hi' });
    expect(rec.calls[0]!.args).toEqual(['-p', '--output-format', 'json', '--', 'hi']);
    // The adapter now composes the child env from the seam (here {}); it is no longer `undefined`,
    // and a fully ambient login simply carries no CLAUDE_CONFIG_DIR key.
    expect(rec.calls[0]!.env).toEqual({});
    expect('CLAUDE_CONFIG_DIR' in rec.calls[0]!.env!).toBe(false);
  });

  it('appends extra.args verbatim before -p, and the prompt stays fenced behind --', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const adapter = new ClaudeAdapter({ exec: rec.exec });
    await adapter.run({ prompt: 'hi', extra: { args: ['--foo', 'bar'] } });
    expect(rec.calls[0]!.args).toEqual([
      '--foo',
      'bar',
      '-p',
      '--output-format',
      'json',
      '--',
      'hi',
    ]);
  });

  it('does NOT swallow a non-flag extra.args token into the --allowedTools value (M6)', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const adapter = new ClaudeAdapter({ exec: rec.exec });
    await adapter.run({ prompt: 'hi', allowedTools: ['Read'], extra: { args: ['config', 'x'] } });
    const args = rec.calls[0]!.args;
    const at = args.indexOf('--allowedTools');
    // The tools value is exactly 'Read' — 'config' is its own argv element, not part of the grant.
    expect(args[at + 1]).toBe('Read');
    expect(args[at + 2]).toBe('config');
    expect(args).toEqual([
      '--allowedTools',
      'Read',
      'config',
      'x',
      '-p',
      '--output-format',
      'json',
      '--',
      'hi',
    ]);
  });

  it('passes a hostile prompt through as a single, unmodified argv element behind the fence', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const adapter = new ClaudeAdapter({ exec: rec.exec });
    const hostile = '--dangerous\n"; rm -rf /" `whoami`';
    await adapter.run({ prompt: hostile });
    const args = rec.calls[0]!.args;
    expect(args[args.length - 1]).toBe(hostile);
    expect(args[args.length - 2]).toBe('--');
    expect(args.filter((a) => a === hostile)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- *
 * run() — result mapping
 * ------------------------------------------------------------------------- */

describe('run() result mapping', () => {
  it('maps result/session_id/status/model/usage incl. cachedInputTokens', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const adapter = new ClaudeAdapter({ exec: rec.exec });
    const res = await adapter.run({ prompt: 'x' });
    expect(res).toMatchObject({
      vendor: 'claude',
      conversationId: 'sess-123',
      text: 'hello world',
      status: 'ok',
      model: 'claude-sonnet-5',
    });
    // totalTokens is computed from input+output when the vendor supplies no total (U3).
    expect(res.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 3,
      totalTokens: 15,
    });
    expect(res.raw).toMatchObject({ session_id: 'sess-123' });
  });

  it('maps is_error:true to status error', async () => {
    const rec = recorder({
      stdout: JSON.stringify({ result: 'nope', session_id: 's', is_error: true }),
    });
    const res = await new ClaudeAdapter({ exec: rec.exec }).run({ prompt: 'x' });
    expect(res.status).toBe('error');
  });

  it('prefers the requested model over the parsed one', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const res = await new ClaudeAdapter({ exec: rec.exec }).run({
      prompt: 'x',
      model: 'claude-opus-4-8',
    });
    expect(res.model).toBe('claude-opus-4-8');
  });

  it('annotates an unknown model but still runs (M12)', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const res = await new ClaudeAdapter({ exec: rec.exec }).run({ prompt: 'x', model: 'gtp-5.5' });
    expect(res.status).toBe('ok');
    expect(res.note).toBe('model gtp-5.5 not in known catalog');
  });

  it('accepts a dated catalog suffix without a note (M12 prefix-match)', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const res = await new ClaudeAdapter({ exec: rec.exec }).run({
      prompt: 'x',
      model: 'claude-haiku-4-5-20251001',
    });
    expect(res.note).toBeUndefined();
  });

  it('composes the timeout note with the unknown-model note using "; " (M12)', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true });
    const res = await new ClaudeAdapter({ exec }).run({
      prompt: 'x',
      model: 'gtp-5.5',
      timeoutMs: 900,
    });
    expect(res.status).toBe('incomplete');
    expect(res.note).toBe('timed out after 900ms; model gtp-5.5 not in known catalog');
  });
});

/* ------------------------------------------------------------------------- *
 * resume()
 * ------------------------------------------------------------------------- */

describe('resume() argv', () => {
  it('leads with --resume <id> and ends with the message fenced behind --', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const adapter = new ClaudeAdapter({ exec: rec.exec });
    await adapter.resume('sess-9', 'continue please', { model: 'claude-haiku-4-5' });
    expect(rec.calls[0]!.args).toEqual([
      '--resume',
      'sess-9',
      '--model',
      'claude-haiku-4-5',
      '-p',
      '--output-format',
      'json',
      '--',
      'continue please',
    ]);
    const args = rec.calls[0]!.args;
    expect(args[args.length - 1]).toBe('continue please');
    expect(args[args.length - 2]).toBe('--');
  });

  it('rejects a flag-shaped conversationId (leading -) before spawning (H3)', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const adapter = new ClaudeAdapter({ exec: rec.exec });
    await expect(adapter.resume('--last', 'msg')).rejects.toBeInstanceOf(AgentMeshError);
    await expect(adapter.resume('-p', 'msg')).rejects.toBeInstanceOf(AgentMeshError);
    expect(rec.calls).toHaveLength(0); // never reached the exec seam
  });
});

/* ------------------------------------------------------------------------- *
 * Uniform error semantics
 * ------------------------------------------------------------------------- */

describe('empty-input guards throw before spawning', () => {
  it('rejects blank prompt / message / conversationId with AgentMeshError', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const adapter = new ClaudeAdapter({ exec: rec.exec });
    await expect(adapter.run({ prompt: '   ' })).rejects.toBeInstanceOf(AgentMeshError);
    await expect(adapter.resume('', 'hi')).rejects.toBeInstanceOf(AgentMeshError);
    await expect(adapter.resume('id', '  ')).rejects.toBeInstanceOf(AgentMeshError);
    expect(rec.calls).toHaveLength(0); // never reached the exec seam
  });
});

describe('spawn / exit failures throw AdapterExecError', () => {
  it('converts a spawn rejection (ENOENT) to AdapterExecError', async () => {
    const exec: ExecFn = async () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    };
    const adapter = new ClaudeAdapter({ exec });
    await expect(adapter.run({ prompt: 'x' })).rejects.toBeInstanceOf(AdapterExecError);
    try {
      await adapter.run({ prompt: 'x' });
      expect.unreachable();
    } catch (e) {
      expect((e as AdapterExecError).vendor).toBe('claude');
    }
  });

  it('throws AdapterExecError with exitCode + stderr on a non-zero exit with no parseable result', async () => {
    const exec: ExecFn = async () => ({
      stdout: '',
      stderr: 'boom happened on the CLI',
      exitCode: 2,
      timedOut: false,
    });
    const adapter = new ClaudeAdapter({ exec });
    try {
      await adapter.run({ prompt: 'x' });
      expect.unreachable();
    } catch (e) {
      const err = e as AdapterExecError;
      expect(err.name).toBe('AdapterExecError');
      expect(err.exitCode).toBe(2);
      expect(err.stderr).toContain('boom happened');
    }
  });

  it('maps a non-zero exit that STILL emits a parseable result (no throw)', async () => {
    const exec: ExecFn = async () => ({
      stdout: JSON.stringify({ result: 'err text', session_id: 's', is_error: true }),
      stderr: '',
      exitCode: 1,
      timedOut: false,
    });
    const res = await new ClaudeAdapter({ exec }).run({ prompt: 'x' });
    expect(res.status).toBe('error');
    expect(res.text).toBe('err text');
  });
});

describe('degraded (non-throwing) outcomes', () => {
  it('resolves incomplete with a note on timeout', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true });
    const res = await new ClaudeAdapter({ exec }).run({ prompt: 'x', timeoutMs: 1234 });
    expect(res.status).toBe('incomplete');
    expect(res.note).toBe('timed out after 1234ms');
    expect(res.conversationId).toBe('');
    expect(res.text).toBe('');
  });

  it('resolves incomplete with empty text on a clean exit with garbage stdout', async () => {
    const exec: ExecFn = async () => ({
      stdout: 'not json at all',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
    const res = await new ClaudeAdapter({ exec }).run({ prompt: 'x' });
    expect(res.status).toBe('incomplete');
    expect(res.text).toBe('');
  });
});

/* ------------------------------------------------------------------------- *
 * quota()
 * ------------------------------------------------------------------------- */

describe('quota()', () => {
  it('maps LiveUsage windows to a QuotaSnapshot and passes configDir + the adapter binary', async () => {
    let seenOpts: unknown;
    const adapter = new ClaudeAdapter({
      binary: '/opt/claude/bin/claude',
      getUsage: async (o) => {
        seenOpts = o;
        return liveUsage();
      },
    });
    const q = await adapter.quota({ vendor: 'claude', configDir: '/cfg/q' });
    // M5: the probe uses the adapter's own binary, not a bare `claude` from PATH.
    // The 30s default quota timeout rides along (the probe's own 20s default is too tight).
    expect(seenOpts).toEqual({
      configDir: '/cfg/q',
      claudePath: '/opt/claude/bin/claude',
      timeoutMs: 30_000,
    });
    expect(q).not.toBeNull();
    expect(q!.vendor).toBe('claude');
    expect(q!.allowed).toBe(true);
    expect(q!.windows).toEqual([
      { label: 'Session (5hr)', usedPercent: 42, resetAt: '2026-08-11T18:00:00.000Z' },
      { label: 'Weekly (7 day)', usedPercent: 10 },
    ]);
  });

  it('marks allowed:false when any window is at/over 100%', async () => {
    const adapter = new ClaudeAdapter({
      getUsage: async () =>
        liveUsage({ windows: [{ kind: 'session', percent: 100, severity: 'critical', resetsAt: null }] }),
    });
    const q = await adapter.quota();
    expect(q!.allowed).toBe(false);
  });

  it('returns null when unavailable, errored, or the probe throws', async () => {
    expect(await new ClaudeAdapter({ getUsage: async () => liveUsage({ available: false }) }).quota()).toBeNull();
    expect(await new ClaudeAdapter({ getUsage: async () => liveUsage({ error: 'timeout' }) }).quota()).toBeNull();
    expect(
      await new ClaudeAdapter({
        getUsage: async () => {
          throw new Error('boom');
        },
      }).quota(),
    ).toBeNull();
  });

  it('probes WITHOUT a configDir for a fully ambient login (H1)', async () => {
    let seenOpts: Record<string, unknown> = {};
    const adapter = new ClaudeAdapter({
      env: {}, // no CLAUDE_CONFIG_DIR → fully ambient
      getUsage: async (o) => {
        seenOpts = o as Record<string, unknown>;
        return liveUsage();
      },
    });
    await adapter.quota();
    // No configDir key at all, so the probe inherits the ambient env rather than forcing one.
    expect('configDir' in seenOpts).toBe(false);
    expect(seenOpts.claudePath).toBe('claude');
  });

  it('treats a seam CLAUDE_CONFIG_DIR as an explicit probe dir when no account is given (H1)', async () => {
    let seenOpts: Record<string, unknown> = {};
    const adapter = new ClaudeAdapter({
      env: { CLAUDE_CONFIG_DIR: '/env/dir' },
      getUsage: async (o) => {
        seenOpts = o as Record<string, unknown>;
        return liveUsage();
      },
    });
    await adapter.quota();
    expect(seenOpts.configDir).toBe('/env/dir');
  });

  it('an explicit ambient account overrides a defaultAccount configDir (M7/L8)', async () => {
    let seenOpts: Record<string, unknown> = {};
    const adapter = new ClaudeAdapter({
      env: {},
      defaultAccount: { vendor: 'claude', configDir: '/default/dir' },
      getUsage: async (o) => {
        seenOpts = o as Record<string, unknown>;
        return liveUsage();
      },
    });
    // Account present with no configDir → ambient; must NOT fall back to the defaultAccount dir.
    await adapter.quota({ vendor: 'claude' });
    expect('configDir' in seenOpts).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * authStatus()
 * ------------------------------------------------------------------------- */

describe('authStatus()', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (prevKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = prevKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('reports api-key mode when ANTHROPIC_API_KEY is set (never reading a file)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-secret-xxxx';
    const adapter = new ClaudeAdapter({
      readTextFile: async () => {
        throw new Error('must not read a file when api key is present');
      },
    });
    const status = await adapter.authStatus();
    expect(status).toEqual({ loggedIn: true, mode: 'api-key' });
    expect(status.detail).toBeUndefined();
  });

  it('reads the ANTHROPIC_API_KEY from the injected env seam, not global process.env (M7/L8)', async () => {
    // process.env has no key (deleted in beforeEach); the seam supplies it.
    const adapter = new ClaudeAdapter({
      env: { ANTHROPIC_API_KEY: 'sk-from-seam' },
      readTextFile: async () => {
        throw new Error('must not read a file when api key is present');
      },
    });
    expect(await adapter.authStatus()).toEqual({ loggedIn: true, mode: 'api-key' });
  });

  it('reads ~/.claude.json (home root) for a fully ambient login (H1)', async () => {
    let seenPath = '';
    const adapter = new ClaudeAdapter({
      env: {}, // no account, no CLAUDE_CONFIG_DIR → fully ambient
      readTextFile: async (p) => {
        seenPath = p;
        return JSON.stringify({ oauthAccount: { emailAddress: 'ambient@example.com' } });
      },
    });
    expect(await adapter.authStatus()).toEqual({
      loggedIn: true,
      mode: 'subscription',
      detail: 'ambient@example.com',
    });
    // Home ROOT, not ~/.claude/.claude.json.
    expect(seenPath).toBe(path.join(os.homedir(), '.claude.json'));
  });

  it('reads <dir>/.claude.json when the env seam sets CLAUDE_CONFIG_DIR (H1)', async () => {
    let seenPath = '';
    const adapter = new ClaudeAdapter({
      env: { CLAUDE_CONFIG_DIR: '/env/dir' },
      readTextFile: async (p) => {
        seenPath = p;
        return null;
      },
    });
    await adapter.authStatus();
    expect(seenPath).toBe(path.join('/env/dir', '.claude.json'));
  });

  it('reports subscription mode with the oauth email from .claude.json', async () => {
    let seenPath = '';
    const adapter = new ClaudeAdapter({
      defaultAccount: { vendor: 'claude', configDir: '/cfg/sub' },
      readTextFile: async (p) => {
        seenPath = p;
        return JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } });
      },
    });
    expect(await adapter.authStatus()).toEqual({
      loggedIn: true,
      mode: 'subscription',
      detail: 'me@example.com',
    });
    expect(seenPath.endsWith('.claude.json')).toBe(true);
    expect(seenPath).toContain('/cfg/sub');
  });

  it('reports logged out when the config is absent or has no oauthAccount', async () => {
    expect(await new ClaudeAdapter({ readTextFile: async () => null }).authStatus()).toEqual({
      loggedIn: false,
    });
    expect(
      await new ClaudeAdapter({ readTextFile: async () => '{"other":true}' }).authStatus(),
    ).toEqual({ loggedIn: false });
  });
});

/* ------------------------------------------------------------------------- *
 * availableModels()
 * ------------------------------------------------------------------------- */

describe('availableModels()', () => {
  it('returns the static matrix with NO model marked default (A4 — the CLI chooses)', async () => {
    const models = await new ClaudeAdapter().availableModels();
    expect(models.map((m) => m.id)).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-fable-5',
    ]);
    // A4: omitting task.model lets the CLI pick, so the catalog advertises no default it cannot honor.
    expect(models.some((m) => m.default)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * stream()
 * ------------------------------------------------------------------------- */

describe('stream() event mapping', () => {
  async function collect(lineStream: LineStreamFn, task: RunTask = { prompt: 'hi' }): Promise<RunEvent[]> {
    const events: RunEvent[] = [];
    for await (const ev of new ClaudeAdapter({ lineStream }).stream(task)) {
      events.push(ev);
    }
    return events;
  }

  it('maps init/text/tool_use/result and skips non-JSON lines', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-77', model: 'claude-sonnet-5' }),
      'this is not json — skip me',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', name: 'Read', input: { path: 'a.ts' } }] },
      }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: ' world' }] } }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'sess-77',
        is_error: false,
        result: 'Hello world',
        usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 },
      }),
    ];
    const lineStream: LineStreamFn = async function* () {
      for (const l of lines) yield l;
    };
    const events = await collect(lineStream);
    expect(events.slice(0, 4)).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool', name: 'Read', detail: { path: 'a.ts' } },
      { type: 'text', text: ' world' },
      // totalTokens computed from input+output (U3).
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 1, totalTokens: 6 } },
    ]);
    const done = events[4];
    expect(done!.type).toBe('done');
    expect((done as Extract<RunEvent, { type: 'done' }>).result).toMatchObject({
      vendor: 'claude',
      conversationId: 'sess-77',
      text: 'Hello world',
      status: 'ok',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 1, totalTokens: 6 },
    });
  });

  it('emits a single error event when the stream process fails', async () => {
    const lineStream: LineStreamFn = async function* () {
      throw new Error('spawn boom');
      // eslint-disable-next-line no-unreachable
      yield '';
    };
    expect(await collect(lineStream)).toEqual([{ type: 'error', message: 'spawn boom' }]);
  });

  it('emits an error when the stream ends without a result event', async () => {
    const lineStream: LineStreamFn = async function* () {
      yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    };
    const events = await collect(lineStream);
    expect(events.at(-1)).toEqual({ type: 'error', message: 'claude stream ended without a result event' });
  });

  it('mirrors run() on a timeout: a done/incomplete result with partial text, never an error (M2)', async () => {
    const lineStream: LineStreamFn = async function* (_req, onEnd) {
      yield JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-T' });
      yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial ' }] } });
      yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } });
      onEnd?.({ timedOut: true, exitCode: null, stderrTail: '' });
    };
    const events = await collect(lineStream, { prompt: 'hi', timeoutMs: 500 });
    const last = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(last.type).toBe('done');
    expect(last.result).toMatchObject({
      vendor: 'claude',
      conversationId: 'sess-T',
      text: 'partial answer',
      status: 'incomplete',
      note: 'timed out after 500ms',
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('includes the exit code and stderr tail in the error on a non-zero exit (M2)', async () => {
    const lineStream: LineStreamFn = async function* (_req, onEnd) {
      yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
      onEnd?.({ timedOut: false, exitCode: 1, stderrTail: 'auth failed: token expired' });
    };
    const events = await collect(lineStream);
    const last = events.at(-1) as Extract<RunEvent, { type: 'error' }>;
    expect(last.type).toBe('error');
    expect(last.message).toContain('exit 1');
    expect(last.message).toContain('auth failed: token expired');
  });

  it('annotates an unknown model on the done result (M12)', async () => {
    const lineStream: LineStreamFn = async function* () {
      yield JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 's',
        is_error: false,
        result: 'ok',
      });
    };
    const events = await collect(lineStream, { prompt: 'hi', model: 'gtp-5.5' });
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe('model gtp-5.5 not in known catalog');
  });

  it('throws AgentMeshError synchronously for a blank prompt — eager validation (N1)', () => {
    const lineStream: LineStreamFn = async function* () {
      /* never reached */
    };
    // The guard runs at call time, not on first next().
    expect(() => new ClaudeAdapter({ lineStream }).stream({ prompt: '  ' })).toThrow(AgentMeshError);
  });
});

/* ------------------------------------------------------------------------- *
 * steer()
 * ------------------------------------------------------------------------- */

describe('steer()', () => {
  it('throws AgentMeshError without a gateway', async () => {
    await expect(new ClaudeAdapter().steer('cm-worker-1', 'wake up')).rejects.toBeInstanceOf(
      AgentMeshError,
    );
  });

  it('relays to the mesh session NAME through the gateway', async () => {
    const sends: Array<{ to: string; message: string }> = [];
    const gateway = {
      send: async (req: { to: string; message: string }) => {
        sends.push(req);
        return { delivered: true, msgId: 'm1' };
      },
    } as unknown as MeshGateway;
    // A non-existent configDir makes findSession read an empty registry, so `to` is the raw name.
    const adapter = new ClaudeAdapter({
      gateway,
      defaultAccount: { vendor: 'claude', configDir: '/nonexistent-cfg-xyz' },
    });
    await adapter.steer('cm-worker-1', 'wake up');
    expect(sends).toEqual([{ to: 'cm-worker-1', message: 'wake up' }]);
  });
});

/* ------------------------------------------------------------------------- *
 * Uniform rules (U1–U7) — cross-adapter value semantics
 * ------------------------------------------------------------------------- */

describe('conversation-id value semantics (U1)', () => {
  it('rejects a TRIMMED flag-shaped id "  -c  " before spawning', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const adapter = new ClaudeAdapter({ exec: rec.exec });
    await expect(adapter.resume('  -c  ', 'msg')).rejects.toBeInstanceOf(AgentMeshError);
    expect(rec.calls).toHaveLength(0); // never reached the exec seam
  });

  it('passes the TRIMMED id to argv ("  abc-123  " → "abc-123")', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const adapter = new ClaudeAdapter({ exec: rec.exec });
    await adapter.resume('  abc-123  ', 'msg');
    const args = rec.calls[0]!.args;
    expect(args[0]).toBe('--resume');
    expect(args[1]).toBe('abc-123'); // spaces stripped, not forwarded verbatim
  });
});

describe('model value semantics — absent is not invalid (U2)', () => {
  it('treats a blank model as ABSENT: no --model flag, no note, no throw', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const res = await new ClaudeAdapter({ exec: rec.exec }).run({ prompt: 'x', model: '   ' });
    expect(rec.calls[0]!.args).not.toContain('--model');
    expect(res.note).toBeUndefined();
    expect(res.status).toBe('ok');
  });

  it('passes a non-empty model TRIMMED to the CLI', async () => {
    const rec = recorder({ stdout: OK_JSON });
    await new ClaudeAdapter({ exec: rec.exec }).run({ prompt: 'x', model: '  claude-opus-4-8  ' });
    const args = rec.calls[0]!.args;
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8');
  });

  it('notes an unknown model using its trimmed value', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const res = await new ClaudeAdapter({ exec: rec.exec }).run({ prompt: 'x', model: '  gtp-5.5  ' });
    expect(res.note).toBe('model gtp-5.5 not in known catalog');
    const args = rec.calls[0]!.args;
    expect(args[args.indexOf('--model') + 1]).toBe('gtp-5.5');
  });
});

describe('usage.totalTokens (U3)', () => {
  it('computes the total from input+output when the vendor supplies none', async () => {
    const rec = recorder({
      stdout: JSON.stringify({
        result: 'r',
        session_id: 's',
        is_error: false,
        usage: { input_tokens: 7, output_tokens: 11 },
      }),
    });
    const res = await new ClaudeAdapter({ exec: rec.exec }).run({ prompt: 'x' });
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 11, totalTokens: 18 });
  });

  it('omits the total when either input or output is absent', async () => {
    const rec = recorder({
      stdout: JSON.stringify({
        result: 'r',
        session_id: 's',
        is_error: false,
        usage: { cache_read_input_tokens: 3 },
      }),
    });
    const res = await new ClaudeAdapter({ exec: rec.exec }).run({ prompt: 'x' });
    expect(res.usage).toEqual({ cachedInputTokens: 3 });
    expect(res.usage!.totalTokens).toBeUndefined();
  });

  it('uses a vendor-supplied total verbatim', async () => {
    const rec = recorder({
      stdout: JSON.stringify({
        result: 'r',
        session_id: 's',
        is_error: false,
        usage: { input_tokens: 7, output_tokens: 11, total_tokens: 999 },
      }),
    });
    const res = await new ClaudeAdapter({ exec: rec.exec }).run({ prompt: 'x' });
    expect(res.usage!.totalTokens).toBe(999);
  });
});

describe('null / malformed account is ABSENT (U4)', () => {
  it('run() falls back to defaultAccount for a null account instead of a TypeError', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const adapter = new ClaudeAdapter({
      exec: rec.exec,
      env: {},
      defaultAccount: { vendor: 'claude', configDir: '/default/dir' },
    });
    // account:null must behave as if omitted — never a raw TypeError from `null.configDir`.
    await adapter.run({ prompt: 'hi', account: null as unknown as undefined });
    expect(rec.calls[0]!.env).toEqual({ CLAUDE_CONFIG_DIR: '/default/dir' });
  });

  it('authStatus() treats a null account as absent and never throws', async () => {
    const adapter = new ClaudeAdapter({
      env: {},
      defaultAccount: { vendor: 'claude', configDir: '/default/dir' },
      readTextFile: async () => null,
    });
    // account:null previously threw a TypeError from `null.configDir`; now it falls back cleanly.
    await expect(
      adapter.authStatus(null as unknown as undefined),
    ).resolves.toEqual({ loggedIn: false });
  });
});

describe('extra.args never drops input silently (U5)', () => {
  it('adds a plural note and keeps only string entries in argv', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const res = await new ClaudeAdapter({ exec: rec.exec }).run({
      prompt: 'x',
      extra: { args: ['--foo', 123, 'bar', {}] },
    });
    expect(res.note).toBe('extra.args contained 2 non-string entries; dropped');
    expect(rec.calls[0]!.args).toContain('--foo');
    expect(rec.calls[0]!.args).toContain('bar');
  });

  it('uses the singular "entry" for exactly one dropped', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const res = await new ClaudeAdapter({ exec: rec.exec }).run({
      prompt: 'x',
      extra: { args: [42] },
    });
    expect(res.note).toBe('extra.args contained 1 non-string entry; dropped');
  });
});

describe('resume() honours a working directory (U6)', () => {
  it('passes opts.extra.cwd as the child cwd', async () => {
    const rec = recorder({ stdout: OK_JSON });
    await new ClaudeAdapter({ exec: rec.exec }).resume('sess-1', 'go', {
      extra: { cwd: '/work/dir' },
    });
    expect(rec.calls[0]!.cwd).toBe('/work/dir');
  });

  it('inherits (undefined cwd) when extra.cwd is absent or non-string', async () => {
    const rec = recorder({ stdout: OK_JSON });
    await new ClaudeAdapter({ exec: rec.exec }).resume('sess-1', 'go', { extra: { cwd: 42 } });
    expect(rec.calls[0]!.cwd).toBeUndefined();
  });
});

describe('notes compose and match across run() and stream() (U7)', () => {
  const task: RunTask = { prompt: 'x', model: 'gtp-5.5', extra: { args: ['ok', 99] } };
  const expected =
    'model gtp-5.5 not in known catalog; extra.args contained 1 non-string entry; dropped';

  it('run() composes the model note and the extra.args note with "; "', async () => {
    const rec = recorder({ stdout: OK_JSON });
    const res = await new ClaudeAdapter({ exec: rec.exec }).run(task);
    expect(res.note).toBe(expected);
  });

  it('stream() done carries the SAME composed note', async () => {
    const lineStream: LineStreamFn = async function* () {
      yield JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 's',
        is_error: false,
        result: 'ok',
      });
    };
    const events: RunEvent[] = [];
    for await (const ev of new ClaudeAdapter({ lineStream }).stream(task)) {
      events.push(ev);
    }
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe(expected);
  });
});

/* ------------------------------------------------------------------------- *
 * Fleet end-to-end (ClaudeAdapter + an inline fake second adapter)
 * ------------------------------------------------------------------------- */

/** A minimal second adapter so Fleet routing has more than one candidate. */
class FakeCodexAdapter implements Adapter {
  readonly vendor: Vendor = 'codex';
  readonly capabilities = {
    resume: true,
    steer: 'none' as const,
    peerMesh: false,
    quota: true,
    stream: false,
  };
  constructor(private readonly snapshot: QuotaSnapshot | null) {}
  async authStatus() {
    return { loggedIn: true };
  }
  async availableModels(): Promise<ModelInfo[]> {
    return [{ id: 'gpt-x', latencyClass: 'fast', default: true }];
  }
  async quota(): Promise<QuotaSnapshot | null> {
    return this.snapshot;
  }
  async run(): Promise<RunResult> {
    return { vendor: this.vendor, conversationId: 'codex-1', text: 'from codex', status: 'ok' };
  }
  async resume(): Promise<RunResult> {
    return { vendor: this.vendor, conversationId: 'codex-1', text: 'codex resumed', status: 'ok' };
  }
}

describe('Fleet e2e', () => {
  function makeFleet() {
    const claude = new ClaudeAdapter({
      exec: recorder({ stdout: OK_JSON }).exec,
      // Claude is heavily used (90%); the fake codex has plenty of headroom (10%).
      getUsage: async () =>
        liveUsage({ windows: [{ kind: 'session', percent: 90, severity: 'critical', resetsAt: null }] }),
    });
    const codex = new FakeCodexAdapter({
      vendor: 'codex',
      windows: [{ label: '5h', usedPercent: 10 }],
      allowed: true,
    });
    return new Fleet().register(claude).register(codex);
  }

  it('prefer-order picks the first preferred vendor', async () => {
    const decision = await makeFleet().route({ prompt: 'x' }, { prefer: ['claude', 'codex'] });
    expect(decision.adapter.vendor).toBe('claude');
  });

  it('most-quota picks the adapter with the most headroom', async () => {
    const decision = await makeFleet().route(
      { prompt: 'x' },
      { prefer: ['claude', 'codex'], strategy: 'most-quota' },
    );
    expect(decision.adapter.vendor).toBe('codex');
  });

  it('run() round-trips through the routed ClaudeAdapter', async () => {
    const res = await makeFleet().run({ prompt: 'hello' }, { policy: { prefer: ['claude', 'codex'] } });
    expect(res.vendor).toBe('claude');
    expect(res.text).toBe('hello world');
  });

  it('resume() targets the named vendor', async () => {
    const res = await makeFleet().resume('claude', 'sess-1', 'again');
    expect(res.vendor).toBe('claude');
    expect(res.text).toBe('hello world');
  });
});
