import { describe, it, expect } from 'vitest';
import { AdapterExecError, AgentMeshError } from '@toragonite/agent-mesh';
import { GeminiAdapter } from '../src/adapter.js';
import { recordingExec, throwingExec, execByPrompt, jsonl, last } from './helpers.js';

/** Ground truth F — the captured `--output-format json` SUCCESS payload. */
const SUCCESS = jsonl({
  conversation_id: 'e2b99ce6-aaaa',
  status: 'SUCCESS',
  response: 'MESH-OK\n',
  duration_seconds: 3.83,
  num_turns: 1,
  usage: {
    input_tokens: 20217,
    output_tokens: 143,
    thinking_tokens: 136,
    cache_read_tokens: 0,
    total_tokens: 20360,
  },
});

/** Ground truth D — exit 1 but a parseable ERROR payload. */
const ERROR_PAYLOAD = jsonl({
  conversation_id: '',
  status: 'ERROR',
  response: '',
  error:
    'invalid model selection (--model "not-a-real-model-xyz" --effort ""): model not-a-real-model-xyz is not recognized as a known model',
});

describe('run() argv construction (T1)', () => {
  it('emits --output-format json first, --model/--mode before -p, prompt LAST, NO -- fence', async () => {
    const { exec, calls } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    await a.run({
      prompt: 'hi there',
      model: 'gemini-3.6-flash-high',
      permissionMode: 'request-review',
      cwd: '/work',
    });
    const req = calls[0]!;
    expect(req.args).toEqual([
      '--output-format',
      'json',
      '--model',
      'gemini-3.6-flash-high',
      '--mode',
      'request-review',
      '-p',
      'hi there',
    ]);
    expect(last(req.args)).toBe('hi there');
    expect(req.args).not.toContain('--'); // this CLI is not fence-shaped (ground truth A)
    expect(req.cwd).toBe('/work');
  });

  it('omits --model and --mode when absent (CLI default applies)', async () => {
    const { exec, calls } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    await a.run({ prompt: 'hi' });
    expect(calls[0]!.args).toEqual(['--output-format', 'json', '-p', 'hi']);
  });

  it('passes permissionMode through verbatim and appends extra.args before -p', async () => {
    const { exec, calls } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    await a.run({ prompt: 'hi', permissionMode: 'yolo-custom', extra: { args: ['--foo', 'bar'] } });
    expect(calls[0]!.args).toEqual([
      '--output-format',
      'json',
      '--mode',
      'yolo-custom',
      '--foo',
      'bar',
      '-p',
      'hi',
    ]);
  });
});

describe('run() result mapping (T2)', () => {
  it('maps id/text/status/usage, uses the vendor total, keeps cache_read as cachedInputTokens', async () => {
    const { exec } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', model: 'gemini-3.6-flash-high' });
    expect(r.vendor).toBe('gemini');
    expect(r.conversationId).toBe('e2b99ce6-aaaa');
    expect(r.text).toBe('MESH-OK'); // exactly one trailing newline stripped
    expect(r.status).toBe('ok');
    expect(r.model).toBe('gemini-3.6-flash-high');
    expect(r.usage).toEqual({
      inputTokens: 20217,
      outputTokens: 143,
      cachedInputTokens: 0,
      totalTokens: 20360,
    });
  });

  it('strips exactly one trailing newline; interior newlines survive; a two-newline tail loses one', async () => {
    const payload = jsonl({
      conversation_id: 'c1',
      status: 'SUCCESS',
      response: 'line1\nline2\n\n',
    });
    const { exec } = recordingExec({ stdout: payload });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.text).toBe('line1\nline2\n');
  });

  it('keeps thinking_tokens only in raw, never in usage', async () => {
    const { exec } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.usage).not.toHaveProperty('thinkingTokens');
    expect(JSON.stringify(r.usage)).not.toContain('136');
    const raw = r.raw as { usage: Record<string, number> };
    expect(raw.usage.thinking_tokens).toBe(136);
  });
});

describe('run() ground truth D — exit 1 with an ERROR payload (T3)', () => {
  it('maps to status "error", carries the error text as note, id "", and does NOT throw', async () => {
    const { exec } = recordingExec({ stdout: ERROR_PAYLOAD, exitCode: 1, stderr: 'noise' });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', model: 'not-a-real-model-xyz' });
    expect(r.status).toBe('error');
    expect(r.conversationId).toBe('');
    expect(r.text).toBe('');
    expect(r.note).toContain('is not recognized as a known model');
  });
});

describe('run() exec-error precedence (T4, T5, T6, T7)', () => {
  it('throws AdapterExecError with exit code + stderr on non-zero exit and unparseable stdout', async () => {
    const { exec } = recordingExec({ stdout: 'total garbage, not json', stderr: 'boom stderr', exitCode: 2 });
    const a = new GeminiAdapter({ exec, env: {} });
    await expect(a.run({ prompt: 'hi' })).rejects.toMatchObject({
      name: 'AdapterExecError',
      exitCode: 2,
      stderr: expect.stringContaining('boom stderr'),
    });
  });

  it('converts a spawn-level ENOENT into AdapterExecError', async () => {
    const err = Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' });
    const a = new GeminiAdapter({ exec: throwingExec(err), env: {} });
    await expect(a.run({ prompt: 'hi' })).rejects.toBeInstanceOf(AdapterExecError);
  });

  it('resolves a timeout to status "incomplete" with a note and best-effort partials, never throws', async () => {
    const partial = jsonl({ conversation_id: 'c-timeout', status: 'SUCCESS', response: 'partial' });
    const { exec } = recordingExec({ stdout: partial, exitCode: null, timedOut: true });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', timeoutMs: 1000 });
    expect(r.status).toBe('incomplete');
    expect(r.note).toContain('timed out after 1000ms');
    expect(r.conversationId).toBe('c-timeout');
    expect(r.text).toBe('partial');
  });

  it('maps zero exit with garbage stdout to status "incomplete" and empty text', async () => {
    const { exec } = recordingExec({ stdout: 'Fetching...\nnot json\n', exitCode: 0 });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.status).toBe('incomplete');
    expect(r.text).toBe('');
    expect(r.conversationId).toBe('');
  });
});

