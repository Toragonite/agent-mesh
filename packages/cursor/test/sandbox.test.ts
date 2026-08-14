import { describe, it, expect } from 'vitest';
import type { ModelInfo, RunEvent } from '@toragonite/agent-mesh';
import { CursorAdapter } from '../src/adapter.js';
import { recordingExec, fakeLineStream, RESULT_JSON, STREAM_LINES } from './helpers.js';

/** A models option so these tests never spawn `cursor-agent models`. */
const MODELS: ModelInfo[] = [{ id: 'composer-2.5', latencyClass: 'fast' }];

async function collect(gen: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('run() --sandbox vocabulary note (U9)', () => {
  it('passes an off-vocabulary permissionMode through to --sandbox UNCHANGED and adds a note', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    const r = await a.run({ prompt: 'hi', permissionMode: 'acceptEdits' });
    // The emitted argv is IDENTICAL to today's passthrough: --sandbox <value>, verbatim.
    expect(calls[0]!.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--trust',
      '--sandbox',
      'acceptEdits',
      '--',
      'hi',
    ]);
    // Only the caller is told; no flag was added or suppressed.
    expect(r.note).toBe(
      "permissionMode 'acceptEdits' is not a cursor sandbox mode (expected 'enabled' or 'disabled'); passed through",
    );
  });

  it("emits NO note for the accepted value 'enabled' (still passed to --sandbox)", async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    const r = await a.run({ prompt: 'hi', permissionMode: 'enabled' });
    expect(calls[0]!.args).toContain('--sandbox');
    expect(calls[0]!.args[calls[0]!.args.indexOf('--sandbox') + 1]).toBe('enabled');
    expect(r.note).toBeUndefined();
  });

  it("emits NO note for the accepted value 'disabled'", async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    const r = await a.run({ prompt: 'hi', permissionMode: 'disabled' });
    expect(calls[0]!.args[calls[0]!.args.indexOf('--sandbox') + 1]).toBe('disabled');
    expect(r.note).toBeUndefined();
  });

  it('treats a whitespace-only permissionMode as ABSENT: no --sandbox flag and no note', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    const r = await a.run({ prompt: 'hi', permissionMode: '   ' });
    expect(calls[0]!.args).not.toContain('--sandbox');
    expect(r.note).toBeUndefined();
  });

  it('composes the sandbox note with an unknown-model note using "; " in stable order', async () => {
    const { exec } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: {}, models: MODELS });
    const r = await a.run({
      prompt: 'hi',
      model: 'off-catalog-model',
      permissionMode: 'workspace-write',
    });
    expect(r.note).toBe(
      'model off-catalog-model not in known catalog; ' +
        "permissionMode 'workspace-write' is not a cursor sandbox mode (expected 'enabled' or 'disabled'); passed through",
    );
  });
});

describe('stream() --sandbox vocabulary note (A5/U9)', () => {
  it('folds the sandbox note into the done result exactly as run() would', async () => {
    const { lineStream } = fakeLineStream(STREAM_LINES);
    const a = new CursorAdapter({ lineStream, env: {}, models: MODELS });
    const events = await collect(a.stream({ prompt: 'hi', permissionMode: 'acceptEdits' }));
    const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.result.note).toBe(
      "permissionMode 'acceptEdits' is not a cursor sandbox mode (expected 'enabled' or 'disabled'); passed through",
    );
  });
});
