import { describe, it, expect } from 'vitest';
import { AgentMeshError, canStream, type McpAttachment, type RunEvent } from '@toragonite/agent-mesh';
import { CodexAdapter } from '../src/adapter.js';
import type { ExecRequest, LineStreamFn, StreamEndMeta } from '../src/exec.js';
import { recordingExec, fixedReader, jsonl } from './helpers.js';

/* ------------------------------------------------------------------------- *
 * 0.1.3 — Codex stream() over `codex exec --json`, resumed turns (which need a
 * model), the MCP wiring, and RunOptions. Fake seams only: no real CLI.
 * ------------------------------------------------------------------------- */

/** A line seam that records its requests, yields `out`, then reports `end`. */
function lines(out: string[], end: Partial<StreamEndMeta> = {}): { calls: ExecRequest[]; lineStream: LineStreamFn } {
  const calls: ExecRequest[] = [];
  const lineStream: LineStreamFn = async function* (req, onEnd) {
    calls.push(req);
    for (const l of out) yield l;
    onEnd?.({ timedOut: false, exitCode: 0, stderrTail: '', ...end });
  };
  return { calls, lineStream };
}

const forbiddenLineStream: LineStreamFn = async function* () {
  throw new Error('the constructor lineStream must not be used when options.lineStream is given');
};

async function collect(it: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const THREAD = '019a3b7c-1111-7222-8333-444455556666';

/** A `codex exec --json` run: a command, reasoning, an MCP tool call, a file change, the answer. */
const RUN_EVENTS = [
  { type: 'thread.started', thread_id: THREAD },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'ls', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'ls', exit_code: 0 } },
  { type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'thinking…' } },
  { type: 'item.started', item: { id: 'item_2', type: 'mcp_tool_call', server: 'team', tool: 'team_board' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'mcp_tool_call', server: 'team', tool: 'team_board' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: 'a.txt' }] } },
  { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'Done.' } },
  { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 7 } },
];
const RUN_LINES = RUN_EVENTS.map((e) => JSON.stringify(e));

const MCP: McpAttachment = {
  name: 'team',
  command: '/usr/local/bin/node',
  args: ['/data/mcp/cli.js', '--serve', '/data/members/b/spec.json'],
  configFile: '/data/members/b/mcp.json',
};

const MCP_ARGS = [
  '-c',
  'mcp_servers.team.command="/usr/local/bin/node"',
  '-c',
  'mcp_servers.team.args=["/data/mcp/cli.js","--serve","/data/members/b/spec.json"]',
  '-c',
  'mcp_servers.team.default_tools_approval_mode="approve"',
];

