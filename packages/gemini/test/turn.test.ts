import { describe, it, expect } from 'vitest';
import { AgentMeshError, type McpAttachment, type RunEvent } from '@toragonite/agent-mesh';
import { GeminiAdapter } from '../src/adapter.js';
import type { LineStreamFn } from '../src/exec.js';
import { recordingExec, recordingLineStream, jsonl, collect } from './helpers.js';

/* ------------------------------------------------------------------------- *
 * 0.1.3 — the turn lane on agy: --conversation, --mode on every turn, the
 * prompt directly after -p, --dangerously-skip-permissions ONLY when elevated,
 * the session event (including the SILENT new conversation for an unknown id),
 * and RunOptions. Fake seams only: no real CLI.
 * ------------------------------------------------------------------------- */

const CONV = 'c0a1b2c3-1111-4222-8333-444455556666';
const OTHER = 'd0a1b2c3-9999-4222-8333-444455556666';

const MCP: McpAttachment = {
  name: 'team',
  command: '/usr/local/bin/node',
  args: ['/data/mcp/cli.js', '--serve', '/data/members/d/spec.json'],
  configFile: '/data/members/d/mcp.json',
};

/** An agy stream-json turn whose CLI reports `id` (init line first, as agy 1.3.6 prints it). */
function turnLines(id: string, response = 'OK\n'): string[] {
  return [
    JSON.stringify({ event: 'init', conversation_id: id }),
    JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: id, step_type: 'agent_response', text_delta: response },
    }),
    JSON.stringify({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response } }),
  ];
}

const forbiddenLineStream: LineStreamFn = async function* () {
  throw new Error('the constructor lineStream must not be used when options.lineStream is given');
};

describe('turn-lane argv (exact)', () => {
  it('first turn, elevated with MCP: --mode then --dangerously-skip-permissions, the prompt directly after -p', async () => {
    const { lineStream, calls } = recordingLineStream(turnLines(CONV));
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(
      a.stream({
        prompt: 'go',
        model: 'gemini-3.6-flash-high',
        permissionMode: 'accept-edits',
        mcp: MCP,
        elevated: true,
        cwd: '/wt',
      }),
    );
    expect(calls[0]!.args).toEqual([
      '--output-format',
      'stream-json',
      '--model',
      'gemini-3.6-flash-high',
      '--mode',
      'accept-edits',
      '--dangerously-skip-permissions',
      '-p',
      'go',
    ]);
    expect(calls[0]!.cwd).toBe('/wt');
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBeUndefined();
  });

  it('resumed turn: --conversation <id> + the same flags, --mode again; no skip flag unless elevated', async () => {
    const { lineStream, calls } = recordingLineStream(turnLines(CONV));
    const a = new GeminiAdapter({ lineStream, env: {} });
    await collect(a.stream({ prompt: 'next', resumeId: ` ${CONV} `, permissionMode: 'accept-edits' }));
    expect(calls[0]!.args).toEqual([
      '--conversation',
      CONV,
      '--output-format',
      'stream-json',
      '--mode',
      'accept-edits',
      '-p',
      'next',
    ]);
  });

  it('run() honours resumeId with the json argv', async () => {
    const { exec, calls } = recordingExec({ stdout: jsonl({ conversation_id: CONV, status: 'SUCCESS', response: 'ok' }) });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'again', resumeId: CONV, permissionMode: 'accept-edits' });
    expect(calls[0]!.args).toEqual(['--conversation', CONV, '--output-format', 'json', '--mode', 'accept-edits', '-p', 'again']);
    expect(r.conversationId).toBe(CONV);
  });

  it('an MCP attachment without elevated adds no flag and says the tools will not be called', async () => {
    const { lineStream, calls } = recordingLineStream(turnLines(CONV));
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'go', mcp: MCP }));
    expect(calls[0]!.args).toEqual(['--output-format', 'stream-json', '-p', 'go']);
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe(
      'mcp: agy print mode calls MCP tools only with elevated (--dangerously-skip-permissions); without it the tools are not called',
    );
  });

  it('keeps a flag-shaped prompt as the single value of -p', async () => {
    const { lineStream, calls } = recordingLineStream(turnLines(CONV));
    const a = new GeminiAdapter({ lineStream, env: {} });
    await collect(a.stream({ prompt: '--conversation evil', resumeId: CONV }));
    const args = calls[0]!.args;
    expect(args.slice(-2)).toEqual(['-p', '--conversation evil']);
  });
});

