import { describe, it, expect } from 'vitest';
import { CursorAdapter } from '../src/adapter.js';
import { recordingExec, RESULT_JSON } from './helpers.js';

describe('env / account precedence', () => {
  it('hands the injected base env to the exec seam (no config-dir var added)', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({ exec, env: { FOO: 'bar' } });
    await a.run({ prompt: 'hi' });
    expect(calls[0]!.env).toEqual({ FOO: 'bar' });
  });

  it('an explicit account with no configDir resolves AMBIENT and does NOT inherit defaultAccount.configDir', async () => {
    const { exec, calls } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({
      exec,
      env: { FOO: 'bar' },
      defaultAccount: { vendor: 'cursor', configDir: '/default' },
    });
    const r = await a.run({ prompt: 'hi', account: { vendor: 'cursor' } });
    // Account is authoritative: no configDir → ambient → no "ignored" note, no inheritance.
    expect(r.note).toBeUndefined();
    // cursor-agent has no config-dir env var — the child env is just the base seam.
    expect(calls[0]!.env).toEqual({ FOO: 'bar' });
  });

  it('falls back to defaultAccount.configDir only when NO account is passed (note surfaces)', async () => {
    const { exec } = recordingExec({ stdout: RESULT_JSON });
    const a = new CursorAdapter({
      exec,
      env: {},
      defaultAccount: { vendor: 'cursor', configDir: '/default' },
    });
    const r = await a.run({ prompt: 'hi' });
    expect(r.note).toContain('account.configDir is not supported by cursor-agent; ignored');
  });
});
