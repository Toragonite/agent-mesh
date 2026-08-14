import { describe, it, expect } from 'vitest';
import { createChat } from '../src/adapter.js';
import { recordingExec, throwingExec } from './helpers.js';

describe('createChat()', () => {
  it('returns the trimmed UUID printed on stdout (ground truth C)', async () => {
    const { exec, calls } = recordingExec({ stdout: '  fe11978d-1111-2222-3333-444455556666  \n', exitCode: 0 });
    const id = await createChat({ exec });
    expect(id).toBe('fe11978d-1111-2222-3333-444455556666');
    expect(calls[0]!.args).toEqual(['create-chat']);
  });

  it('returns null on a non-zero exit', async () => {
    const { exec } = recordingExec({ stdout: '', exitCode: 1 });
    expect(await createChat({ exec })).toBeNull();
  });

  it('returns null on empty stdout', async () => {
    const { exec } = recordingExec({ stdout: '   ', exitCode: 0 });
    expect(await createChat({ exec })).toBeNull();
  });

  it('returns null on a timeout', async () => {
    const { exec } = recordingExec({ stdout: '', exitCode: null, timedOut: true });
    expect(await createChat({ exec })).toBeNull();
  });

  it('returns null on a spawn failure and never throws', async () => {
    const id = await createChat({ exec: throwingExec(new Error('ENOENT')).exec });
    expect(id).toBeNull();
  });
});
