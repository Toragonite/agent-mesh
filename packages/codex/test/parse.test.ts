import { describe, it, expect } from 'vitest';
import { CodexAdapter } from '../src/adapter.js';
import { recordingExec, jsonl } from './helpers.js';

describe('usage extraction (M3 — field-wise, complete-wins)', () => {
  it('keeps a complete turn.completed usage when a later partial usage arrives', async () => {
    const stdout = jsonl(
      { type: 'thread.started', thread_id: 'c1' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 },
      },
      // a later, less-complete usage (item-level) must NOT clobber the full one
      { type: 'item.completed', item: { type: 'agent_message', text: 'done', usage: { output_tokens: 5 } } },
    );
    const { exec } = recordingExec({ stdout });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.text).toBe('done');
    expect(r.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
      totalTokens: 150,
    });
  });

  it('ignores a bare event carrying a single stray usage key', async () => {
    const stdout = jsonl(
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } },
      { type: 'progress', input_tokens: 999 }, // single stray key ON the event itself
      { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
    );
    const { exec } = recordingExec({ stdout });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it('still accepts inline usage when the event itself carries >=2 recognized keys', async () => {
    const stdout = jsonl(
      { type: 'thread.started', thread_id: 'c1' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      { type: 'turn.completed', input_tokens: 12, output_tokens: 8 }, // inline, 2 keys
    );
    const { exec } = recordingExec({ stdout });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
  });
});

describe('usage totalTokens rule (U3)', () => {
  it('uses a vendor-supplied total verbatim instead of deriving it', async () => {
    const stdout = jsonl(
      { type: 'thread.started', thread_id: 'c1' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 999 } },
    );
    const { exec } = recordingExec({ stdout });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 999 });
  });

  it('omits totalTokens when neither a total nor both input+output are present', async () => {
    const stdout = jsonl(
      { type: 'thread.started', thread_id: 'c1' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      { type: 'turn.completed', usage: { input_tokens: 100 } },
    );
    const { exec } = recordingExec({ stdout });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.usage).toEqual({ inputTokens: 100 });
  });
});

describe('JSONL parsing (L3 — arrays are not records)', () => {
  it('skips a trailing JSONL line that is a JSON array, keeping raw an object', async () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'c1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
      JSON.stringify(['stray', 'array', 'tail']), // must be skipped, not become raw/lastEvent
    ].join('\n');
    const { exec } = recordingExec({ stdout });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.conversationId).toBe('c1');
    expect(r.text).toBe('ok');
    expect(Array.isArray(r.raw)).toBe(false);
  });
});
