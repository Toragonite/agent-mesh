import { describe, it, expect } from 'vitest';
import { AgentMeshError } from '@toragonite/agent-mesh';
import { CodexAdapter } from '../src/adapter.js';
import { recordingExec, fixedReader, jsonl, last } from './helpers.js';

describe('resume()', () => {
  it('builds `exec resume <id> --json` with message LAST', async () => {
    const stdout = jsonl(
      { type: 'thread.started', thread_id: 'conv_abc' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'again' } },
    );
    const { exec, calls } = recordingExec({ stdout });
    const a = new CodexAdapter({ exec, env: {}, readTextFile: fixedReader(null) });
    const r = await a.resume('conv_abc', 'say more', { model: 'gpt-5.5' });
    expect(calls[0]!.args).toEqual([
      'exec',
      'resume',
      'conv_abc',
      '--json',
      '--model',
      'gpt-5.5',
      '--',
      'say more',
    ]);
    expect(last(calls[0]!.args)).toBe('say more');
    expect(calls[0]!.args[calls[0]!.args.length - 2]).toBe('--');
    expect(r.conversationId).toBe('conv_abc');
    expect(r.text).toBe('again');
    expect(r.model).toBe('gpt-5.5');
  });

  it('falls back to the input id when the stream echoes none', async () => {
    const stdout = jsonl({ type: 'item.completed', item: { type: 'agent_message', text: 'no id here' } });
    const { exec } = recordingExec({ stdout });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.resume('conv_input', 'continue');
    expect(r.conversationId).toBe('conv_input');
    expect(r.text).toBe('no id here');
  });

  it('throws AgentMeshError on empty conversationId or message', async () => {
    const { exec } = recordingExec({ stdout: '' });
    const a = new CodexAdapter({ exec, env: {} });
    await expect(a.resume('', 'msg')).rejects.toBeInstanceOf(AgentMeshError);
    await expect(a.resume('conv_abc', '   ')).rejects.toBeInstanceOf(AgentMeshError);
  });

  it('rejects a flag-shaped conversationId before spawn (kills the `--last` hijack)', async () => {
    const { exec, calls } = recordingExec({ stdout: '' });
    const a = new CodexAdapter({ exec, env: {} });
    await expect(a.resume('--last', 'sneak this in')).rejects.toBeInstanceOf(AgentMeshError);
    // a leading dash after surrounding whitespace is caught too
    await expect(a.resume('  -x', 'msg')).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('throws before spawn when resume requests a blocked model under chatgpt (M12)', async () => {
    const { exec, calls } = recordingExec({ stdout: '' });
    const a = new CodexAdapter({
      exec,
      env: {},
      readTextFile: fixedReader(JSON.stringify({ tokens: { access_token: 't' } })),
    });
    await expect(a.resume('conv_abc', 'go', { model: 'gpt-5.2' })).rejects.toThrowError(
      /requires api-key auth; current login is chatgpt/,
    );
    expect(calls).toHaveLength(0);
  });

  it('trims the conversationId before validating and passing it to argv (U1)', async () => {
    const { exec, calls } = recordingExec({ stdout: '' });
    const a = new CodexAdapter({ exec, env: {} });
    await a.resume('  abc-123  ', 'go');
    expect(calls[0]!.args).toEqual(['exec', 'resume', 'abc-123', '--json', '--', 'go']);
  });

  it('rejects a whitespace-padded flag-shaped id after trimming (U1)', async () => {
    const { exec, calls } = recordingExec({ stdout: '' });
    const a = new CodexAdapter({ exec, env: {} });
    await expect(a.resume('  -c  ', 'go')).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('treats a provided-but-empty resume model as absent (U2)', async () => {
    const { exec, calls } = recordingExec({ stdout: '' });
    const a = new CodexAdapter({
      exec,
      env: {},
      readTextFile: fixedReader(JSON.stringify({ tokens: { access_token: 't' } })),
    });
    const r = await a.resume('conv_abc', 'go', { model: '  ' });
    expect(calls[0]!.args).toEqual(['exec', 'resume', 'conv_abc', '--json', '--', 'go']);
    expect(r.note).toBeUndefined();
  });
});

describe('resume() honours extra.cwd (U6)', () => {
  it('passes a string extra.cwd as the child cwd', async () => {
    const { exec, calls } = recordingExec({ stdout: '' });
    const a = new CodexAdapter({ exec, env: {} });
    await a.resume('conv_abc', 'go', { extra: { cwd: '/work' } });
    expect(calls[0]!.cwd).toBe('/work');
  });

  it('inherits (undefined cwd) when extra.cwd is absent or non-string', async () => {
    const { exec, calls } = recordingExec({ stdout: '' });
    const a = new CodexAdapter({ exec, env: {} });
    await a.resume('conv_abc', 'go', { extra: { cwd: 123 } });
    expect(calls[0]!.cwd).toBeUndefined();
    await a.resume('conv_abc', 'go');
    expect(calls[1]!.cwd).toBeUndefined();
  });

  it('does not leak extra.cwd into argv', async () => {
    const { exec, calls } = recordingExec({ stdout: '' });
    const a = new CodexAdapter({ exec, env: {} });
    await a.resume('conv_abc', 'go', { extra: { cwd: '/work' } });
    expect(calls[0]!.args).not.toContain('/work');
  });
});