describe('the session event — and the SILENT new conversation for an unknown id', () => {
  it('reports the init line’s id once', async () => {
    const { lineStream } = recordingLineStream(turnLines(CONV));
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'go', resumeId: CONV }));
    expect(events.map((e) => e.type)).toEqual(['session', 'text', 'done']);
    expect(events[0]).toEqual({ type: 'session', conversationId: CONV });
  });

  it('an unknown id: agy starts a NEW conversation and the run reports THAT id, not resumeId', async () => {
    const { lineStream } = recordingLineStream(turnLines(OTHER), {
      stderrTail: `warning: conversation "${CONV}" not found`,
    });
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'go', resumeId: CONV }));
    expect(events.filter((e) => e.type === 'session')).toEqual([{ type: 'session', conversationId: OTHER }]);
    expect((events.at(-1) as Extract<RunEvent, { type: 'done' }>).result.conversationId).toBe(OTHER);
  });

  it('no id reported: no session event (never synthesized); the result falls back to resumeId', async () => {
    const { lineStream } = recordingLineStream([
      JSON.stringify({ event: 'result', result: { conversation_id: '', status: 'SUCCESS', response: 'ok' } }),
    ]);
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'go', resumeId: CONV }));
    expect(events.some((e) => e.type === 'session')).toBe(false);
    expect((events.at(-1) as Extract<RunEvent, { type: 'done' }>).result.conversationId).toBe(CONV);
  });

  it('a different id on the terminal payload is reported before done', async () => {
    const { lineStream } = recordingLineStream([
      JSON.stringify({ event: 'init', conversation_id: CONV }),
      JSON.stringify({ event: 'result', result: { conversation_id: OTHER, status: 'SUCCESS', response: 'ok' } }),
    ]);
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'go' }));
    expect(events.map((e) => e.type)).toEqual(['session', 'session', 'done']);
    expect(events[1]).toEqual({ type: 'session', conversationId: OTHER });
  });

  it('ends with exactly one done: lines after the result are drained but emit nothing', async () => {
    const { lineStream } = recordingLineStream([
      ...turnLines(CONV),
      JSON.stringify({
        event: 'step_update',
        step_update: { conversation_id: OTHER, step_type: 'agent_response', text_delta: 'late' },
      }),
      JSON.stringify({ event: 'result', result: { conversation_id: OTHER, status: 'SUCCESS', response: 'again' } }),
    ]);
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'go' }));
    expect(events.map((e) => e.type)).toEqual(['session', 'text', 'done']);
  });

  it('a seam failure after the terminal done does not add an error event', async () => {
    const lineStream: LineStreamFn = async function* () {
      for (const l of turnLines(CONV)) yield l;
      throw new Error('teardown failed');
    };
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'go' }));
    expect(events.at(-1)!.type).toBe('done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});

describe('turn-lane validation and notes', () => {
  it('throws synchronously before any spawn for invalid turn-lane fields', () => {
    const { lineStream, calls } = recordingLineStream([]);
    const a = new GeminiAdapter({ lineStream, env: {} });
    expect(() => a.stream({ prompt: 'p', resumeId: ' ' })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', resumeId: '--conversation' })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', resumeId: CONV, sessionId: CONV })).toThrow(/mutually exclusive/);
    expect(() => a.stream({ prompt: 'p', appendSystemPromptFile: 'brief.md' })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', mcp: { ...MCP, name: '' } })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', mcp: { ...MCP, command: '' } })).toThrow(AgentMeshError);
    expect(() => a.stream({ prompt: 'p', disallowedTools: {} as unknown as string[] })).toThrow(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('run() rejects the same way, with nothing spawned', async () => {
    const { exec, calls } = recordingExec();
    const a = new GeminiAdapter({ exec, env: {} });
    await expect(a.run({ prompt: 'p', resumeId: '-c' })).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('notes what agy cannot honour, after the 0.1.2 notes', async () => {
    const { lineStream } = recordingLineStream(turnLines(CONV));
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(
      a.stream({
        prompt: 'p',
        allowedTools: ['x'],
        sessionId: CONV,
        disallowedTools: ['SendMessage'],
        settingSources: 'user',
        unattended: true,
        elevated: true,
        mcp: { ...MCP, projectConfigFile: '/wt/.mcp.json' },
      }),
    );
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe(
      'allowedTools not supported by agy; ignored; ' +
        'sessionId not supported by agy (the id comes from the init event); ignored; ' +
        'disallowedTools not supported by agy; ignored; ' +
        'settingSources not supported by agy; ignored; ' +
        'mcp.projectConfigFile is not supported by agy; ignored',
    );
  });
});

describe('RunOptions and the system-prompt file', () => {
  it('stream() and run() spawn ONLY through options.lineStream, with options.env verbatim (no AGY_HOME)', async () => {
    const perRun = recordingLineStream(turnLines(CONV));
    const rec = recordingExec();
    const a = new GeminiAdapter({
      lineStream: forbiddenLineStream,
      exec: rec.exec,
      env: { AMBIENT: '1' },
      defaultAccount: { vendor: 'gemini', configDir: '/default/home' },
    });
    const callerEnv = { HOME: '/home/u', MARKER: 't-4' };
    const events = await collect(
      a.stream({ prompt: 'p', account: { vendor: 'gemini', configDir: '/explicit' } }, { lineStream: perRun.lineStream, env: callerEnv }),
    );
    expect(perRun.calls[0]!.env).toEqual(callerEnv);
    expect(perRun.calls[0]!.env).not.toBe(callerEnv);
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe('account.configDir not applied: options.env is the complete child environment');

    const runSeam = recordingLineStream([jsonl({ conversation_id: CONV, status: 'SUCCESS', response: 'ran\n' })]);
    const r = await a.run({ prompt: 'p' }, { lineStream: runSeam.lineStream, env: callerEnv });
    expect(r.text).toBe('ran');
    expect(runSeam.calls[0]!.env).toEqual(callerEnv);
    expect(rec.calls).toHaveLength(0);
  });

  it('prefixes an appendSystemPromptFile’s content into the -p value and says so', async () => {
    const { lineStream, calls } = recordingLineStream(turnLines(CONV));
    const reads: string[] = [];
    const a = new GeminiAdapter({
      lineStream,
      env: {},
      readTextFile: async (p) => {
        reads.push(p);
        return '\nYou are member d.\n';
      },
    });
    const events = await collect(a.stream({ prompt: 'work', appendSystemPromptFile: '/data/members/d/brief.md' }));
    expect(reads).toEqual(['/data/members/d/brief.md']);
    expect(calls[0]!.args.slice(-2)).toEqual(['-p', 'You are member d.\n\nwork']);
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe(
      'appendSystemPromptFile: agy has no system-prompt flag; its content was prefixed to the prompt',
    );
  });

  it('an unreadable system-prompt file ends the stream with one error and spawns nothing', async () => {
    const { lineStream, calls } = recordingLineStream(turnLines(CONV));
    const a = new GeminiAdapter({ lineStream, env: {}, readTextFile: async () => null });
    const events = await collect(a.stream({ prompt: 'work', appendSystemPromptFile: '/missing.md' }));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it('interactiveResume() is not provided for Antigravity in this release', () => {
    expect(new GeminiAdapter({ env: {} }).interactiveResume(CONV)).toBeUndefined();
  });
});