describe('stream() over exec --json', () => {
  it('advertises streaming', () => {
    const a = new CodexAdapter({ env: {} });
    expect(a.capabilities.stream).toBe(true);
    expect(canStream(a)).toBe(true);
  });

  it('maps the JSONL: session first, one tool per item, text for the answer, then usage and done', async () => {
    const { lineStream } = lines(RUN_LINES);
    const a = new CodexAdapter({ lineStream, env: {}, readTextFile: fixedReader(null) });
    const events = await collect(a.stream({ prompt: 'go' }));
    expect(events.map((e) => e.type)).toEqual(['session', 'tool', 'tool', 'tool', 'text', 'usage', 'done']);
    expect(events[0]).toEqual({ type: 'session', conversationId: THREAD });
    expect(events.filter((e) => e.type === 'tool').map((e) => (e as { name: string }).name)).toEqual([
      'command_execution',
      'mcp__team__team_board',
      'file_change',
    ]);
    expect(events[4]).toEqual({ type: 'text', text: 'Done.' });
    expect(events[5]).toEqual({
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 7, cachedInputTokens: 20, totalTokens: 107 },
    });
  });

  it('ends with exactly the result run() maps from the same output', async () => {
    const { lineStream } = lines(RUN_LINES);
    const streamed = await collect(new CodexAdapter({ lineStream, env: {} }).stream({ prompt: 'go' }));
    const done = streamed.at(-1) as Extract<RunEvent, { type: 'done' }>;
    const { exec } = recordingExec({ stdout: jsonl(...RUN_EVENTS) });
    const ran = await new CodexAdapter({ exec, env: {} }).run({ prompt: 'go' });
    expect(done.result).toEqual(ran);
    expect(done.result).toMatchObject({ conversationId: THREAD, text: 'Done.', status: 'ok' });
  });

  it('spawns `exec --json … -- <prompt>` with the 0.1.2 argv shape for a first turn', async () => {
    const { calls, lineStream } = lines(RUN_LINES);
    const a = new CodexAdapter({ lineStream, env: {}, readTextFile: fixedReader(null) });
    await collect(a.stream({ prompt: 'hi', model: 'gpt-6-luna', permissionMode: 'workspace-write', cwd: '/w' }));
    expect(calls[0]!.args).toEqual([
      'exec',
      '--json',
      '--model',
      'gpt-6-luna',
      '--sandbox',
      'workspace-write',
      '--',
      'hi',
    ]);
    expect(calls[0]!.cmd).toBe('codex');
    expect(calls[0]!.cwd).toBe('/w');
  });

  it('a spawn failure is a single error event', async () => {
    const lineStream: LineStreamFn = async function* () {
      throw new Error('spawn codex ENOENT');
    };
    const events = await collect(new CodexAdapter({ lineStream, env: {} }).stream({ prompt: 'go' }));
    expect(events).toEqual([{ type: 'error', message: 'spawn codex ENOENT' }]);
  });

  it('a non-zero exit with nothing parsed is one error carrying the exit code and stderr tail', async () => {
    const { lineStream } = lines([], { exitCode: 1, stderrTail: 'thread/resume failed: no rollout found for thread id x' });
    const events = await collect(new CodexAdapter({ lineStream, env: {} }).stream({ prompt: 'go' }));
    expect(events).toHaveLength(1);
    const err = events[0] as Extract<RunEvent, { type: 'error' }>;
    expect(err.type).toBe('error');
    expect(err.message).toContain('code 1');
    expect(err.message).toContain('no rollout found for thread id');
  });

  it('a timeout ends with done/incomplete and a note, never an error', async () => {
    const { lineStream } = lines([JSON.stringify({ type: 'thread.started', thread_id: THREAD })], {
      timedOut: true,
      exitCode: null,
    });
    const events = await collect(new CodexAdapter({ lineStream, env: {} }).stream({ prompt: 'go', timeoutMs: 900 }));
    expect(events.map((e) => e.type)).toEqual(['session', 'done']);
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result).toMatchObject({ status: 'incomplete', conversationId: THREAD, note: 'timed out after 900ms' });
  });

  it('an explicit error event ends with done/error carrying the vendor message', async () => {
    const { lineStream } = lines([
      JSON.stringify({ type: 'thread.started', thread_id: THREAD }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } }),
    ], { exitCode: 1 });
    const events = await collect(new CodexAdapter({ lineStream, env: {} }).stream({ prompt: 'go' }));
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.result.status).toBe('error');
    expect(done.result.note).toContain('stream disconnected');
  });

  it('a blank prompt throws synchronously', () => {
    const { calls, lineStream } = lines([]);
    expect(() => new CodexAdapter({ lineStream, env: {} }).stream({ prompt: '  ' })).toThrow(AgentMeshError);
    expect(calls).toHaveLength(0);
  });
});

