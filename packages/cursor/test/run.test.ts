import { describe, it, expect } from 'vitest';
import { AdapterExecError, AgentMeshError, type ModelInfo } from '@toragonite/agent-mesh';
import { CursorAdapter } from '../src/adapter.js';
import { recordingExec, scriptedExec, throwingExec, last, RESULT_JSON } from './helpers.js';

/** A models option so run() never spawns `cursor-agent models` in these tests. */
const MODELS: ModelInfo[] = [{ id: 'composer-2.5', latencyClass: 'fast' }];

describe('run() argv construction', () => {
  it('emits -p --output-format json --trust, then --model/--sandbox, extra before the fence, prompt LAST', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    await a.run({
      prompt: 'hi there',
      model: 'composer-2.5',
      permissionMode: 'workspace-write',
      cwd: '/work',
      extra: { args: ['--foo', 'bar'] },
    });
    const req = calls[0]!;
    expect(req.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--trust',
      '--model',
      'composer-2.5',
      '--sandbox',
      'workspace-write',
      '--foo',
      'bar',
      '--',
      'hi there',
    ]);
    expect(last(req.args)).toBe('hi there');
    expect(req.args[req.args.length - 2]).toBe('--');
    expect(req.cwd).toBe('/work');
  });

  it('omits --trust when trust:false, and omits --model/--sandbox when absent', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, trust: false });
    await a.run({ prompt: 'hi' });
    expect(calls[0]!.args).toEqual(['-p', '--output-format', 'json', '--', 'hi']);
    expect(calls[0]!.args).not.toContain('--trust');
  });

  it('keeps a prompt that begins with --model as ONE argv element behind the fence (ground truth A)', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    const hostile = '--model Reply with exactly: MESH-C3';
    await a.run({ prompt: hostile });
    const req = calls[0]!;
    expect(last(req.args)).toBe(hostile);
    expect(req.args[req.args.length - 2]).toBe('--');
    expect(req.args.filter((x) => x === hostile)).toHaveLength(1);
  });
});

describe('run() result mapping from payload D', () => {
  it('maps session id, text, status, camelCase usage with a COMPUTED total; cacheWriteTokens only in raw', async () => {
    const { exec } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    const r = await a.run({ prompt: 'hi', model: 'composer-2.5' });
    expect(r.vendor).toBe('cursor');
    expect(r.conversationId).toBe('630ad917-aaaa');
    expect(r.text).toBe('MESH-OK');
    expect(r.status).toBe('ok');
    expect(r.model).toBe('composer-2.5');
    expect(r.usage).toEqual({
      inputTokens: 12585,
      outputTokens: 30,
      cachedInputTokens: 5632,
      totalTokens: 12615,
    });
    // cacheWriteTokens has no contract field — it survives only in raw.
    expect(r.usage).not.toHaveProperty('cacheWriteTokens');
    expect((r.raw as { usage: { cacheWriteTokens: number } }).usage.cacheWriteTokens).toBe(0);
  });

  it('omits model when the task names none', async () => {
    const { exec } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.model).toBeUndefined();
  });

  it('keeps only the LAST JSON object when stdout has interleaved noise', async () => {
    const stdout = ['starting…', 'not json', RESULT_JSON, 'trailing log line'].join('\n');
    const { exec } = recordingExec({ stdout });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.text).toBe('MESH-OK');
    expect(r.status).toBe('ok');
  });
});

describe('run() status semantics', () => {
  it('maps is_error:true to status "error"', async () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: '', session_id: 's' });
    const { exec } = recordingExec({ stdout });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.status).toBe('error');
  });

  it('maps a present non-success subtype to status "error"', async () => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'refusal', result: 'nope', session_id: 's' });
    const { exec } = recordingExec({ stdout });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.status).toBe('error');
  });

  it('maps exit 0 with garbage stdout to status "incomplete"', async () => {
    const { exec } = recordingExec({ stdout: 'not json at all', exitCode: 0 });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.status).toBe('incomplete');
    expect(r.text).toBe('');
    expect(r.conversationId).toBe('');
  });

  it('resolves a timeout to "incomplete" with a note and never throws', async () => {
    const partial = JSON.stringify({ type: 'result', result: '', session_id: 'c-timeout' });
    const { exec } = recordingExec({ stdout: partial, exitCode: null, timedOut: true });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', timeoutMs: 1000 });
    expect(r.status).toBe('incomplete');
    expect(r.note).toContain('timed out after 1000ms');
    expect(r.conversationId).toBe('c-timeout');
  });
});

describe('run() failure paths', () => {
  it('throws AdapterExecError naming the cwd on a trust refusal (ground truth B)', async () => {
    const stdout = '⚠ Workspace Trust Required\nPass --trust, --yolo, or -f if you trust this directory';
    const { exec } = recordingExec({ stdout, stderr: '', exitCode: 1 });
    const a = new CursorAdapter({ exec, env: {}, trust: false });
    await expect(a.run({ prompt: 'hi', cwd: '/untrusted' })).rejects.toMatchObject({
      name: 'AdapterExecError',
      message: expect.stringContaining('trust'),
    });
    await expect(a.run({ prompt: 'hi', cwd: '/untrusted' })).rejects.toMatchObject({
      message: expect.stringContaining('/untrusted'),
    });
  });

  it('throws AdapterExecError with exitCode + stderr on a non-zero exit with unparseable stdout', async () => {
    const { exec } = recordingExec({ stdout: 'garbage', stderr: 'boom stderr', exitCode: 2 });
    const a = new CursorAdapter({ exec, env: {} });
    await expect(a.run({ prompt: 'hi' })).rejects.toMatchObject({
      name: 'AdapterExecError',
      exitCode: 2,
      stderr: expect.stringContaining('boom stderr'),
    });
  });

  it('converts a spawn-level ENOENT into AdapterExecError', async () => {
    const err = Object.assign(new Error('spawn cursor-agent ENOENT'), { code: 'ENOENT' });
    const a = new CursorAdapter({ exec: throwingExec(err).exec, env: {} });
    await expect(a.run({ prompt: 'hi' })).rejects.toBeInstanceOf(AdapterExecError);
  });
});

