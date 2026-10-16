import { describe, it, expect } from 'vitest';
import { GeminiAdapter } from '../src/adapter.js';
import { fetchLiveModels, parseModelsOutput } from '../src/models.js';
import { recordingExec, throwingExec } from './helpers.js';

/** Captured `agy models` output (ground truth H): a chatter line + TAB-separated rows. */
const MODELS_STDOUT = [
  'Fetching available models...',
  'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
  'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  '',
].join('\n');

describe('availableModels() — fast static catalog (T17)', () => {
  it('returns the 11 static entries, spawns nothing, marks no default', async () => {
    const { exec, calls } = recordingExec({ stdout: MODELS_STDOUT });
    const a = new GeminiAdapter({ exec, env: {} });
    const models = await a.availableModels();
    expect(models).toHaveLength(11);
    expect(calls).toHaveLength(0); // never shells out (routing hot path)
    expect(models.every((m) => m.default !== true)).toBe(true);
  });

  it('labels the three resold models with a quota warning', async () => {
    const a = new GeminiAdapter({ exec: recordingExec().exec, env: {} });
    const models = await a.availableModels();
    for (const id of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']) {
      const m = models.find((x) => x.id === id);
      expect(m?.label).toMatch(/resold/);
      expect(m?.label).toMatch(/quota/);
    }
  });

  it('returns a fresh array callers cannot use to mutate the shared catalog', async () => {
    const a = new GeminiAdapter({ exec: recordingExec().exec, env: {} });
    const first = await a.availableModels();
    first[0]!.id = 'MUTATED';
    const second = await a.availableModels();
    expect(second[0]!.id).not.toBe('MUTATED');
  });
});

describe('fetchLiveModels() — slow authoritative path (T18)', () => {
  it('parses TAB-separated rows, skips the Fetching line, applies the latency heuristic', async () => {
    const { exec, calls } = recordingExec({ stdout: MODELS_STDOUT });
    const models = await fetchLiveModels({ exec, binary: 'agy' });
    expect(calls[0]!.args).toEqual(['models']);
    expect(models).toEqual([
      { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)', latencyClass: 'fast' },
      { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)', latencyClass: 'slow' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', latencyClass: 'fast' },
    ]);
  });

  it('resolves [] on a spawn failure and on a timeout — never throws', async () => {
    const enoent = await fetchLiveModels({ exec: throwingExec(new Error('spawn agy ENOENT')) });
    expect(enoent).toEqual([]);
    const timed = await fetchLiveModels({ exec: recordingExec({ timedOut: true, exitCode: null }).exec });
    expect(timed).toEqual([]);
  });

  it('parseModelsOutput ignores lines without a TAB', () => {
    expect(parseModelsOutput('no tabs here\nFetching available models...\n')).toEqual([]);
  });
});

describe('authStatus() via `agy models` (T19)', () => {
  it('reports logged in under google mode on exit 0 with model lines', async () => {
    const { exec, calls } = recordingExec({ stdout: MODELS_STDOUT, exitCode: 0 });
    const a = new GeminiAdapter({ exec, env: {} });
    const s = await a.authStatus();
    expect(s).toEqual({ loggedIn: true, mode: 'google' });
    expect(calls[0]!.args).toEqual(['models']);
  });

  it('reports logged out on a non-zero exit, and never exposes a detail', async () => {
    const { exec } = recordingExec({ stdout: '', exitCode: 1, stderr: 'not authenticated' });
    const a = new GeminiAdapter({ exec, env: {} });
    const s = await a.authStatus();
    expect(s).toEqual({ loggedIn: false });
    expect(s).not.toHaveProperty('detail');
  });

  it('reports logged out on ENOENT and on timeout without throwing', async () => {
    const enoent = new GeminiAdapter({ exec: throwingExec(new Error('ENOENT')), env: {} });
    await expect(enoent.authStatus()).resolves.toEqual({ loggedIn: false });
    const timed = new GeminiAdapter({
      exec: recordingExec({ timedOut: true, exitCode: null }).exec,
      env: {},
    });
    await expect(timed.authStatus()).resolves.toEqual({ loggedIn: false });
  });

  it('reports logged out when exit 0 but no parseable model line', async () => {
    const { exec } = recordingExec({ stdout: 'Fetching available models...\n', exitCode: 0 });
    const a = new GeminiAdapter({ exec, env: {} });
    await expect(a.authStatus()).resolves.toEqual({ loggedIn: false });
  });
});

describe('quota() — agy reports its own usage (T20)', () => {
  // The full mapping and failure matrix is in quota.test.ts.
  it('advertises capabilities.quota true, and an answer that is not a usage answer is null', async () => {
    const a = new GeminiAdapter({ exec: recordingExec().exec, env: {}, quotaCacheMs: 0 });
    expect(a.capabilities.quota).toBe(true);
    await expect(a.quota()).resolves.toBeNull(); // empty stdout: headroom unknown, never fabricated
  });
});
