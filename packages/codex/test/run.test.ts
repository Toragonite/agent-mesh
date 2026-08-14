import { describe, it, expect } from 'vitest';
import { AdapterExecError, AgentMeshError } from '@toragonite/agent-mesh';
import { CodexAdapter } from '../src/adapter.js';
import { recordingExec, throwingExec, fixedReader, jsonl, last } from './helpers.js';

const HAPPY = jsonl(
  { type: 'thread.started', thread_id: 'conv_abc' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Hello world' } },
  { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 } },
);

describe('run() argv construction', () => {
  it('emits `exec --json` first, --model/--sandbox before the fenced prompt, prompt LAST, CODEX_HOME set', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {}, readTextFile: fixedReader(null) });
    await a.run({
      prompt: 'hi there',
      model: 'gpt-5.6-sol',
      permissionMode: 'workspace-write',
      cwd: '/work',
      account: { vendor: 'codex', configDir: '/home/x' },
    });
    const req = calls[0]!;
    expect(req.args).toEqual([
      'exec',
      '--json',
      '--model',
      'gpt-5.6-sol',
      '--sandbox',
      'workspace-write',
      '--',
      'hi there',
    ]);
    expect(last(req.args)).toBe('hi there');
    expect(req.args[req.args.length - 2]).toBe('--');
    expect(req.cwd).toBe('/work');
    expect(req.env?.CODEX_HOME).toBe('/home/x');
  });

  it('omits --model when no model is given (CLI default applies)', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {} });
    await a.run({ prompt: 'hi' });
    expect(calls[0]!.args).toEqual(['exec', '--json', '--', 'hi']);
  });

  it('appends extra.args verbatim before the fenced prompt', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {} });
    await a.run({ prompt: 'hi', extra: { args: ['--foo', 'bar'] } });
    expect(calls[0]!.args).toEqual(['exec', '--json', '--foo', 'bar', '--', 'hi']);
  });
});

describe('run() JSONL mapping', () => {
  it('maps thread id, agent text, usage (incl. totalTokens)', async () => {
    const { exec } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {}, readTextFile: fixedReader(null) });
    const r = await a.run({ prompt: 'hi', model: 'gpt-5.6-sol' });
    expect(r.conversationId).toBe('conv_abc');
    expect(r.text).toBe('Hello world');
    expect(r.status).toBe('ok');
    expect(r.model).toBe('gpt-5.6-sol');
    expect(r.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
      totalTokens: 150,
    });
    expect(r.vendor).toBe('codex');
  });

  it('accepts the nested thread.id form and an observed model field', async () => {
    const stdout = jsonl(
      { type: 'thread.started', thread: { id: 'conv_nested' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'ok', model: 'gpt-5.5' } },
    );
    const { exec } = recordingExec({ stdout });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.conversationId).toBe('conv_nested');
    expect(r.model).toBe('gpt-5.5');
  });

  it('skips interleaved non-JSON / blank lines', async () => {
    const stdout = [
      'not json at all',
      '',
      JSON.stringify({ type: 'thread.started', thread_id: 'c1' }),
      'progress: 50%',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'clean' } }),
      '{ broken json',
    ].join('\n');
    const { exec } = recordingExec({ stdout });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.conversationId).toBe('c1');
    expect(r.text).toBe('clean');
    expect(r.status).toBe('ok');
  });
});

describe('run() hostile prompt values', () => {
  it('keeps a prompt with a leading dash as one argv element', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {} });
    const hostile = '-rf --sandbox danger';
    await a.run({ prompt: hostile });
    const req = calls[0]!;
    expect(last(req.args)).toBe(hostile);
    expect(req.args.filter((x) => x === hostile)).toHaveLength(1);
  });

  it('keeps newlines and quotes intact in a single argv element', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {} });
    const hostile = '"; DROP TABLE x;\n--json evil';
    await a.run({ prompt: hostile });
    expect(last(calls[0]!.args)).toBe(hostile);
  });
});

