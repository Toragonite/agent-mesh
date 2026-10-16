import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AdapterExecError,
  AgentMeshError,
  type LineStreamFn as CoreLineStreamFn,
  type McpAttachment,
  type RunEvent,
  type RunTask,
} from '@toragonite/agent-mesh';
import { ClaudeAdapter } from '../src/adapter';
import type { ExecFn, ExecRequest, ExecResult, LineStreamFn, StreamEndMeta } from '../src/exec';

/* ------------------------------------------------------------------------- *
 * 0.1.3 — the turn lane: first and resumed turns, MCP wiring, the session event,
 * the per-run seam and environment, and the interactive take-over command.
 * Fake seams only — no real CLI is ever spawned here.
 * ------------------------------------------------------------------------- */

const SESSION = '0b6f1c1e-3f7a-4c55-9a51-6f3a8f5e2b10';

/** An exec seam that records every request and returns a fixed (overridable) result. */
function recorder(result: Partial<ExecResult> = {}): { calls: ExecRequest[]; exec: ExecFn } {
  const calls: ExecRequest[] = [];
  const exec: ExecFn = async (req) => {
    calls.push(req);
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...result };
  };
  return { calls, exec };
}

/** A line seam that records its requests, yields `lines`, then reports `end`. */
function lines(
  out: string[],
  end: Partial<StreamEndMeta> = {},
): { calls: ExecRequest[]; lineStream: LineStreamFn } {
  const calls: ExecRequest[] = [];
  const lineStream: LineStreamFn = async function* (req, onEnd) {
    calls.push(req);
    for (const l of out) yield l;
    onEnd?.({ timedOut: false, exitCode: 0, stderrTail: '', ...end });
  };
  return { calls, lineStream };
}

/** A line seam that must never be used (the constructor default when a per-run seam is given). */
const forbiddenLineStream: LineStreamFn = async function* () {
  throw new Error('the constructor lineStream must not be used when options.lineStream is given');
};

const forbiddenExec: ExecFn = async () => {
  throw new Error('the constructor exec must not be used when options.lineStream is given');
};

async function collect(it: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const RESULT_LINE = (sessionId: string, text = 'ok') =>
  JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result: text });

const MCP: McpAttachment = {
  name: 'team',
  command: '/usr/local/bin/node',
  args: ['/data/mcp/cli.js', '--serve', '/data/members/a/spec.json'],
  configFile: '/data/members/a/mcp.json',
  projectConfigFile: '/work/tree/.mcp.json',
};

const TEAM_TOOLS = ['mcp__team__team_board', 'mcp__team__team_inbox'];

/** The flags every turn of one member carries (first and resumed alike). */
function teamTask(over: Partial<RunTask> = {}): RunTask {
  return {
    prompt: 'hello',
    model: 'claude-haiku-4-5',
    permissionMode: 'bypassPermissions',
    unattended: true,
    appendSystemPromptFile: '/data/members/a/brief.md',
    mcp: MCP,
    allowedTools: TEAM_TOOLS,
    disallowedTools: ['SendMessage', 'ListAgents'],
    cwd: '/work/tree',
    ...over,
  };
}

const SHARED_FLAGS = [
  '--model',
  'claude-haiku-4-5',
  '--permission-mode',
  'bypassPermissions',
  '--permission-prompts',
  'none',
  '--append-system-prompt-file',
  '/data/members/a/brief.md',
  '--mcp-config',
  '/work/tree/.mcp.json',
  '/data/members/a/mcp.json',
  '--strict-mcp-config',
  '--allowedTools',
  'mcp__team__team_board,mcp__team__team_inbox',
  '--disallowedTools',
  'SendMessage,ListAgents',
];

