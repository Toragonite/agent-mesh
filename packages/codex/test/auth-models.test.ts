import { describe, it, expect } from 'vitest';
import { CodexAdapter } from '../src/adapter.js';
import { recordingExec, fixedReader } from './helpers.js';

const noExec = recordingExec().exec;

describe('authStatus()', () => {
  it('reports api-key mode when OPENAI_API_KEY is set (without reading a file)', async () => {
    const a = new CodexAdapter({
      exec: noExec,
      env: { OPENAI_API_KEY: 'sk-secret' },
      readTextFile: fixedReader(null),
    });
    const s = await a.authStatus();
    expect(s).toEqual({ loggedIn: true, mode: 'api-key' });
    expect(JSON.stringify(s)).not.toContain('sk-secret');
  });

  it('reports chatgpt mode with a plain email as detail — never a token', async () => {
    const authJson = JSON.stringify({
      tokens: { access_token: 'TOKEN_SHOULD_NOT_LEAK', account: { email: 'user@example.com' } },
    });
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(authJson),
    });
    const s = await a.authStatus({ vendor: 'codex', configDir: '/home/x' });
    expect(s.loggedIn).toBe(true);
    expect(s.mode).toBe('chatgpt');
    expect(s.detail).toBe('user@example.com');
    expect(JSON.stringify(s)).not.toContain('TOKEN_SHOULD_NOT_LEAK');
  });

  it('reports logged out when auth.json is absent', async () => {
    const a = new CodexAdapter({ exec: noExec, env: {}, readTextFile: fixedReader(null) });
    const s = await a.authStatus({ vendor: 'codex', configDir: '/home/x' });
    expect(s).toEqual({ loggedIn: false });
  });

  // H2 — status is by VALUE, not by file presence. Four auth.json shapes:
  it('requires a real bearer token for chatgpt mode (access_token present)', async () => {
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(JSON.stringify({ tokens: { access_token: 'tok' } })),
    });
    const s = await a.authStatus({ vendor: 'codex', configDir: '/home/x' });
    expect(s).toEqual({ loggedIn: true, mode: 'chatgpt' });
  });

  it('reports api-key mode for an OPENAI_API_KEY embedded in auth.json (no tokens)', async () => {
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(JSON.stringify({ OPENAI_API_KEY: 'sk-in-file', tokens: null })),
    });
    const s = await a.authStatus({ vendor: 'codex', configDir: '/home/x' });
    expect(s).toEqual({ loggedIn: true, mode: 'api-key' });
    expect(JSON.stringify(s)).not.toContain('sk-in-file');
  });

  it('reports logged out for an empty parseable auth.json ({})', async () => {
    const a = new CodexAdapter({ exec: noExec, env: {}, readTextFile: fixedReader('{}') });
    const s = await a.authStatus({ vendor: 'codex', configDir: '/home/x' });
    expect(s).toEqual({ loggedIn: false });
  });

  it('reports logged out for a token-less/key-less file ({tokens:null})', async () => {
    const a = new CodexAdapter({
      exec: noExec,
      env: {},
      readTextFile: fixedReader(JSON.stringify({ tokens: null })),
    });
    const s = await a.authStatus({ vendor: 'codex', configDir: '/home/x' });
    expect(s).toEqual({ loggedIn: false });
  });
});

describe('availableModels() gating', () => {
  it('returns only the 4 universal models under a chatgpt login', async () => {
    const authJson = JSON.stringify({ tokens: { access_token: 't' } });
    const a = new CodexAdapter({ exec: noExec, env: {}, readTextFile: fixedReader(authJson) });
    const models = await a.availableModels({ vendor: 'codex', configDir: '/home/x' });
    expect(models.map((m) => m.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
    ]);
    expect(models.every((m) => !m.authModes)).toBe(true);
  });

  it('returns the full 6-model catalog under an api-key login', async () => {
    const a = new CodexAdapter({ exec: noExec, env: { OPENAI_API_KEY: 'sk-x' } });
    const models = await a.availableModels();
    expect(models).toHaveLength(6);
    expect(models.map((m) => m.id)).toContain('gpt-5.1-codex-max');
  });

  it('returns the full annotated catalog when logged out', async () => {
    const a = new CodexAdapter({ exec: noExec, env: {}, readTextFile: fixedReader(null) });
    const models = await a.availableModels();
    expect(models).toHaveLength(6);
    const max = models.find((m) => m.id === 'gpt-5.1-codex-max');
    expect(max?.authModes).toEqual(['api-key']);
    expect(models.every((m) => m.default !== true)).toBe(true);
  });
});
