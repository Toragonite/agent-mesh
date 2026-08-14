import { describe, it, expect } from 'vitest';
import type { Account } from '@toragonite/agent-mesh';
import { CodexAdapter } from '../src/adapter.js';
import { resolveCodexHome } from '../src/auth.js';
import { recordingExec, fixedReader, jsonl } from './helpers.js';

const HAPPY = jsonl(
  { type: 'thread.started', thread_id: 'conv_abc' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
);

describe('child env threading (M7)', () => {
  it('composes the child env from the injected seam, not process.env, when no configDir', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: { CODEX_HOME: '/seam/home', SOME_KEY: '1' } });
    await a.run({ prompt: 'hi' }); // no account, no defaultAccount
    // The base is exactly this.env — a leak of the real process.env would add many
    // more keys (PATH, HOME, ...). It equals the seam verbatim.
    expect(calls[0]!.env).toEqual({ CODEX_HOME: '/seam/home', SOME_KEY: '1' });
  });

  it('overlays CODEX_HOME from the account configDir onto the seam env', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({ exec, env: { KEEP: 'yes' } });
    await a.run({ prompt: 'hi', account: { vendor: 'codex', configDir: '/acct/home' } });
    expect(calls[0]!.env).toEqual({ KEEP: 'yes', CODEX_HOME: '/acct/home' });
  });

  it('an explicit account without configDir resolves ambient, NOT the defaultAccount configDir', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({
      exec,
      env: { CODEX_HOME: '/ambient' },
      defaultAccount: { vendor: 'codex', configDir: '/default/home' },
    });
    await a.run({ prompt: 'hi', account: { vendor: 'codex' } });
    // account is passed but carries no configDir → ambient (seam) wins, default ignored
    expect(calls[0]!.env?.CODEX_HOME).toBe('/ambient');
  });

  it('falls back to the defaultAccount configDir when no account is passed', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({
      exec,
      env: {},
      defaultAccount: { vendor: 'codex', configDir: '/default/home' },
    });
    await a.run({ prompt: 'hi' });
    expect(calls[0]!.env?.CODEX_HOME).toBe('/default/home');
  });
});

describe('malformed account is absent (U4)', () => {
  it('a null account falls back to the defaultAccount configDir', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({
      exec,
      env: {},
      defaultAccount: { vendor: 'codex', configDir: '/default/home' },
    });
    await a.run({ prompt: 'hi', account: null as unknown as Account });
    expect(calls[0]!.env?.CODEX_HOME).toBe('/default/home');
  });

  it('a non-object account (array) falls back to the defaultAccount, not ambient', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({
      exec,
      env: { CODEX_HOME: '/ambient' },
      defaultAccount: { vendor: 'codex', configDir: '/default/home' },
    });
    await a.run({ prompt: 'hi', account: [] as unknown as Account });
    expect(calls[0]!.env?.CODEX_HOME).toBe('/default/home');
  });

  it('an object account with no configDir still means ambient (not the default)', async () => {
    const { exec, calls } = recordingExec({ stdout: HAPPY });
    const a = new CodexAdapter({
      exec,
      env: { CODEX_HOME: '/ambient' },
      defaultAccount: { vendor: 'codex', configDir: '/default/home' },
    });
    await a.run({ prompt: 'hi', account: {} as unknown as Account });
    expect(calls[0]!.env?.CODEX_HOME).toBe('/ambient');
  });

  it('authStatus and quota tolerate a malformed account without throwing', async () => {
    const a = new CodexAdapter({ exec: recordingExec().exec, env: {}, readTextFile: fixedReader(null) });
    await expect(a.authStatus(null as unknown as Account)).resolves.toEqual({ loggedIn: false });
    await expect(a.quota('garbage' as unknown as Account)).resolves.toBeNull();
  });
});

describe('resolveCodexHome precedence (M7)', () => {
  it('an explicit account configDir wins over everything', () => {
    expect(
      resolveCodexHome(
        { vendor: 'codex', configDir: '/a' },
        { vendor: 'codex', configDir: '/d' },
        { CODEX_HOME: '/env' },
      ),
    ).toBe('/a');
  });

  it('an explicit account without configDir → ambient env, not the default account', () => {
    expect(
      resolveCodexHome(
        { vendor: 'codex' },
        { vendor: 'codex', configDir: '/d' },
        { CODEX_HOME: '/ambient' },
      ),
    ).toBe('/ambient');
  });

  it('no account → default account configDir', () => {
    expect(
      resolveCodexHome(undefined, { vendor: 'codex', configDir: '/d' }, { CODEX_HOME: '/ambient' }),
    ).toBe('/d');
  });

  it('no account, no default → ambient CODEX_HOME env', () => {
    expect(resolveCodexHome(undefined, undefined, { CODEX_HOME: '/env' })).toBe('/env');
  });
});
