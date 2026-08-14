import { describe, it, expect } from 'vitest';
import { AgentMeshError, type RunEvent } from '@toragonite/agent-mesh';
import { GeminiAdapter } from '../src/adapter.js';
import { recordingExec, recordingLineStream, jsonl, collect } from './helpers.js';

/** Ground truth G — the captured stream, plus a garbage line interleaved. */
const RESULT_PAYLOAD = {
  conversation_id: '9a163f22',
  status: 'SUCCESS',
  response: 'RAW-A\n',
  duration_seconds: 3.4,
  num_turns: 1,
  usage: {
    input_tokens: 12067,
    output_tokens: 199,
    thinking_tokens: 192,
    cache_read_tokens: 8145,
    total_tokens: 12266,
  },
};

const STREAM_LINES = [
  JSON.stringify({
    event: 'init',
    conversation_id: '9a163f22',
    init: { cwd: '/tmp/x', tools: ['run_command'], permission_mode: 'request-review' },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: '9a163f22', step_index: 0, state: 'DONE', step_type: 'user_input' },
  }),
  'progress: agent thinking...', // garbage interleaved — must be skipped
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: '9a163f22',
      step_index: 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'RAW-A\n',
      duration_seconds: 1.5,
      usage: { input_tokens: 11969, output_tokens: 195, thinking_tokens: 192, cache_read_tokens: 8145, total_tokens: 12164 },
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: '9a163f22', step_index: 3, state: 'DONE', step_type: 'checkpoint', duration_seconds: 0.9, usage: { input_tokens: 98, output_tokens: 4, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 102 } },
  }),
  JSON.stringify({ event: 'result', result: RESULT_PAYLOAD }),
];

describe('stream() over the captured payload (T14)', () => {
  it('emits exactly one text event, skips non-agent_response steps, then usage then done', async () => {
    const { lineStream } = recordingLineStream(STREAM_LINES);
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'hi' }));

    const textEvents = events.filter((e): e is Extract<RunEvent, { type: 'text' }> => e.type === 'text');
    expect(textEvents).toHaveLength(1);
    // The delta's single trailing newline is held back and dropped at end of stream (A2),
    // so the emitted text matches the newline-normalized done.text.
    expect(textEvents[0]!.text).toBe('RAW-A');

    const types = events.map((e) => e.type);
    expect(types).toEqual(['text', 'usage', 'done']);
  });

  it('the done result equals what run() would produce for the same payload', async () => {
    const { lineStream } = recordingLineStream(STREAM_LINES);
    const streamAdapter = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(streamAdapter.stream({ prompt: 'hi' }));
    const done = events.find((e) => e.type === 'done') as Extract<RunEvent, { type: 'done' }>;

    const { exec } = recordingExec({ stdout: jsonl(RESULT_PAYLOAD) });
    const runAdapter = new GeminiAdapter({ exec, env: {} });
    const runResult = await runAdapter.run({ prompt: 'hi' });

    expect(done.result).toEqual(runResult);
    expect(done.result.text).toBe('RAW-A');
    expect(done.result.usage).toEqual({
      inputTokens: 12067,
      outputTokens: 199,
      cachedInputTokens: 8145,
      totalTokens: 12266,
    });
  });
});

describe('stream() delta newline handling (A2)', () => {
  it('holds a trailing newline back so concatenated deltas equal done.text', async () => {
    const lines = [
      JSON.stringify({ event: 'init', conversation_id: 'c-nl' }),
      JSON.stringify({
        event: 'step_update',
        step_update: { conversation_id: 'c-nl', step_type: 'agent_response', text_delta: 'line1\n' },
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: { conversation_id: 'c-nl', step_type: 'agent_response', text_delta: 'line2\n' },
      }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'c-nl', status: 'SUCCESS', response: 'line1\nline2\n' },
      }),
    ];
    const { lineStream } = recordingLineStream(lines);
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'hi' }));

    const emitted = events
      .filter((e): e is Extract<RunEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.text)
      .join('');
    const done = events.find((e) => e.type === 'done') as Extract<RunEvent, { type: 'done' }>;
    expect(emitted).toBe('line1\nline2');
    expect(emitted).toBe(done.result.text); // concatenated deltas === final text, exactly
  });
});

describe('stream() bare terminal payload (A3)', () => {
  it('treats a last line with no {event:"result"} wrapper as the terminal result', async () => {
    const lines = [
      JSON.stringify({ event: 'init', conversation_id: '' }),
      // The error path emits the bare payload object (status/response) as the last line.
      JSON.stringify({
        conversation_id: '',
        status: 'ERROR',
        response: '',
        error: 'invalid model selection: model not-a-real is not recognized as a known model',
      }),
    ];
    const { lineStream } = recordingLineStream(lines, { exitCode: 1 });
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'hi' }));

    expect(events.some((e) => e.type === 'error')).toBe(false);
    const done = events.find((e) => e.type === 'done') as Extract<RunEvent, { type: 'done' }>;
    expect(done).toBeDefined();
    expect(done.result.status).toBe('error');
    expect(done.result.note).toContain('is not recognized as a known model');
  });
});

describe('stream() done notes match run() (U7)', () => {
  it('the done event carries the same composed notes run() would produce', async () => {
    const { lineStream } = recordingLineStream(STREAM_LINES);
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'hi', model: 'zzz', allowedTools: ['x'] }));
    const done = events.find((e) => e.type === 'done') as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.note).toBe(
      'allowedTools not supported by agy; ignored; model zzz not in known catalog',
    );
  });
});

describe('stream() degraded endings (T15)', () => {
  it('a timeout with no result event emits a done "incomplete" (never an error event)', async () => {
    const partialLines = [
      JSON.stringify({ event: 'init', conversation_id: 'c-stream' }),
      JSON.stringify({
        event: 'step_update',
        step_update: { conversation_id: 'c-stream', step_type: 'agent_response', text_delta: 'partial ' },
      }),
    ];
    const { lineStream } = recordingLineStream(partialLines, { timedOut: true, exitCode: null });
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'hi', timeoutMs: 500 }));

    expect(events.some((e) => e.type === 'error')).toBe(false);
    const done = events.find((e) => e.type === 'done') as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.status).toBe('incomplete');
    expect(done.result.note).toContain('timed out after 500ms');
    expect(done.result.text).toBe('partial ');
    expect(done.result.conversationId).toBe('c-stream');
  });

  it('a non-zero exit with no result event emits an error event carrying the exit code', async () => {
    const { lineStream } = recordingLineStream(
      [JSON.stringify({ event: 'init', conversation_id: 'c1' })],
      { exitCode: 7, stderrTail: 'agy: fatal' },
    );
    const a = new GeminiAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'hi' }));
    expect(events.some((e) => e.type === 'done')).toBe(false);
    const err = events.find((e) => e.type === 'error') as Extract<RunEvent, { type: 'error' }>;
    expect(err.message).toContain('exit 7');
    expect(err.message).toContain('agy: fatal');
  });
});

describe('stream() eager validation (T16)', () => {
  it('throws AgentMeshError synchronously at call time for an empty prompt', () => {
    const { lineStream, calls } = recordingLineStream([]);
    const a = new GeminiAdapter({ lineStream, env: {} });
    expect(() => a.stream({ prompt: '   ' })).toThrow(AgentMeshError);
    expect(calls).toHaveLength(0);
  });
});
