import { describe, it, expect } from 'vitest';
import { GeminiAdapter } from '../src/adapter.js';
import { recordingExec, jsonl } from './helpers.js';

const OK = jsonl({ conversation_id: 'c1', status: 'SUCCESS', response: 'ok' });

describe('child env / account precedence (T21)', () => {
  it('composes the child env from the injected seam, not process.env, when no configDir', async () => {
    const { exec, calls } = recordingExec({ stdout: OK });
    const a = new GeminiAdapter({ exec, env: { SOME_KEY: '1' } });
    await a.run({ prompt: 'hi' }); // no account, no defaultAccount
    // A leak of the real process.env would add PATH/HOME/... — the base equals the seam.
    expect(calls[0]!.env).toEqual({ SOME_KEY: '1' });
    expect(calls[0]!.env?.AGY_HOME).toBeUndefined();
  });

  it('overlays AGY_HOME from the account configDir and notes that agy does not read it', async () => {
    const { exec, calls } = recordingExec({ stdout: OK });
    const a = new GeminiAdapter({ exec, env: { KEEP: 'yes' } });
    const r = await a.run({ prompt: 'hi', account: { vendor: 'gemini', configDir: '/acct/home' } });
    expect(calls[0]!.env).toEqual({ KEEP: 'yes', AGY_HOME: '/acct/home' });
    expect(r.note).toContain('passed as AGY_HOME');
    // agy 1.3.5 contains no AGY_HOME string: the note says so, not "unverified".
    expect(r.note).toContain('agy 1.3.5 does not read');
    expect(r.note).toContain('isolation is not provided');
    expect(r.note).toContain('default agy login');
    expect(r.note).not.toContain('unverified');
  });

  it('an explicit account without configDir resolves ambient, NOT the defaultAccount configDir', async () => {
    const { exec, calls } = recordingExec({ stdout: OK });
    const a = new GeminiAdapter({
      exec,
      env: {},
      defaultAccount: { vendor: 'gemini', configDir: '/default/home' },
    });
    const r = await a.run({ prompt: 'hi', account: { vendor: 'gemini' } });
    expect(calls[0]!.env?.AGY_HOME).toBeUndefined();
    expect(r.note ?? '').not.toContain('AGY_HOME');
  });

  it('falls back to the defaultAccount configDir when no account is passed', async () => {
    const { exec, calls } = recordingExec({ stdout: OK });
    const a = new GeminiAdapter({
      exec,
      env: {},
      defaultAccount: { vendor: 'gemini', configDir: '/default/home' },
    });
    await a.run({ prompt: 'hi' });
    expect(calls[0]!.env?.AGY_HOME).toBe('/default/home');
  });

  it('threads AGY_HOME through authStatus too', async () => {
    const { exec, calls } = recordingExec({ stdout: 'x\tX', exitCode: 0 });
    const a = new GeminiAdapter({ exec, env: {} });
    await a.authStatus({ vendor: 'gemini', configDir: '/probe/home' });
    expect(calls[0]!.env?.AGY_HOME).toBe('/probe/home');
  });
});

describe('null / malformed account is ABSENT, not an error (U4)', () => {
  it('treats a null account as absent and falls back to defaultAccount', async () => {
    const { exec, calls } = recordingExec({ stdout: OK });
    const a = new GeminiAdapter({
      exec,
      env: {},
      defaultAccount: { vendor: 'gemini', configDir: '/default/home' },
    });
    await a.run({ prompt: 'hi', account: null as never });
    expect(calls[0]!.env?.AGY_HOME).toBe('/default/home');
  });

  it('treats a non-object account as absent (default fallback), NOT ambient', async () => {
    const { exec, calls } = recordingExec({ stdout: OK });
    const a = new GeminiAdapter({
      exec,
      env: {},
      defaultAccount: { vendor: 'gemini', configDir: '/default/home' },
    });
    await a.run({ prompt: 'hi', account: 'nope' as never });
    expect(calls[0]!.env?.AGY_HOME).toBe('/default/home');
  });

  it('a null account never throws in resume, quota, availableModels, or authStatus', async () => {
    const a = new GeminiAdapter({
      exec: recordingExec({ stdout: 'x\tX', exitCode: 0 }).exec,
      env: {},
    });
    await expect(a.resume('c1', 'go', { account: null as never })).resolves.toBeDefined();
    await expect(a.quota(null as never)).resolves.toBeNull();
    await expect(a.availableModels(null as never)).resolves.toHaveLength(11);
    await expect(a.authStatus(null as never)).resolves.toEqual({ loggedIn: true, mode: 'google' });
  });
});
