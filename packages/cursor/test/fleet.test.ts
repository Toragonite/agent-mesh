import { describe, it, expect } from 'vitest';
import { Fleet, type Adapter } from '@toragonite/agent-mesh';
import { CursorAdapter } from '../src/adapter.js';
import { recordingExec, RESULT_JSON } from './helpers.js';

/** A minimal inline second adapter to route against. */
const other: Adapter = {
  vendor: 'claude',
  capabilities: { resume: true, steer: 'none', peerMesh: false, quota: true, stream: false },
  async authStatus() {
    return { loggedIn: true };
  },
  async availableModels() {
    return [{ id: 'claude-x', latencyClass: 'slow' }];
  },
  async quota() {
    return { vendor: 'claude', windows: [{ label: '5h', usedPercent: 20 }], allowed: true };
  },
  async run() {
    return { vendor: 'claude', conversationId: 'c-claude', text: 'from claude', status: 'ok' };
  },
  async resume() {
    return { vendor: 'claude', conversationId: 'c-claude', text: 'resumed claude', status: 'ok' };
  },
};

function buildCursor() {
  return new CursorAdapter({ exec: recordingExec({ stdout: RESULT_JSON }).exec, env: {} });
}

describe('Fleet e2e with CursorAdapter', () => {
  it('routes by prefer-order (cursor first wins)', async () => {
    const fleet = new Fleet().register(buildCursor()).register(other);
    const decision = await fleet.route({ prompt: 'hi' }, { prefer: ['cursor', 'claude'] });
    expect(decision.adapter.vendor).toBe('cursor');
  });

  it('routes by prefer-order (claude first wins)', async () => {
    const fleet = new Fleet().register(buildCursor()).register(other);
    const decision = await fleet.route({ prompt: 'hi' }, { prefer: ['claude', 'cursor'] });
    expect(decision.adapter.vendor).toBe('claude');
  });

  it('runs a round-trip through the cursor adapter when the task pins it', async () => {
    const fleet = new Fleet().register(buildCursor()).register(other);
    const r = await fleet.run({ prompt: 'hi', account: { vendor: 'cursor' } });
    expect(r.vendor).toBe('cursor');
    expect(r.text).toBe('MESH-OK');
    expect(r.conversationId).toBe('630ad917-aaaa');
  });

  it('resumes targeting the cursor vendor', async () => {
    const fleet = new Fleet().register(buildCursor()).register(other);
    const r = await fleet.resume('cursor', '630ad917-aaaa', 'again');
    expect(r.vendor).toBe('cursor');
    expect(r.conversationId).toBe('630ad917-aaaa');
  });
});
