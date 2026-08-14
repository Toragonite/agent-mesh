import { describe, it, expect } from 'vitest';
import { AgentMeshError, type ModelInfo } from '@toragonite/agent-mesh';
import { CursorAdapter } from '../src/adapter.js';
import { recordingExec, last, RESULT_JSON } from './helpers.js';

const MODELS: ModelInfo[] = [{ id: 'composer-2.5', latencyClass: 'fast' }];

describe('resume() argv construction', () => {
  it('places --resume <id> before the fence, model after, message LAST', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    await a.resume('630ad917-aaaa', 'again', { model: 'composer-2.5', extra: { args: ['--foo'] } });
    const req = calls[0]!;
    expect(req.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--trust',
      '--resume',
      '630ad917-aaaa',
      '--model',
      'composer-2.5',
      '--foo',
      '--',
      'again',
    ]);
    expect(last(req.args)).toBe('again');
    expect(req.args[req.args.length - 2]).toBe('--');
  });

  it('echoes the same session id and falls back to the passed id when the payload carries none', async () => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' });
    const { exec } = recordingExec({ stdout });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.resume('conv-xyz', 'again');
    expect(r.conversationId).toBe('conv-xyz');
    expect(r.text).toBe('ok');
  });
});

describe('resume() conversation-id value semantics (U1)', () => {
  it('rejects a flag-shaped id AFTER trimming ("  -c  " throws)', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    await expect(a.resume('  -c  ', 'hi')).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('passes the TRIMMED id to argv — "  abc-123  " reaches the CLI as "abc-123"', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    await a.resume('  abc-123  ', 'again');
    const i = calls[0]!.args.indexOf('--resume');
    expect(calls[0]!.args[i + 1]).toBe('abc-123');
    // The raw, space-padded value never reaches the CLI.
    expect(calls[0]!.args).not.toContain('  abc-123  ');
  });

  it('falls back to the TRIMMED id when the payload echoes no session', async () => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' });
    const { exec } = recordingExec({ stdout });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.resume('  conv-xyz  ', 'again');
    expect(r.conversationId).toBe('conv-xyz');
  });
});

describe('resume() honours a working directory via opts.extra.cwd (U6)', () => {
  it('passes a string opts.extra.cwd as the child cwd', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    await a.resume('conv-1', 'again', { extra: { cwd: '/conversation/dir' } });
    expect(calls[0]!.cwd).toBe('/conversation/dir');
  });

  it('inherits (undefined cwd) when opts.extra.cwd is absent or non-string', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    await a.resume('conv-1', 'again', { extra: { cwd: 123 } });
    expect(calls[0]!.cwd).toBeUndefined();
  });
});

describe('resume() validation (before any spawn)', () => {
  it('throws AgentMeshError on an empty conversationId', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    await expect(a.resume('   ', 'hi')).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('throws AgentMeshError on a flag-shaped conversationId (leading dash)', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    await expect(a.resume('--last', 'hi')).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('throws AgentMeshError on an empty message', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    await expect(a.resume('conv-1', '  ')).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });
});