describe('resumed turns (resumeId)', () => {
  it('argv: exec resume <id> --json --model <m> -c sandbox_mode="<mode>" + MCP overrides, prompt last', async () => {
    const { calls, lineStream } = lines(RUN_LINES);
    const a = new CodexAdapter({ lineStream, env: {}, readTextFile: fixedReader(null) });
    await collect(
      a.stream({
        prompt: 'next',
        resumeId: ` ${THREAD} `,
        model: 'gpt-6-luna',
        permissionMode: 'workspace-write',
        mcp: MCP,
      }),
    );
    expect(calls[0]!.args).toEqual([
      'exec',
      'resume',
      THREAD,
      '--json',
      '--model',
      'gpt-6-luna',
      '-c',
      'sandbox_mode="workspace-write"',
      ...MCP_ARGS,
      '--',
      'next',
    ]);
    expect(calls[0]!.args).not.toContain('--sandbox');
  });

  it('REFUSES a resume without a model — stream() throws at call time, run() rejects, nothing spawns', async () => {
    const { calls, lineStream } = lines(RUN_LINES);
    const rec = recordingExec({ stdout: jsonl(...RUN_EVENTS) });
    const a = new CodexAdapter({ lineStream, exec: rec.exec, env: {} });
    expect(() => a.stream({ prompt: 'next', resumeId: THREAD })).toThrow(/^Codex resume needs a model \(-m\): /);
    expect(() => a.stream({ prompt: 'next', resumeId: THREAD, model: '   ' })).toThrow(AgentMeshError);
    await expect(a.run({ prompt: 'next', resumeId: THREAD })).rejects.toThrow(/Codex resume needs a model \(-m\)/);
    expect(calls).toHaveLength(0);
    expect(rec.calls).toHaveLength(0);
  });

  it('run() honours resumeId with the same argv', async () => {
    const rec = recordingExec({ stdout: jsonl(...RUN_EVENTS) });
    const a = new CodexAdapter({ exec: rec.exec, env: {}, readTextFile: fixedReader(null) });
    const r = await a.run({ prompt: 'next', resumeId: THREAD, model: 'gpt-6-luna' });
    expect(rec.calls[0]!.args).toEqual(['exec', 'resume', THREAD, '--json', '--model', 'gpt-6-luna', '--', 'next']);
    expect(r.conversationId).toBe(THREAD);
  });

  it('session comes only from the stream: none reported → no session event, the result falls back to resumeId', async () => {
    const { lineStream } = lines([
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'ok' } }),
    ]);
    const a = new CodexAdapter({ lineStream, env: {}, readTextFile: fixedReader(null) });
    const events = await collect(a.stream({ prompt: 'next', resumeId: THREAD, model: 'gpt-6-luna' }));
    expect(events.some((e) => e.type === 'session')).toBe(false);
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.conversationId).toBe(THREAD);
  });

  it('reports the thread the CLI actually used when it differs from resumeId', async () => {
    const other = '019a3b7c-9999-7222-8333-444455556666';
    const { lineStream } = lines([
      JSON.stringify({ type: 'thread.started', thread_id: other }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'ok' } }),
    ]);
    const a = new CodexAdapter({ lineStream, env: {}, readTextFile: fixedReader(null) });
    const events = await collect(a.stream({ prompt: 'next', resumeId: THREAD, model: 'gpt-6-luna' }));
    expect(events.filter((e) => e.type === 'session')).toEqual([{ type: 'session', conversationId: other }]);
    expect((events.at(-1) as Extract<RunEvent, { type: 'done' }>).result.conversationId).toBe(other);
  });

  it('refuses a blank or flag-shaped resumeId, and resumeId together with sessionId', () => {
    const { lineStream } = lines([]);
    const a = new CodexAdapter({ lineStream, env: {} });
    expect(() => a.stream({ prompt: 'p', model: 'm', resumeId: '  ' })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', model: 'm', resumeId: '--last' })).toThrow(AgentMeshError);
    expect(() =>
      a.stream({ prompt: 'p', model: 'm', resumeId: THREAD, sessionId: '0b6f1c1e-3f7a-4c55-9a51-6f3a8f5e2b10' }),
    ).toThrow(/mutually exclusive/);
  });

  it('refuses a control character in a resumed permissionMode (it becomes a TOML string)', () => {
    const a = new CodexAdapter({ lineStream: lines([]).lineStream, env: {} });
    expect(() => a.stream({ prompt: 'p', model: 'm', resumeId: THREAD, permissionMode: 'a\nb' })).toThrow(AgentMeshError);
  });
});

