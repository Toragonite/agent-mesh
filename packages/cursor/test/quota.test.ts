import { describe, it, expect } from 'vitest';
import { CursorAdapter } from '../src/adapter.js';
import { recordingExec } from './helpers.js';

describe('quota()', () => {
  it('returns null unconditionally (unknown-headroom signal) and never spawns', async () => {
    const { exec, calls } = recordingExec();
    const a = new CursorAdapter({ exec, env: {} });
    expect(await a.quota()).toBeNull();
    expect(await a.quota({ vendor: 'cursor', configDir: '/x' })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('advertises capabilities.quota as false', () => {
    const a = new CursorAdapter({ exec: recordingExec().exec, env: {} });
    expect(a.capabilities.quota).toBe(false);
    expect(a.capabilities).toEqual({
      resume: true,
      steer: 'turn',
      peerMesh: false,
      quota: false,
      stream: true,
    });
  });
});