describe('run() never spawns the models probe (A2)', () => {
  it('a cold adapter with no models option runs with exactly ONE spawn and no unknown-model note', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', model: 'composer-2.5' });
    // No out-of-band `cursor-agent models` subprocess on the run() path.
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => c.args[0] !== 'models')).toBe(true);
    // Catalog unresolved → unknown-model note is skipped entirely (best-effort).
    expect(r.note).toBeUndefined();
  });

  it('surfaces the unknown-model note only once a successful catalog read has been memoized', async () => {
    const modelsStdout = 'Available models\n\nauto - Auto\ncomposer-2.5 - Composer 2.5';
    const { exec } = scriptedExec((req) =>
      req.args[0] === 'models' ? { stdout: modelsStdout } : { stdout: RESULT_JSON },
    );
    const a = new CursorAdapter({ exec, env: {} });
    // Before the catalog is resolved, an off-catalog model gets no note.
    const before = await a.run({ prompt: 'hi', model: 'gpt-9' });
    expect(before.note).toBeUndefined();
    // Resolve + memoize the catalog out-of-band.
    await a.availableModels();
    // Now the memoized catalog feeds the note without any new spawn on the run path.
    const after = await a.run({ prompt: 'hi', model: 'gpt-9' });
    expect(after.note).toBe('model gpt-9 not in known catalog');
  });
});

describe('run() model value semantics (U2)', () => {
  it('treats a whitespace-only model as ABSENT: no --model flag, no note, no throw', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    const r = await a.run({ prompt: 'hi', model: '   ' });
    expect(calls[0]!.args).not.toContain('--model');
    expect(r.model).toBeUndefined();
    expect(r.note).toBeUndefined();
  });

  it('passes a surrounding-whitespace model to the CLI trimmed', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    const r = await a.run({ prompt: 'hi', model: '  composer-2.5  ' });
    const i = calls[0]!.args.indexOf('--model');
    expect(calls[0]!.args[i + 1]).toBe('composer-2.5');
    expect(r.model).toBe('composer-2.5');
  });
});

describe('run() usage total precedence (U3)', () => {
  it('uses a vendor-supplied totalTokens verbatim instead of deriving input+output', async () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      session_id: 's',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 999 },
    });
    const { exec } = recordingExec({ stdout });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    // 999, not 30 — a supplied total wins over the derived sum.
    expect(r.usage?.totalTokens).toBe(999);
  });
});

describe('run() extra.args dropped-entry note (U5)', () => {
  it('notes how many non-string entries were dropped (plural)', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', extra: { args: ['--keep', 1, null, 'also'] } });
    // Non-strings are filtered from argv; the strings survive in order.
    expect(calls[0]!.args).toContain('--keep');
    expect(calls[0]!.args).toContain('also');
    expect(calls[0]!.args).not.toContain('1');
    expect(r.note).toBe('extra.args contained 2 non-string entries; dropped');
  });

  it('uses the singular "entry" for exactly one dropped entry', async () => {
    const { exec } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', extra: { args: ['--keep', 7] } });
    expect(r.note).toBe('extra.args contained 1 non-string entry; dropped');
  });
});

describe('run() null/malformed account is absent (U4)', () => {
  it('a null account does not throw and falls back to defaultAccount (not a TypeError)', async () => {
    const { exec } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({
      exec,
      env: {},
      defaultAccount: { vendor: 'cursor', configDir: '/default' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await a.run({ prompt: 'hi', account: null as any });
    // Behaves exactly as if no account was passed → defaultAccount.configDir note surfaces.
    expect(r.note).toContain('account.configDir is not supported by cursor-agent; ignored');
  });
});

describe('run() validation and notes', () => {
  it('throws AgentMeshError on an empty/whitespace prompt before spawning', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    await expect(a.run({ prompt: '   ' })).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('ignores allowedTools with a note and keeps them out of argv', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', allowedTools: ['Read', 'Edit'] });
    expect(r.note).toContain('allowedTools not supported by cursor-agent; ignored');
    expect(calls[0]!.args).not.toContain('Read');
    expect(calls[0]!.args).not.toContain('Edit');
  });

  it('notes an ignored account.configDir', async () => {
    const { exec } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', account: { vendor: 'cursor', configDir: '/iso' } });
    expect(r.note).toContain('account.configDir is not supported by cursor-agent; ignored');
  });

  it('notes an off-catalog model, still runs, and composes notes with "; "', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    const r = await a.run({ prompt: 'hi', model: 'claude-opus-4-8[context=1m]', allowedTools: ['x'] });
    expect(calls).toHaveLength(1);
    expect(r.note).toBe(
      'allowedTools not supported by cursor-agent; ignored; model claude-opus-4-8[context=1m] not in known catalog',
    );
  });
});
