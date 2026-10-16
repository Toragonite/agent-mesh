import { describe, it, expect } from 'vitest';
import { AgentMeshError, type McpAttachment, type ModelInfo, type RunEvent } from '@toragonite/agent-mesh';
import { CursorAdapter, createChat } from '../src/adapter.js';
import type { LineStreamFn } from '../src/exec.js';
import { fakeLineStream, recordingExec, RESULT_JSON } from './helpers.js';

/* ------------------------------------------------------------------------- *
 * 0.1.3 — the turn lane on cursor-agent: --resume with a create-chat id,
 * --approve-mcps, --force only when elevated, the session event (including the
 * SILENT new chat for an unknown id), and RunOptions. Fake seams only.
 * ------------------------------------------------------------------------- */

const MODELS: ModelInfo[] = [{ id: 'composer-2.5', latencyClass: 'fast' }];
const CHAT = 'fe11978d-1111-4222-8333-444455556666';
const OTHER = 'aa11978d-9999-4222-8333-444455556666';

const MCP: McpAttachment = {
  name: 'team',
  command: '/usr/local/bin/node',
  args: ['/data/mcp/cli.js', '--serve', '/data/members/c/spec.json'],
  configFile: '/data/members/c/mcp.json',
};

/** A cursor-agent stream-json turn whose CLI reports `sessionId`. */
function turnLines(sessionId: string, text = 'OK'): string[] {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'Composer 2.5' }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      session_id: sessionId,
      timestamp_ms: 1,
    }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId }),
  ];
}

const forbiddenLineStream: LineStreamFn = async function* () {
  throw new Error('the constructor lineStream must not be used when options.lineStream is given');
};

async function collect(it: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('turn-lane argv (exact)', () => {
  it('a turn on a create-chat id: --trust --approve-mcps --resume <id> --model --sandbox, prompt last; no --force', async () => {
    const { lineStream, calls } = fakeLineStream(turnLines(CHAT));
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS });
    await collect(
      a.stream({ prompt: 'go', resumeId: CHAT, mcp: MCP, model: 'composer-2.5', permissionMode: 'enabled', cwd: '/wt' }),
    );
    expect(calls[0]!.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      '--approve-mcps',
      '--resume',
      CHAT,
      '--model',
      'composer-2.5',
      '--sandbox',
      'enabled',
      '--',
      'go',
    ]);
    expect(calls[0]!.cwd).toBe('/wt');
  });

  it('adds --force ONLY when the task is elevated (after --sandbox)', async () => {
    const { lineStream, calls } = fakeLineStream(turnLines(CHAT));
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS });
    await collect(a.stream({ prompt: 'go', resumeId: CHAT, permissionMode: 'enabled', elevated: true }));
    expect(calls[0]!.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      '--resume',
      CHAT,
      '--sandbox',
      'enabled',
      '--force',
      '--',
      'go',
    ]);
    await collect(a.stream({ prompt: 'go', resumeId: CHAT, elevated: false }));
    expect(calls[1]!.args).not.toContain('--force');
  });

  it('run() honours resumeId with the json argv', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    await a.run({ prompt: 'again', resumeId: ` ${CHAT} `, mcp: MCP });
    expect(calls[0]!.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--trust',
      '--approve-mcps',
      '--resume',
      CHAT,
      '--',
      'again',
    ]);
  });

  it('createChat() mints the id in the given cwd with the given env', async () => {
    const { exec, calls } = recordingExec({ stdout: `${CHAT}\n` });
    const env = { HOME: '/home/u', MARKER: 't-1' };
    expect(await createChat({ exec, cwd: '/wt', env })).toBe(CHAT);
    expect(calls[0]).toMatchObject({ cmd: 'cursor-agent', args: ['create-chat'], cwd: '/wt', env });
    expect(calls[0]!.env).not.toBe(env);
  });

  it('the createChat() id is the first turn’s resumeId (sessionId is not a cursor flag)', async () => {
    const chat = await createChat({ exec: recordingExec({ stdout: `${CHAT}\n` }).exec });
    const { lineStream, calls } = fakeLineStream(turnLines(CHAT));
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS });
    await collect(a.stream({ prompt: 'first', resumeId: chat! }));
    expect(calls[0]!.args.slice(calls[0]!.args.indexOf('--resume'), calls[0]!.args.indexOf('--resume') + 2)).toEqual([
      '--resume',
      CHAT,
    ]);
  });
});