describe('run() validation and error semantics', () => {
  it('throws AgentMeshError on empty/whitespace prompt before spawning', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {} });
    await expect(a.run({ prompt: '   ' })).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('ignores allowedTools, sets a note, and keeps them out of argv', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', allowedTools: ['fs_read', 'net'] });
    expect(r.note).toContain('allowedTools not supported by codex; ignored');
    expect(calls[0]!.args).not.toContain('fs_read');
    expect(calls[0]!.args).not.toContain('net');
  });

  it('converts a spawn-level ENOENT into AdapterExecError', async () => {
    const err = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    const a = new CodexAdapter({ exec: throwingExec(err), env: {} });
    await expect(a.run({ prompt: 'hi' })).rejects.toBeInstanceOf(AdapterExecError);
  });

  it('throws AdapterExecError with exit code + stderr on non-zero exit and no result', async () => {
    const { exec } = recordingExec({ stdout: '', stderr: 'boom stderr', exitCode: 2 });
    const a = new CodexAdapter({ exec, env: {} });
    await expect(a.run({ prompt: 'hi' })).rejects.toMatchObject({
      name: 'AdapterExecError',
      exitCode: 2,
      stderr: expect.stringContaining('boom stderr'),
    });
  });

  it('maps an explicit error event (with no text) to status "error"', async () => {
    const stdout = jsonl({ type: 'error', message: 'the model refused the request' });
    const { exec } = recordingExec({ stdout, exitCode: 0 });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.status).toBe('error');
    expect(r.text).toBe('');
    expect(r.note).toContain('the model refused the request');
  });

  it('preserves partial text but resolves status "error" when a refusal follows an answer (A1)', async () => {
    const stdout = jsonl(
      { type: 'thread.started', thread_id: 'c1' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'partial answer' } },
      { type: 'error', message: 'the model refused: policy violation' },
    );
    const { exec } = recordingExec({ stdout, exitCode: 0 });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.status).toBe('error');
    expect(r.text).toBe('partial answer');
    expect(r.note).toContain('the model refused: policy violation');
  });

  it('resolves status "error" for an error event even when exit code is non-zero (M4)', async () => {
    const stdout = jsonl({ type: 'error', message: 'the model refused the request' });
    const { exec } = recordingExec({ stdout, exitCode: 1, stderr: 'some stderr noise' });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.status).toBe('error');
    expect(r.text).toBe('');
    expect(r.note).toContain('the model refused the request');
  });

  it('resolves timeout to status "incomplete" with a note and best-effort partials', async () => {
    const partial = jsonl({ type: 'thread.started', thread_id: 'c-timeout' });
    const { exec } = recordingExec({ stdout: partial, exitCode: null, timedOut: true });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', timeoutMs: 1000 });
    expect(r.status).toBe('incomplete');
    expect(r.note).toContain('timed out after 1000ms');
    expect(r.conversationId).toBe('c-timeout');
  });

  it('maps zero exit with nothing parsed to status "incomplete"', async () => {
    const stdout = jsonl({ type: 'thread.started', thread_id: 'c-empty' });
    const { exec } = recordingExec({ stdout, exitCode: 0 });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.status).toBe('incomplete');
    expect(r.text).toBe('');
    expect(r.conversationId).toBe('c-empty');
  });
});

describe('run() model validation (M12)', () => {
  const CHATGPT = JSON.stringify({ tokens: { access_token: 't' } });

  it('throws before spawn when a chatgpt login requests an api-key-only model', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {}, readTextFile: fixedReader(CHATGPT) });
    await expect(a.run({ prompt: 'hi', model: 'gpt-5.1-codex-max' })).rejects.toThrowError(
      /model gpt-5\.1-codex-max requires api-key auth; current login is chatgpt/,
    );
    expect(calls).toHaveLength(0);
  });

  it('allows an api-key-only model under an api-key login', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: { OPENAI_API_KEY: 'sk-x' } });
    const r = await a.run({ prompt: 'hi', model: 'gpt-5.1-codex-max' });
    expect(r.status).toBe('ok');
    expect(calls).toHaveLength(1);
  });

  it('adds a note for an unknown off-catalog model and still runs', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {}, readTextFile: fixedReader(null) });
    const r = await a.run({ prompt: 'hi', model: 'gtp-5.5' });
    expect(calls).toHaveLength(1);
    expect(r.note).toContain('model gtp-5.5 not in known catalog');
  });

  it('composes the unknown-model note with the allowedTools note via "; "', async () => {
    const { exec } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {}, readTextFile: fixedReader(null) });
    const r = await a.run({ prompt: 'hi', model: 'zzz', allowedTools: ['x'] });
    expect(r.note).toBe('allowedTools not supported by codex; ignored; model zzz not in known catalog');
  });

  it('composes allowedTools + unknown-model + dropped-args notes in a stable order (U7)', async () => {
    const { exec } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {}, readTextFile: fixedReader(null) });
    const r = await a.run({
      prompt: 'hi',
      model: 'zzz',
      allowedTools: ['x'],
      extra: { args: [1] },
    });
    expect(r.note).toBe(
      'allowedTools not supported by codex; ignored; model zzz not in known catalog; extra.args contained 1 non-string entry; dropped',
    );
  });
});

describe('run() empty model is absent (U2)', () => {
  const CHATGPT = JSON.stringify({ tokens: { access_token: 't' } });

  it('treats a provided-but-empty model as absent: no --model, no note, no throw', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {}, readTextFile: fixedReader(CHATGPT) });
    const r = await a.run({ prompt: 'hi', model: '   ' });
    expect(calls[0]!.args).toEqual(['exec', '--json', '--', 'hi']);
    expect(r.note).toBeUndefined();
    expect(r.status).toBe('ok');
  });

  it('trims a whitespace-padded model before gating it and passing it to argv', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {}, readTextFile: fixedReader(null) });
    const r = await a.run({ prompt: 'hi', model: '  gpt-5.6-sol  ' });
    expect(calls[0]!.args).toEqual(['exec', '--json', '--model', 'gpt-5.6-sol', '--', 'hi']);
    expect(r.note).toBeUndefined();
    expect(r.model).toBe('gpt-5.6-sol');
  });
});

describe('run() extra.args dropping (U5)', () => {
  it('drops non-string entries and notes the count (plural)', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', extra: { args: ['--foo', 123, 'bar', {}] } });
    expect(calls[0]!.args).toEqual(['exec', '--json', '--foo', 'bar', '--', 'hi']);
    expect(r.note).toContain('extra.args contained 2 non-string entries; dropped');
  });

  it('uses the singular form for exactly one dropped entry', async () => {
    const { exec } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', extra: { args: ['--foo', 42] } });
    expect(r.note).toContain('extra.args contained 1 non-string entry; dropped');
  });

  it('adds no dropped note when every entry is a string', async () => {
    const { exec } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', extra: { args: ['--foo', 'bar'] } });
    expect(r.note).toBeUndefined();
  });
});
