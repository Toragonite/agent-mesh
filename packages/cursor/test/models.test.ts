import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@toragonite/agent-mesh';
import { CursorAdapter } from '../src/adapter.js';
import { recordingExec, scriptedExec, throwingExec, MODELS_STDOUT } from './helpers.js';

function byId(models: ModelInfo[], id: string): ModelInfo {
  const m = models.find((x) => x.id === id);
  if (!m) throw new Error(`no model ${id}`);
  return m;
}

describe('availableModels() live parsing', () => {
  it('parses id - Display Name, skips header/blank/Tip lines, classifies and labels', async () => {
    const { exec } = recordingExec({ stdout: MODELS_STDOUT });
    const a = new CursorAdapter({ exec, env: {} });
    const models = await a.availableModels();

    expect(models.map((m) => m.id)).toEqual([
      'auto',
      'composer-2.5',
      'cursor-grok-4.5-high',
      'claude-opus-4-8',
      'gpt-5.6',
    ]);

    // auto is the only default.
    expect(models.filter((m) => m.default)).toHaveLength(1);
    expect(byId(models, 'auto').default).toBe(true);

    // Native entries are unwarned; resold entries carry the quota warning.
    expect(byId(models, 'composer-2.5').label).toBe('Composer 2.5');
    expect(byId(models, 'composer-2.5').label).not.toMatch(/quota/i);
    expect(byId(models, 'cursor-grok-4.5-high').label).toBe('Grok 4.5 High');
    expect(byId(models, 'claude-opus-4-8').label).toMatch(/quota/i);
    expect(byId(models, 'gpt-5.6').label).toMatch(/quota/i);

    // Latency heuristic: 'high' and 'opus' → slow; plain ids → fast.
    expect(byId(models, 'cursor-grok-4.5-high').latencyClass).toBe('slow');
    expect(byId(models, 'claude-opus-4-8').latencyClass).toBe('slow');
    expect(byId(models, 'composer-2.5').latencyClass).toBe('fast');
    expect(byId(models, 'gpt-5.6').latencyClass).toBe('fast');
  });
});

describe('availableModels() memoization and fallback', () => {
  it('memoizes — two calls spawn `cursor-agent models` exactly once', async () => {
    const { exec, calls } = recordingExec({ stdout: MODELS_STDOUT });
    const a = new CursorAdapter({ exec, env: {} });
    await a.availableModels();
    await a.availableModels();
    expect(calls.filter((c) => c.args[0] === 'models')).toHaveLength(1);
  });

  it('short-circuits the subprocess entirely when the models option is provided', async () => {
    const { exec, calls } = recordingExec({ stdout: MODELS_STDOUT });
    const provided: ModelInfo[] = [{ id: 'auto', latencyClass: 'fast', default: true }];
    const a = new CursorAdapter({ exec, env: {}, models: provided });
    const models = await a.availableModels();
    expect(models).toEqual(provided);
    expect(calls).toHaveLength(0);
  });

  it('falls back to the four curated entries without throwing when the probe fails', async () => {
    const a = new CursorAdapter({ exec: throwingExec(new Error('ENOENT')).exec, env: {} });
    const models = await a.availableModels();
    expect(models.map((m) => m.id)).toEqual([
      'auto',
      'composer-2.5',
      'cursor-grok-4.5-high',
      'cursor-grok-4.5-high-fast',
    ]);
    expect(byId(models, 'auto').default).toBe(true);
  });
});

describe('availableModels() failed-probe caching (A3)', () => {
  it('caches the curated fallback after a failure so two calls spawn the probe only ONCE', async () => {
    const { exec, calls } = throwingExec(new Error('ENOENT'));
    const a = new CursorAdapter({ exec, env: {} });
    const first = await a.availableModels();
    const second = await a.availableModels();
    // Within the default 60s window, the second call reuses the cached fallback — no re-spawn.
    expect(calls.filter((c) => c.args[0] === 'models')).toHaveLength(1);
    // The fallback still contains the curated NATIVE models.
    for (const m of [first, second]) {
      expect(m.map((x) => x.id)).toEqual([
        'auto',
        'composer-2.5',
        'cursor-grok-4.5-high',
        'cursor-grok-4.5-high-fast',
      ]);
    }
  });

  it('re-probes on the next call once the failed-probe cache window has elapsed (modelsCacheMs: 0)', async () => {
    const { exec, calls } = throwingExec(new Error('ENOENT'));
    const a = new CursorAdapter({ exec, env: {}, modelsCacheMs: 0 });
    await a.availableModels();
    await a.availableModels();
    // A zero window means the fallback is immediately stale — each call re-probes.
    expect(calls.filter((c) => c.args[0] === 'models')).toHaveLength(2);
  });

  it('a later SUCCESSFUL probe supersedes the cached fallback and is memoized for good', async () => {
    let fail = true;
    const { exec, calls } = scriptedExec(() =>
      fail ? { exitCode: 1 } : { stdout: MODELS_STDOUT, exitCode: 0 },
    );
    // A zero window lets the failed cache expire so the next call re-probes and succeeds.
    const a = new CursorAdapter({ exec, env: {}, modelsCacheMs: 0 });
    const failed = await a.availableModels();
    expect(failed.map((m) => m.id)).toContain('cursor-grok-4.5-high-fast'); // curated fallback
    fail = false;
    const recovered = await a.availableModels();
    expect(recovered.map((m) => m.id)).toContain('claude-opus-4-8'); // live catalog
    // The successful read is now memoized for the life of the instance — no further spawn.
    const again = await a.availableModels();
    expect(again.map((m) => m.id)).toContain('claude-opus-4-8');
    expect(calls.filter((c) => c.args[0] === 'models')).toHaveLength(2); // fail, then success; then memoized
  });
});
