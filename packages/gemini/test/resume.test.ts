import { describe, it, expect } from 'vitest';
import { AgentMeshError } from '@toragonite/agent-mesh';
import { GeminiAdapter } from '../src/adapter.js';
import { recordingExec, jsonl, last } from './helpers.js';

describe('resume() argv + id echo (T11)', () => {
  it('builds --conversation <id> --output-format json with the message LAST', async () => {
    const stdout = jsonl({ conversation_id: 'conv_abc', status: 'SUCCESS', response: 'again\n' });
    const { exec, calls } = recordingExec({ stdout });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.resume('conv_abc', 'say more', { model: 'gemini-3.1-pro-high' });
    expect(calls[0]!.args).toEqual([
      '--conversation',
      'conv_abc',
      '--output-format',
      'json',
      '--model',
      'gemini-3.1-pro-high',
      '-p',
      'say more',
    ]);
    expect(last(calls[0]!.args)).toBe('say more');
    expect(calls[0]!.args).not.toContain('--');
    expect(r.conversationId).toBe('conv_abc');
    expect(r.text).toBe('again');
    expect(r.model).toBe('gemini-3.1-pro-high');
  });

  it('appends extra.args before -p and omits --model when absent', async () => {
    const stdout = jsonl({ conversation_id: 'c1', status: 'SUCCESS', response: 'ok' });
    const { exec, calls } = recordingExec({ stdout });
    const a = new GeminiAdapter({ exec, env: {} });
    await a.resume('c1', 'go', { extra: { args: ['--effort', 'high'] } });
    expect(calls[0]!.args).toEqual([
      '--conversation',
      'c1',
      '--output-format',
      'json',
      '--effort',
      'high',
      '-p',
      'go',
    ]);
  });
});

describe('resume() conversation-id value semantics (U1)', () => {
  it('trims the conversationId before it reaches argv', async () => {
    const stdout = jsonl({ conversation_id: 'abc-123', status: 'SUCCESS', response: 'ok' });
    const { exec, calls } = recordingExec({ stdout });
    const a = new GeminiAdapter({ exec, env: {} });
    await a.resume('  abc-123  ', 'go');
    expect(calls[0]!.args).toEqual([
      '--conversation',
      'abc-123',
      '--output-format',
      'json',
      '-p',
      'go',
    ]);
  });

  it('throws on a whitespace-wrapped flag-shaped id before spawn', async () => {
    const { exec, calls } = recordingExec({ stdout: '' });
    const a = new GeminiAdapter({ exec, env: {} });
    await expect(a.resume('  -c  ', 'go')).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });
});

describe('resume() id fallback (A1)', () => {
  it('falls back to the trimmed passed id when the payload echoes an empty conversation_id', async () => {
    const stdout = jsonl({ conversation_id: '', status: 'SUCCESS', response: 'ok\n' });
    const { exec } = recordingExec({ stdout });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.resume('  real-id-123  ', 'go');
    expect(r.conversationId).toBe('real-id-123'); // resumable — not thrown away
  });

  it('prefers a non-empty id the vendor returns over the passed id', async () => {
    const stdout = jsonl({ conversation_id: 'new-id-999', status: 'SUCCESS', response: 'ok' });
    const { exec } = recordingExec({ stdout });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.resume('old-id-1', 'go');
    expect(r.conversationId).toBe('new-id-999');
  });
});

describe('resume() working directory via extra.cwd (U6)', () => {
  it('passes a string extra.cwd as the child cwd', async () => {
    const stdout = jsonl({ conversation_id: 'c1', status: 'SUCCESS', response: 'ok' });
    const { exec, calls } = recordingExec({ stdout });
    const a = new GeminiAdapter({ exec, env: {} });
    await a.resume('c1', 'go', { extra: { cwd: '/work/dir' } });
    expect(calls[0]!.cwd).toBe('/work/dir');
  });

  it('ignores a non-string extra.cwd', async () => {
    const stdout = jsonl({ conversation_id: 'c1', status: 'SUCCESS', response: 'ok' });
    const { exec, calls } = recordingExec({ stdout });
    const a = new GeminiAdapter({ exec, env: {} });
    await a.resume('c1', 'go', { extra: { cwd: 123 } });
    expect(calls[0]!.cwd).toBeUndefined();
  });
});

describe('resume() validation (T9, T10)', () => {
  it('throws AgentMeshError on empty conversationId or message before spawn', async () => {
    const { exec, calls } = recordingExec({ stdout: '' });
    const a = new GeminiAdapter({ exec, env: {} });
    await expect(a.resume('', 'msg')).rejects.toBeInstanceOf(AgentMeshError);
    await expect(a.resume('conv_abc', '   ')).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a flag-shaped conversationId before spawn (kills a flag hijack)', async () => {
    const { exec, calls } = recordingExec({ stdout: '' });
    const a = new GeminiAdapter({ exec, env: {} });
    await expect(a.resume('--conversation', 'sneak')).rejects.toBeInstanceOf(AgentMeshError);
    await expect(a.resume('  -x', 'msg')).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });
});