describe('turn-lane argv (exact)', () => {
  it('first turn: --session-id then every flag, prompt last behind --', async () => {
    const { calls, lineStream } = lines([RESULT_LINE(SESSION)]);
    const a = new ClaudeAdapter({ lineStream, env: {} });
    await collect(a.stream(teamTask({ sessionId: SESSION })));
    expect(calls[0]!.args).toEqual([
      '--session-id',
      SESSION,
      ...SHARED_FLAGS,
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--',
      'hello',
    ]);
    expect(calls[0]!.cwd).toBe('/work/tree');
  });

  it('resumed turn: --resume <id> and EXACTLY the same flags again (model and permission mode included)', async () => {
    const { calls, lineStream } = lines([RESULT_LINE(SESSION)]);
    const a = new ClaudeAdapter({ lineStream, env: {} });
    await collect(a.stream(teamTask({ resumeId: SESSION, prompt: 'next message' })));
    expect(calls[0]!.args).toEqual([
      '--resume',
      SESSION,
      ...SHARED_FLAGS,
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--',
      'next message',
    ]);
  });

  it('run() honours resumeId with the json tail', async () => {
    const rec = recorder({ stdout: RESULT_LINE(SESSION) });
    const a = new ClaudeAdapter({ exec: rec.exec, env: {} });
    const r = await a.run({ prompt: 'again', resumeId: `  ${SESSION}  `, permissionMode: 'acceptEdits' });
    expect(rec.calls[0]!.args).toEqual([
      '--resume',
      SESSION,
      '--permission-mode',
      'acceptEdits',
      '-p',
      '--output-format',
      'json',
      '--',
      'again',
    ]);
    expect(r.conversationId).toBe(SESSION);
  });

  it('places --setting-sources after --permission-prompts and before the system-prompt file', async () => {
    const { calls, lineStream } = lines([RESULT_LINE(SESSION)]);
    const a = new ClaudeAdapter({ lineStream, env: {} });
    await collect(
      a.stream({
        prompt: 'p',
        unattended: true,
        settingSources: ' user,project ',
        appendSystemPromptFile: '/b.md',
      }),
    );
    expect(calls[0]!.args).toEqual([
      '--permission-prompts',
      'none',
      '--setting-sources',
      'user,project',
      '--append-system-prompt-file',
      '/b.md',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--',
      'p',
    ]);
  });

  it('wires one MCP config file when the project has none, closed by --strict-mcp-config', async () => {
    const { calls, lineStream } = lines([RESULT_LINE(SESSION)]);
    const a = new ClaudeAdapter({ lineStream, env: {} });
    const { projectConfigFile: _drop, ...single } = MCP;
    await collect(a.stream({ prompt: 'p', mcp: single }));
    expect(calls[0]!.args).toEqual([
      '--mcp-config',
      '/data/members/a/mcp.json',
      '--strict-mcp-config',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--',
      'p',
    ]);
  });

  it('produces exactly the 0.1.2 argv when no turn-lane field is set', async () => {
    const { calls, lineStream } = lines([RESULT_LINE(SESSION)]);
    const a = new ClaudeAdapter({ lineStream, env: {} });
    await collect(a.stream({ prompt: 'hi', model: 'claude-sonnet-5' }));
    expect(calls[0]!.args).toEqual([
      '--model',
      'claude-sonnet-5',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--',
      'hi',
    ]);
  });

  it('notes the fields it cannot honour: elevated, dropped disallowedTools entries', async () => {
    const { lineStream } = lines([RESULT_LINE(SESSION)]);
    const a = new ClaudeAdapter({ lineStream, env: {} });
    const events = await collect(
      a.stream({ prompt: 'p', elevated: true, disallowedTools: ['X', 7 as unknown as string, '  '] }),
    );
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe(
      'disallowedTools contained 2 non-string or blank entries; dropped; elevated has no claude equivalent; ignored',
    );
  });
});

