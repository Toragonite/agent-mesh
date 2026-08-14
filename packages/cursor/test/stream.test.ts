import { describe, it, expect } from 'vitest';
import { AgentMeshError, type ModelInfo, type RunEvent } from '@toragonite/agent-mesh';
import { CursorAdapter } from '../src/adapter.js';
import { fakeLineStream, throwingLineStream, STREAM_LINES } from './helpers.js';

async function collect(gen: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function textOf(events: RunEvent[]): string[] {
  return events
    .filter((e): e is Extract<RunEvent, { type: 'text' }> => e.type === 'text')
    .map((t) => t.text);
}

describe('stream() event mapping — the duplication trap (ground truth E)', () => {
  it('emits text events totalling exactly RAW-C, suppressing the final timestamp-less repeat', async () => {
    const { lineStream } = fakeLineStream(STREAM_LINES);
    const a = new CursorAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'Say only: RAW-C' }));

    const texts = events.filter((e): e is Extract<RunEvent, { type: 'text' }> => e.type === 'text');
    expect(texts.map((t) => t.text)).toEqual(['RAW', '-C']);
    const joined = texts.map((t) => t.text).join('');
    expect(joined).toBe('RAW-C');
    expect(joined).not.toBe('RAW-CRAW-C');

    // thinking and user events emit nothing.
    expect(events.some((e) => e.type === 'tool')).toBe(false);

    // then a usage event and a done event equal to what run() would produce.
    const usage = events.find((e) => e.type === 'usage') as Extract<RunEvent, { type: 'usage' }>;
    expect(usage.usage).toEqual({
      inputTokens: 14186,
      outputTokens: 36,
      cachedInputTokens: 5957,
      totalTokens: 14222,
    });
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.result).toMatchObject({
      vendor: 'cursor',
      conversationId: 'fe11978d',
      text: 'RAW-C',
      status: 'ok',
    });
  });

  it('A1: keeps a legitimate repeated delta — "abc"+"abc" yields "abcabc", not "abc"', async () => {
    // Both deltas are properly TIMESTAMPED; only the final full-answer repeat lacks timestamp_ms.
    // A text-equality guard would swallow the second "abc"; suppression must key on the
    // timestamp-less discriminator ALONE.
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'Composer 2.5' }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'abc' }] },
        session_id: 's',
        timestamp_ms: 1,
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'abc' }] },
        session_id: 's',
        timestamp_ms: 2,
      }),
      // Final full-answer repeat — no timestamp_ms — must be the ONLY suppressed event.
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'abcabc' }] },
        session_id: 's',
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'abcabc',
        session_id: 's',
      }),
    ];
    const { lineStream } = fakeLineStream(lines);
    const a = new CursorAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'Say only: abcabc' }));

    const texts = textOf(events);
    expect(texts).toEqual(['abc', 'abc']);
    expect(texts.join('')).toBe('abcabc');
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.text).toBe('abcabc');
  });

  it('never sets RunResult.model from the system/init display name', async () => {
    const { lineStream } = fakeLineStream(STREAM_LINES);
    const a = new CursorAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'hi' }));
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    // 'Composer 2.5' is a display name, not a selectable id — it must not become model.
    expect(done.result.model).toBeUndefined();
  });

  it('carries the requested model through to the done result', async () => {
    const { lineStream } = fakeLineStream(STREAM_LINES);
    const a = new CursorAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'hi', model: 'composer-2.5' }));
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.result.model).toBe('composer-2.5');
  });
});