describe('the session event — and the SILENT new chat for an unknown id', () => {
  it('reports the chat id once, from the CLI’s own stream', async () => {
    const { lineStream } = fakeLineStream(turnLines(CHAT));
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS });
    const events = await collect(a.stream({ prompt: 'go', resumeId: CHAT }));
    expect(events.filter((e) => e.type === 'session')).toEqual([{ type: 'session', conversationId: CHAT }]);
    expect(events[0]!.type).toBe('session');
    expect(events.at(-1)!.type).toBe('done');
  });

  it('an unknown well-formed id: the CLI starts a NEW chat and the run reports THAT id, not resumeId', async () => {
    const { lineStream } = fakeLineStream(turnLines(OTHER));
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS });
    const events = await collect(a.stream({ prompt: 'go', resumeId: CHAT }));
    expect(events.filter((e) => e.type === 'session')).toEqual([{ type: 'session', conversationId: OTHER }]);
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.conversationId).toBe(OTHER);
  });

  it('no id reported: no session event (never synthesized); the result falls back to resumeId', async () => {
    const { lineStream } = fakeLineStream([
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
    ]);
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS });
    const events = await collect(a.stream({ prompt: 'go', resumeId: CHAT }));
    expect(events.some((e) => e.type === 'session')).toBe(false);
    expect((events.at(-1) as Extract<RunEvent, { type: 'done' }>).result.conversationId).toBe(CHAT);
  });

  it('a timed-out resumed turn keeps the reported id (or resumeId when none was reported)', async () => {
    const { lineStream } = fakeLineStream([], { timedOut: true, exitCode: null });
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS });
    const events = await collect(a.stream({ prompt: 'go', resumeId: CHAT, timeoutMs: 100 }));
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result).toMatchObject({ status: 'incomplete', conversationId: CHAT });
  });

  it('ends with exactly one done: lines after the result are drained but emit nothing', async () => {
    const { lineStream } = fakeLineStream([
      ...turnLines(CHAT),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] },
        session_id: OTHER,
        timestamp_ms: 9,
      }),
    ]);
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS });
    const events = await collect(a.stream({ prompt: 'go' }));
    expect(events.map((e) => e.type)).toEqual(['session', 'text', 'done']);
  });

  it('a seam failure after the terminal done does not add an error event', async () => {
    const lineStream: LineStreamFn = async function* () {
      for (const l of turnLines(CHAT)) yield l;
      throw new Error('teardown failed');
    };
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS });
    const events = await collect(a.stream({ prompt: 'go' }));
    expect(events.at(-1)!.type).toBe('done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});

describe('turn-lane validation and notes', () => {
  it('throws synchronously before any spawn for invalid turn-lane fields', () => {
    const { lineStream, calls } = fakeLineStream([]);
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS });
    expect(() => a.stream({ prompt: 'p', resumeId: '  ' })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', resumeId: '-x' })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', resumeId: CHAT, sessionId: CHAT })).toThrow(/mutually exclusive/);
    expect(() => a.stream({ prompt: 'p', appendSystemPromptFile: 'rel.md' })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', mcp: { ...MCP, name: 'Team' } })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', mcp: { ...MCP, configFile: 'mcp.json' } })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', disallowedTools: 'x' as unknown as string[] })).toThrow(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('run() rejects the same way, with nothing spawned', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    await expect(a.run({ prompt: 'p', resumeId: '--last' })).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('notes what cursor-agent cannot honour, after the 0.1.2 notes', async () => {
    const { lineStream } = fakeLineStream(turnLines(CHAT));
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS });
    const events = await collect(
      a.stream({
        prompt: 'p',
        allowedTools: ['Read'],
        sessionId: CHAT,
        disallowedTools: ['SendMessage'],
        settingSources: 'user',
        unattended: true,
        mcp: { ...MCP, projectConfigFile: '/wt/.mcp.json' },
      }),
    );
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe(
      'allowedTools not supported by cursor-agent; ignored; ' +
        'sessionId not supported by cursor-agent (pre-allocate with createChat() and pass it as resumeId); ignored; ' +
        'disallowedTools not supported by cursor-agent; ignored; ' +
        'settingSources not supported by cursor-agent; ignored; ' +
        'mcp.projectConfigFile is not supported by cursor-agent; ignored',
    );
  });
});

describe('RunOptions and the system-prompt file', () => {
  it('stream() and run() spawn ONLY through options.lineStream, with options.env verbatim', async () => {
    const perRun = fakeLineStream(turnLines(CHAT));
    const rec = recordingExec();
    const a = new CursorAdapter({ lineStream: forbiddenLineStream, exec: rec.exec, env: { AMBIENT: '1' }, models: MODELS });
    const callerEnv = { HOME: '/home/u', MARKER: 't-9' };
    const events = await collect(a.stream({ prompt: 'p' }, { lineStream: perRun.lineStream, env: callerEnv }));
    expect(events.at(-1)!.type).toBe('done');
    expect(perRun.calls[0]!.env).toEqual(callerEnv);
    expect(perRun.calls[0]!.env).not.toBe(callerEnv);

    const runSeam = fakeLineStream([RESULT_JSON]);
    const r = await a.run({ prompt: 'p' }, { lineStream: runSeam.lineStream, env: callerEnv });
    expect(r.text).toBe('MESH-OK');
    expect(runSeam.calls[0]!.env).toEqual(callerEnv);
    expect(rec.calls).toHaveLength(0);
  });

  it('prefixes an appendSystemPromptFile’s content to the prompt and says so', async () => {
    const { lineStream, calls } = fakeLineStream(turnLines(CHAT));
    const reads: string[] = [];
    const a = new CursorAdapter({
      lineStream,
      env: {},
      models: MODELS,
      readTextFile: async (p) => {
        reads.push(p);
        return 'You are member c.\n';
      },
    });
    const events = await collect(a.stream({ prompt: 'work', appendSystemPromptFile: '/data/members/c/brief.md' }));
    expect(reads).toEqual(['/data/members/c/brief.md']);
    expect(calls[0]!.args.at(-1)).toBe('You are member c.\n\nwork');
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe(
      'appendSystemPromptFile: cursor-agent has no system-prompt flag; its content was prefixed to the prompt',
    );
  });

  it('an unreadable system-prompt file ends the stream with one error and spawns nothing', async () => {
    const { lineStream, calls } = fakeLineStream(turnLines(CHAT));
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS, readTextFile: async () => null });
    const events = await collect(a.stream({ prompt: 'work', appendSystemPromptFile: '/missing.md' }));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it('interactiveResume() is not provided for Cursor in this release', () => {
    expect(new CursorAdapter({ env: {} }).interactiveResume(CHAT)).toBeUndefined();
  });
});