describe('turn-lane validation (before any spawn)', () => {
  const invalid: Array<[string, Partial<RunTask>]> = [
    ['a blank resumeId', { resumeId: '   ' }],
    ['a flag-shaped resumeId', { resumeId: '  --last ' }],
    ['a non-UUID sessionId', { sessionId: 'not-a-uuid' }],
    ['both sessionId and resumeId', { sessionId: SESSION, resumeId: SESSION }],
    ['a relative appendSystemPromptFile', { appendSystemPromptFile: 'brief.md' }],
    ['a blank appendSystemPromptFile', { appendSystemPromptFile: '' }],
    ['an mcp name with capitals', { mcp: { ...MCP, name: 'Team' } }],
    ['an mcp name starting with a digit', { mcp: { ...MCP, name: '1team' } }],
    ['a relative mcp.configFile', { mcp: { ...MCP, configFile: 'mcp.json' } }],
    ['a relative mcp.projectConfigFile', { mcp: { ...MCP, projectConfigFile: '.mcp.json' } }],
    ['a blank mcp.command', { mcp: { ...MCP, command: ' ' } }],
    ['a non-string mcp arg', { mcp: { ...MCP, args: [1 as unknown as string] } }],
    ['a control character in an mcp arg', { mcp: { ...MCP, args: ['a\nb'] } }],
    ['an mcp that is not an object', { mcp: 'team' as unknown as McpAttachment }],
    ['disallowedTools that is not an array', { disallowedTools: 'SendMessage' as unknown as string[] }],
    ['a flag-shaped settingSources', { settingSources: '--evil' }],
  ];

  for (const [label, over] of invalid) {
    it(`stream() throws synchronously for ${label}`, () => {
      const { calls, lineStream } = lines([]);
      const a = new ClaudeAdapter({ lineStream, env: {} });
      expect(() => a.stream({ prompt: 'p', ...over })).toThrow(AgentMeshError);
      expect(calls).toHaveLength(0);
    });

    it(`run() rejects for ${label}`, async () => {
      const rec = recorder();
      const a = new ClaudeAdapter({ exec: rec.exec, env: {} });
      await expect(a.run({ prompt: 'p', ...over })).rejects.toBeInstanceOf(AgentMeshError);
      expect(rec.calls).toHaveLength(0);
    });
  }

  it('treats a blank settingSources as absent (no flag)', async () => {
    const { calls, lineStream } = lines([RESULT_LINE(SESSION)]);
    const a = new ClaudeAdapter({ lineStream, env: {} });
    await collect(a.stream({ prompt: 'p', settingSources: '  ' }));
    expect(calls[0]!.args).not.toContain('--setting-sources');
  });
});

describe('the session event — the CLI’s own report, never synthesized', () => {
  it('is emitted once from system/init although every line repeats the id', async () => {
    const { lineStream } = lines([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION }),
      JSON.stringify({ type: 'assistant', session_id: SESSION, message: { content: [{ type: 'text', text: 'hi' }] } }),
      RESULT_LINE(SESSION, 'hi'),
    ]);
    const a = new ClaudeAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'p', sessionId: SESSION }));
    expect(events.filter((e) => e.type === 'session')).toEqual([{ type: 'session', conversationId: SESSION }]);
    expect(events[0]).toEqual({ type: 'session', conversationId: SESSION });
    expect(events.at(-1)!.type).toBe('done');
  });

  it('is NOT synthesized from sessionId or resumeId when the stream reports no id', async () => {
    const { lineStream } = lines([JSON.stringify({ type: 'result', is_error: false, result: 'no id here' })]);
    const a = new ClaudeAdapter({ lineStream, env: {} });
    const first = await collect(a.stream({ prompt: 'p', sessionId: SESSION }));
    expect(first.some((e) => e.type === 'session')).toBe(false);
    const resumed = await collect(a.stream({ prompt: 'p', resumeId: SESSION }));
    expect(resumed.some((e) => e.type === 'session')).toBe(false);
  });

  it('reports the id the CLI actually continued under when it differs from resumeId', async () => {
    const other = '11111111-2222-4333-8444-555555555555';
    const { lineStream } = lines([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: other }),
      RESULT_LINE(other),
    ]);
    const a = new ClaudeAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'p', resumeId: SESSION }));
    expect(events.filter((e) => e.type === 'session')).toEqual([{ type: 'session', conversationId: other }]);
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.conversationId).toBe(other);
  });

  it('emits again when a later line reports a DIFFERENT id', async () => {
    const later = '99999999-2222-4333-8444-555555555555';
    const { lineStream } = lines([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION }),
      RESULT_LINE(later),
    ]);
    const a = new ClaudeAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'p' }));
    expect(events.filter((e) => e.type === 'session').map((e) => (e as { conversationId: string }).conversationId)).toEqual([
      SESSION,
      later,
    ]);
    // The session event for the result line's id precedes the terminal done.
    expect(events.map((e) => e.type)).toEqual(['session', 'session', 'done']);
  });

  it('ends with exactly one done: lines after the result are drained but emit nothing', async () => {
    const { lineStream } = lines([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION }),
      RESULT_LINE(SESSION, 'final'),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'late' }] } }),
      RESULT_LINE('ffffffff-2222-4333-8444-555555555555', 'second'),
    ]);
    const a = new ClaudeAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'p' }));
    expect(events.map((e) => e.type)).toEqual(['session', 'done']);
  });

  it('a seam failure after the terminal done does not add an error event', async () => {
    const lineStream: LineStreamFn = async function* () {
      yield RESULT_LINE(SESSION);
      throw new Error('teardown failed');
    };
    const a = new ClaudeAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'p' }));
    expect(events.map((e) => e.type)).toEqual(['session', 'done']);
  });
});