describe('MCP wiring (-c overrides)', () => {
  it('first turn: the three overrides after model/sandbox, before extra.args', async () => {
    const { calls, lineStream } = lines(RUN_LINES);
    const a = new CodexAdapter({ lineStream, env: {}, readTextFile: fixedReader(null) });
    await collect(
      a.stream({ prompt: 'p', model: 'gpt-6-luna', permissionMode: 'workspace-write', mcp: MCP, extra: { args: ['--x'] } }),
    );
    expect(calls[0]!.args).toEqual([
      'exec',
      '--json',
      '--model',
      'gpt-6-luna',
      '--sandbox',
      'workspace-write',
      ...MCP_ARGS,
      '--x',
      '--',
      'p',
    ]);
  });

  it('spells the values as TOML basic strings: backslashes and quotes escaped', async () => {
    const { calls, lineStream } = lines(RUN_LINES);
    const a = new CodexAdapter({ lineStream, env: {} });
    await collect(
      a.stream({
        prompt: 'p',
        mcp: { ...MCP, command: 'C:\\Program Files\\node.exe', args: ['say "hi"', 'back\\slash'] },
      }),
    );
    const args = calls[0]!.args;
    expect(args).toContain('mcp_servers.team.command="C:\\\\Program Files\\\\node.exe"');
    expect(args).toContain('mcp_servers.team.args=["say \\"hi\\"","back\\\\slash"]');
  });

  it('refuses an invalid attachment before anything spawns', () => {
    const a = new CodexAdapter({ lineStream: lines([]).lineStream, env: {} });
    expect(() => a.stream({ prompt: 'p', mcp: { ...MCP, name: 'bad-name' } })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', mcp: { ...MCP, args: ['ok', 'new\nline'] } })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', mcp: { ...MCP, configFile: 'relative.json' } })).toThrow(AgentMeshError);
  });

  it('notes the Claude-only fields and an unusable projectConfigFile on the done result', async () => {
    const { lineStream } = lines(RUN_LINES);
    const a = new CodexAdapter({ lineStream, env: {} });
    const events = await collect(
      a.stream({
        prompt: 'p',
        sessionId: '0b6f1c1e-3f7a-4c55-9a51-6f3a8f5e2b10',
        disallowedTools: ['SendMessage'],
        settingSources: 'user',
        elevated: true,
        unattended: true,
        mcp: { ...MCP, projectConfigFile: '/w/.mcp.json' },
      }),
    );
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe(
      'sessionId not supported by codex (the thread id comes from thread.started); ignored; ' +
        'disallowedTools not supported by codex; ignored; ' +
        'settingSources not supported by codex; ignored; ' +
        'elevated has no codex equivalent (the sandbox comes from permissionMode); ignored; ' +
        'mcp.projectConfigFile is not supported by codex; ignored',
    );
  });
});

describe('the --skip-git-repo-check option', () => {
  it('is added to a first turn only, never to a resume', async () => {
    const first = lines(RUN_LINES);
    const a = new CodexAdapter({ lineStream: first.lineStream, env: {}, skipGitRepoCheck: true });
    await collect(a.stream({ prompt: 'p' }));
    expect(first.calls[0]!.args).toEqual(['exec', '--json', '--skip-git-repo-check', '--', 'p']);

    const resumed = lines(RUN_LINES);
    const b = new CodexAdapter({ lineStream: resumed.lineStream, env: {}, skipGitRepoCheck: true, readTextFile: fixedReader(null) });
    await collect(b.stream({ prompt: 'p', resumeId: THREAD, model: 'gpt-6-luna' }));
    expect(resumed.calls[0]!.args).not.toContain('--skip-git-repo-check');
  });
});