describe('stream() failure fidelity', () => {
  it('mirrors run() on a timeout: a done/incomplete result with partial text, never an error', async () => {
    const partial = STREAM_LINES.slice(0, 6); // init, user, 2x thinking, RAW, -C — no result event
    const { lineStream } = fakeLineStream(partial, { timedOut: true, exitCode: null });
    const a = new CursorAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'hi', timeoutMs: 500 }));
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.result).toMatchObject({
      vendor: 'cursor',
      conversationId: 'fe11978d',
      text: 'RAW-C',
      status: 'incomplete',
      note: 'timed out after 500ms',
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('emits an error with the exit code when the stream ends without a result event', async () => {
    const partial = STREAM_LINES.slice(0, 6);
    const { lineStream } = fakeLineStream(partial, { timedOut: false, exitCode: 1, stderrTail: 'kaboom' });
    const a = new CursorAdapter({ lineStream, env: {} });
    const events = await collect(a.stream({ prompt: 'hi' }));
    const err = events.at(-1) as Extract<RunEvent, { type: 'error' }>;
    expect(err.type).toBe('error');
    expect(err.message).toContain('exit 1');
    expect(err.message).toContain('kaboom');
  });

  it('surfaces a trust refusal during streaming as an error with remediation wording', async () => {
    const { lineStream } = fakeLineStream([], {
      timedOut: false,
      exitCode: 1,
      stderrTail: '⚠ Workspace Trust Required — pass --trust',
    });
    const a = new CursorAdapter({ lineStream, env: {}, trust: false });
    const events = await collect(a.stream({ prompt: 'hi', cwd: '/untrusted' }));
    const err = events.at(-1) as Extract<RunEvent, { type: 'error' }>;
    expect(err.type).toBe('error');
    expect(err.message).toContain('trust');
    expect(err.message).toContain('/untrusted');
  });

  it('A4: detects a trust refusal printed on STDOUT (not just the stderr tail)', async () => {
    // Ground truth: the refusal banner is on stdout and the process exits non-zero with an
    // EMPTY stderr tail. Detection must scan the stream's own output, not the tail alone.
    const { lineStream } = fakeLineStream(
      ['⚠ Workspace Trust Required', 'Pass --trust, --yolo, or -f if you trust this directory'],
      { timedOut: false, exitCode: 1, stderrTail: '' },
    );
    const a = new CursorAdapter({ lineStream, env: {}, trust: false });
    const events = await collect(a.stream({ prompt: 'hi', cwd: '/untrusted' }));
    const err = events.at(-1) as Extract<RunEvent, { type: 'error' }>;
    expect(err.type).toBe('error');
    expect(err.message).toContain('trust');
    expect(err.message).toContain('/untrusted');
    expect(err.message).toContain('exit 1');
  });

  it('emits a single error event when the stream process fails to spawn', async () => {
    const a = new CursorAdapter({ lineStream: throwingLineStream(new Error('spawn boom')), env: {} });
    const events = await collect(a.stream({ prompt: 'hi' }));
    expect(events).toEqual([{ type: 'error', message: 'spawn boom' }]);
  });

  it('throws AgentMeshError synchronously for a blank prompt (eager validation)', () => {
    const { lineStream } = fakeLineStream([]);
    const a = new CursorAdapter({ lineStream, env: {} });
    expect(() => a.stream({ prompt: '  ' })).toThrow(AgentMeshError);
  });
});

describe('A5/U7: stream() done carries every note run() would attach', () => {
  const MODELS: ModelInfo[] = [{ id: 'composer-2.5', latencyClass: 'fast' }];

  it('folds the unknown-model, ignored-allowedTools and ignored-configDir notes into done.result.note', async () => {
    const { lineStream } = fakeLineStream(STREAM_LINES);
    const a = new CursorAdapter({
      lineStream,
      env: {},
      models: MODELS,
      defaultAccount: { vendor: 'cursor', configDir: '/default' },
    });
    const events = await collect(
      a.stream({
        prompt: 'hi',
        model: 'off-catalog-model',
        allowedTools: ['Read'],
        extra: { args: ['--flag', 42, true] },
      }),
    );
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.result.note).toBe(
      'allowedTools not supported by cursor-agent; ignored; ' +
        'account.configDir is not supported by cursor-agent; ignored; ' +
        'model off-catalog-model not in known catalog; ' +
        'extra.args contained 2 non-string entries; dropped',
    );
  });
});