describe('run() hostile prompt values (T8)', () => {
  it('keeps a prompt beginning with --model as ONE argv element in final position', async () => {
    const { exec, calls } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    const hostile = '--model not-a-real --effort high; rm -rf /';
    await a.run({ prompt: hostile });
    const req = calls[0]!;
    expect(last(req.args)).toBe(hostile);
    expect(req.args.filter((x) => x === hostile)).toHaveLength(1);
    expect(req.args).not.toContain('--');
  });
});

describe('run() validation and notes (T9, T12, T13)', () => {
  it('throws AgentMeshError on empty/whitespace prompt before spawning', async () => {
    const { exec, calls } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    await expect(a.run({ prompt: '   ' })).rejects.toBeInstanceOf(AgentMeshError);
    expect(calls).toHaveLength(0);
  });

  it('ignores allowedTools, sets a note, and keeps them out of argv', async () => {
    const { exec, calls } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', allowedTools: ['run_command', 'view_file'] });
    expect(r.note).toContain('allowedTools not supported by agy; ignored');
    expect(calls[0]!.args).not.toContain('run_command');
    expect(calls[0]!.args).not.toContain('view_file');
  });

  it('adds a note for an unknown off-catalog model and still runs', async () => {
    const { exec, calls } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', model: 'gemini-9.9-ultra' });
    expect(calls).toHaveLength(1);
    expect(r.note).toContain('model gemini-9.9-ultra not in known catalog');
  });

  it('composes the allowedTools and unknown-model notes with "; "', async () => {
    const { exec } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', model: 'zzz', allowedTools: ['x'] });
    expect(r.note).toBe('allowedTools not supported by agy; ignored; model zzz not in known catalog');
  });
});

describe('run() model value semantics (U2)', () => {
  it('treats a whitespace-only model as ABSENT: no --model, no note, no throw', async () => {
    const { exec, calls } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', model: '   ' });
    expect(calls[0]!.args).toEqual(['--output-format', 'json', '-p', 'hi']);
    expect(r.note).toBeUndefined();
    expect(r.model).toBeUndefined();
  });

  it('trims a surrounded model before argv AND the catalog check', async () => {
    const { exec, calls } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', model: '  gemini-3.6-flash-high  ' });
    expect(calls[0]!.args).toEqual([
      '--output-format',
      'json',
      '--model',
      'gemini-3.6-flash-high',
      '-p',
      'hi',
    ]);
    expect(r.note).toBeUndefined(); // known after trim → no unknown-catalog note
    expect(r.model).toBe('gemini-3.6-flash-high');
  });
});

describe('run() usage total fallback (U3)', () => {
  it('computes totalTokens from input+output when the vendor omits total_tokens', async () => {
    const payload = jsonl({
      conversation_id: 'c',
      status: 'SUCCESS',
      response: 'x',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { exec } = recordingExec({ stdout: payload });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it('omits totalTokens when total_tokens is absent and either input or output is missing', async () => {
    const payload = jsonl({
      conversation_id: 'c',
      status: 'SUCCESS',
      response: 'x',
      usage: { input_tokens: 10 },
    });
    const { exec } = recordingExec({ stdout: payload });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.usage).toEqual({ inputTokens: 10 });
  });
});

describe('run() extra.args dropped-entry note (U5)', () => {
  it('drops non-string entries but notes how many (plural)', async () => {
    const { exec, calls } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', extra: { args: ['--foo', 42, null, 'bar'] } });
    expect(calls[0]!.args).toEqual([
      '--output-format',
      'json',
      '--foo',
      'bar',
      '-p',
      'hi',
    ]);
    expect(r.note).toContain('extra.args contained 2 non-string entries; dropped');
  });

  it('uses the singular form for exactly one dropped entry', async () => {
    const { exec } = recordingExec({ stdout: SUCCESS });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi', extra: { args: ['--foo', 42] } });
    expect(r.note).toContain('extra.args contained 1 non-string entry; dropped');
  });
});

describe('run() never fabricates a conversation id (A1)', () => {
  it('returns "" when the payload echoes an empty conversation_id — no fallback', async () => {
    const stdout = jsonl({ conversation_id: '', status: 'SUCCESS', response: 'ok\n' });
    const { exec } = recordingExec({ stdout });
    const a = new GeminiAdapter({ exec, env: {} });
    const r = await a.run({ prompt: 'hi' });
    expect(r.conversationId).toBe('');
  });
});

describe('run() concurrency (T22)', () => {
  it('two concurrent run() calls on one adapter resolve independently', async () => {
    const { exec } = execByPrompt({
      'prompt-A': { stdout: jsonl({ conversation_id: 'conv-A', status: 'SUCCESS', response: 'A\n' }) },
      'prompt-B': { stdout: jsonl({ conversation_id: 'conv-B', status: 'SUCCESS', response: 'B\n' }) },
    });
    const a = new GeminiAdapter({ exec, env: {} });
    const [ra, rb] = await Promise.all([a.run({ prompt: 'prompt-A' }), a.run({ prompt: 'prompt-B' })]);
    expect(ra.conversationId).toBe('conv-A');
    expect(ra.text).toBe('A');
    expect(rb.conversationId).toBe('conv-B');
    expect(rb.text).toBe('B');
  });
});