describe('RunOptions', () => {
  it('stream() and run() spawn ONLY through options.lineStream', async () => {
    const perRun = lines(RUN_LINES);
    const rec = recordingExec();
    const a = new CodexAdapter({ lineStream: forbiddenLineStream, exec: rec.exec, env: {} });
    const events = await collect(a.stream({ prompt: 'p' }, { lineStream: perRun.lineStream }));
    expect(events.at(-1)!.type).toBe('done');
    const r = await a.run({ prompt: 'p' }, { lineStream: perRun.lineStream });
    expect(r.text).toBe('Done.');
    expect(perRun.calls).toHaveLength(2);
    expect(rec.calls).toHaveLength(0);
  });

  it('options.env is the child env verbatim: no CODEX_HOME of the adapter’s own', async () => {
    const perRun = lines(RUN_LINES);
    const a = new CodexAdapter({ env: { CODEX_HOME: '/ambient' }, defaultAccount: { vendor: 'codex', configDir: '/default' } });
    const callerEnv = { CODEX_HOME: '/accounts/b', PATH: '/bin', MARKER: 't-1' };
    const events = await collect(
      a.stream({ prompt: 'p', account: { vendor: 'codex', configDir: '/explicit' } }, { lineStream: perRun.lineStream, env: callerEnv }),
    );
    expect(perRun.calls[0]!.env).toEqual(callerEnv);
    expect(perRun.calls[0]!.env).not.toBe(callerEnv);
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe('account.configDir not applied: options.env is the complete child environment');
  });

  it('with options.env the model gate reads the login the child will run as (CODEX_HOME from that env)', async () => {
    const perRun = lines(RUN_LINES);
    const reads: string[] = [];
    const a = new CodexAdapter({
      env: { CODEX_HOME: '/ambient' },
      readTextFile: async (p) => {
        reads.push(p);
        return JSON.stringify({ tokens: { access_token: 't' } }); // a ChatGPT login
      },
    });
    const events = await collect(
      a.stream({ prompt: 'p', model: 'gpt-5.2' }, { lineStream: perRun.lineStream, env: { CODEX_HOME: '/accounts/b' } }),
    );
    expect(reads).toEqual(['/accounts/b/auth.json']);
    // gpt-5.2 is API-key-only: under a ChatGPT login the run is refused before any spawn.
    expect(events).toEqual([
      { type: 'error', message: 'model gpt-5.2 requires api-key auth; current login is chatgpt' },
    ]);
    expect(perRun.calls).toHaveLength(0);
  });

  it('skipAuthCheck: the login is never read; an off-catalog model still gets its note', async () => {
    const perRun = lines(RUN_LINES);
    const reads: string[] = [];
    const a = new CodexAdapter({
      env: {},
      readTextFile: async (p) => {
        reads.push(p);
        return null;
      },
    });
    const events = await collect(
      a.stream({ prompt: 'p', model: 'gpt-next-preview' }, { lineStream: perRun.lineStream, skipAuthCheck: true }),
    );
    expect(reads).toEqual([]);
    expect(perRun.calls).toHaveLength(1);
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe('model gpt-next-preview not in known catalog');
  });

  it('skipAuthCheck lets the caller run a model its own check allowed (no login-based refusal)', async () => {
    const perRun = lines(RUN_LINES);
    const a = new CodexAdapter({ env: {}, readTextFile: fixedReader(JSON.stringify({ tokens: { access_token: 't' } })) });
    const r = await a.run({ prompt: 'p', model: 'gpt-5.2' }, { lineStream: perRun.lineStream, skipAuthCheck: true });
    expect(r.status).toBe('ok');
    expect(perRun.calls[0]!.args).toContain('gpt-5.2');
  });
});

describe('appendSystemPromptFile (no codex flag: the content is prefixed)', () => {
  it('prefixes the file content to the prompt and says so', async () => {
    const perRun = lines(RUN_LINES);
    const reads: string[] = [];
    const a = new CodexAdapter({
      env: {},
      readTextFile: async (p) => {
        reads.push(p);
        return '  # Brief\nYou are member b.\n\n';
      },
    });
    const events = await collect(
      a.stream({ prompt: 'do it', appendSystemPromptFile: '/data/members/b/brief.md' }, { lineStream: perRun.lineStream }),
    );
    expect(reads).toEqual(['/data/members/b/brief.md']);
    const args = perRun.calls[0]!.args;
    expect(args[args.length - 1]).toBe('# Brief\nYou are member b.\n\ndo it');
    expect(args[args.length - 2]).toBe('--');
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe(
      'appendSystemPromptFile: codex has no system-prompt flag; its content was prefixed to the prompt',
    );
  });

  it('an unreadable file ends the stream with one error and spawns nothing; run() rejects', async () => {
    const perRun = lines(RUN_LINES);
    const a = new CodexAdapter({ env: {}, readTextFile: fixedReader(null) });
    const events = await collect(
      a.stream({ prompt: 'p', appendSystemPromptFile: '/missing/brief.md' }, { lineStream: perRun.lineStream }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
    expect(perRun.calls).toHaveLength(0);
    await expect(
      a.run({ prompt: 'p', appendSystemPromptFile: '/missing/brief.md' }, { lineStream: perRun.lineStream }),
    ).rejects.toBeInstanceOf(AgentMeshError);
  });

  it('a relative path throws before anything is read', () => {
    const a = new CodexAdapter({ env: {}, lineStream: lines([]).lineStream });
    expect(() => a.stream({ prompt: 'p', appendSystemPromptFile: 'brief.md' })).toThrow(AgentMeshError);
  });
});

describe('interactiveResume()', () => {
  it('is not provided for Codex in this release', () => {
    expect(new CodexAdapter({ env: {} }).interactiveResume('t-1')).toBeUndefined();
  });
});