describe('RunOptions — the per-run seam and environment', () => {
  it('stream() spawns ONLY through options.lineStream', async () => {
    const perRun = lines([RESULT_LINE(SESSION)]);
    const a = new ClaudeAdapter({ lineStream: forbiddenLineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'p' }, { lineStream: perRun.lineStream }));
    expect(perRun.calls).toHaveLength(1);
    expect(perRun.calls[0]!.cmd).toBe('claude');
    expect(events.at(-1)!.type).toBe('done');
  });

  it('run() drains options.lineStream instead of the exec seam', async () => {
    const perRun = lines(['{"type":"result","session_id":"s-1",', '"is_error":false,"result":"joined"}'.trim()]);
    // A result object split over two lines still parses once the lines are re-joined.
    const a = new ClaudeAdapter({ exec: forbiddenExec, env: {} });
    const r = await a.run({ prompt: 'p' }, { lineStream: perRun.lineStream });
    expect(perRun.calls).toHaveLength(1);
    expect(r.text).toBe('joined');
    expect(r.conversationId).toBe('s-1');
  });

  it('run() through options.lineStream: a non-zero exit with nothing parseable throws AdapterExecError with the stderr tail', async () => {
    const perRun = lines([], { exitCode: 1, stderrTail: 'No conversation found with session ID: x' });
    const a = new ClaudeAdapter({ exec: forbiddenExec, env: {} });
    await expect(a.run({ prompt: 'p', resumeId: 'x' }, { lineStream: perRun.lineStream })).rejects.toMatchObject({
      name: 'AdapterExecError',
      exitCode: 1,
      stderr: expect.stringContaining('No conversation found'),
    });
  });

  it('run() through options.lineStream: a seam that throws becomes AdapterExecError', async () => {
    const throwing: CoreLineStreamFn = async function* () {
      throw new Error('spawn claude ENOENT');
    };
    const a = new ClaudeAdapter({ exec: forbiddenExec, env: {} });
    await expect(a.run({ prompt: 'p' }, { lineStream: throwing })).rejects.toBeInstanceOf(AdapterExecError);
  });

  it('options.env is the child env VERBATIM: no CLAUDE_CONFIG_DIR from the seam, the default account or the account', async () => {
    const perRun = lines([RESULT_LINE(SESSION)]);
    const a = new ClaudeAdapter({
      env: { CLAUDE_CONFIG_DIR: '/host/dir', HOME: '/home/u' },
      defaultAccount: { vendor: 'claude', configDir: '/default/dir' },
    });
    const callerEnv = { HOME: '/home/u', PATH: '/bin', MARKER: 'turn-1' };
    await collect(a.stream({ prompt: 'p' }, { lineStream: perRun.lineStream, env: callerEnv }));
    expect(perRun.calls[0]!.env).toEqual(callerEnv);
    expect('CLAUDE_CONFIG_DIR' in perRun.calls[0]!.env!).toBe(false);
    // A copy: the seam can never mutate the caller's object.
    expect(perRun.calls[0]!.env).not.toBe(callerEnv);
  });

  it('options.env with an explicit account config dir: the env is still verbatim, and the run says so', async () => {
    const perRun = lines([RESULT_LINE(SESSION)]);
    const a = new ClaudeAdapter({ env: {} });
    const events = await collect(
      a.stream(
        { prompt: 'p', account: { vendor: 'claude', configDir: '/cfg/acct' } },
        { lineStream: perRun.lineStream, env: { A: '1' } },
      ),
    );
    expect(perRun.calls[0]!.env).toEqual({ A: '1' });
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe('account.configDir not applied: options.env is the complete child environment');
  });

  it('without options.env the 0.1.2 account env applies unchanged', async () => {
    const rec = recorder({ stdout: RESULT_LINE(SESSION) });
    const a = new ClaudeAdapter({ exec: rec.exec, env: { HOME: '/h' } });
    await a.run({ prompt: 'p', account: { vendor: 'claude', configDir: '/cfg/acct' } }, {});
    expect(rec.calls[0]!.env).toEqual({ HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg/acct' });
  });
});

describe('interactiveResume() — the take-over command', () => {
  const home = os.homedir();
  const defaultDir = path.join(home, '.claude');

  it('returns claude --resume <id> with an explicit account dir set verbatim, unverified', () => {
    const a = new ClaudeAdapter({ env: {}, binary: '/opt/claude/bin/claude' });
    expect(a.interactiveResume(`  ${SESSION} `, { vendor: 'claude', configDir: '/cfg/acct' })).toEqual({
      command: '/opt/claude/bin/claude',
      args: ['--resume', SESSION],
      env: { CLAUDE_CONFIG_DIR: '/cfg/acct' },
      unsetEnv: [],
      verified: false,
    });
  });

  it('expresses the DEFAULT config dir by unsetting CLAUDE_CONFIG_DIR (an explicit default path reads as logged out)', () => {
    const a = new ClaudeAdapter({ env: {} });
    const spec = a.interactiveResume(SESSION, { vendor: 'claude', configDir: `${defaultDir}/` });
    expect(spec.env).toEqual({});
    expect(spec.unsetEnv).toEqual(['CLAUDE_CONFIG_DIR']);
  });

  it('passes the host’s own CLAUDE_CONFIG_DIR string through when the account is that directory', () => {
    const a = new ClaudeAdapter({ env: { CLAUDE_CONFIG_DIR: defaultDir } });
    const spec = a.interactiveResume(SESSION, { vendor: 'claude', configDir: `${defaultDir}/` });
    expect(spec.env).toEqual({ CLAUDE_CONFIG_DIR: defaultDir });
    expect(spec.unsetEnv).toEqual([]);
  });

  it('a fully ambient call (no account, no default, no env dir) unsets CLAUDE_CONFIG_DIR', () => {
    const a = new ClaudeAdapter({ env: {} });
    const spec = a.interactiveResume(SESSION);
    expect(spec.env).toEqual({});
    expect(spec.unsetEnv).toEqual(['CLAUDE_CONFIG_DIR']);
  });

  it('falls back to the default account’s dir when no account is passed', () => {
    const a = new ClaudeAdapter({ env: {}, defaultAccount: { vendor: 'claude', configDir: '/cfg/default-acct' } });
    expect(a.interactiveResume(SESSION).env).toEqual({ CLAUDE_CONFIG_DIR: '/cfg/default-acct' });
  });

  it('refuses a blank or flag-shaped id', () => {
    const a = new ClaudeAdapter({ env: {} });
    expect(() => a.interactiveResume('  ')).toThrow(AgentMeshError);
    expect(() => a.interactiveResume('--last')).toThrow(AgentMeshError);
  });
});
