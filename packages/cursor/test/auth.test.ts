import { describe, it, expect } from 'vitest';
import { CursorAdapter } from '../src/adapter.js';
import { recordingExec, throwingExec } from './helpers.js';

describe('authStatus()', () => {
  it('reports logged in with the captured identifier on exit 0', async () => {
    const { exec } = recordingExec({ stdout: '✓ Logged in as someone@example.com', exitCode: 0 });
    const a = new CursorAdapter({ exec, env: {} });
    const s = await a.authStatus();
    expect(s).toEqual({ loggedIn: true, mode: 'cursor', detail: 'someone@example.com' });
  });

  it('reports logged in with no detail when exit 0 but output is unparseable', async () => {
    const { exec } = recordingExec({ stdout: 'some other banner', exitCode: 0 });
    const a = new CursorAdapter({ exec, env: {} });
    const s = await a.authStatus();
    expect(s).toEqual({ loggedIn: true, mode: 'cursor' });
  });

  it('reports logged out on a non-zero exit', async () => {
    const { exec } = recordingExec({ stdout: 'not logged in', exitCode: 1 });
    const a = new CursorAdapter({ exec, env: {} });
    expect(await a.authStatus()).toEqual({ loggedIn: false });
  });

  it('reports logged out on ENOENT and never throws', async () => {
    const a = new CursorAdapter({ exec: throwingExec(new Error('spawn ENOENT')).exec, env: {} });
    expect(await a.authStatus()).toEqual({ loggedIn: false });
  });

  it('reports logged out on a timeout', async () => {
    const { exec } = recordingExec({ stdout: '', exitCode: null, timedOut: true });
    const a = new CursorAdapter({ exec, env: {} });
    expect(await a.authStatus()).toEqual({ loggedIn: false });
  });

  it('never surfaces token material in detail', async () => {
    const { exec } = recordingExec({ stdout: '✓ Logged in as dev@corp.io', exitCode: 0 });
    const a = new CursorAdapter({ exec, env: {} });
    const s = await a.authStatus();
    expect(s.detail).toBe('dev@corp.io');
    expect(JSON.stringify(s)).not.toMatch(/token|bearer|sk-/i);
  });
});
