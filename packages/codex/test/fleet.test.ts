import { describe, it, expect } from 'vitest';
import { Fleet, type Adapter } from '@toragonite/agent-mesh';
import { CodexAdapter } from '../src/adapter.js';
import { recordingExec, fixedReader, fakeFetch, jsonl } from './helpers.js';

const HAPPY = jsonl(
  { type: 'thread.started', thread_id: 'conv_abc' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Hello world' } },
);

/** A minimal inline second adapter with a heavier quota window. */
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
    return { vendor: 'claude', windows: [{ label: '5h', usedPercent: 90 }], allowed: true };
  },
  async run() {
    return { vendor: 'claude', conversationId: 'c-claude', text: 'from claude', status: 'ok' };
  },
  async resume() {
    return { vendor: 'claude', conversationId: 'c-claude', text: 'resumed claude', status: 'ok' };
  },
};

function buildCodex() {
  return new CodexAdapter({
    exec: recordingExec({ stdout: HAPPY }).exec,
    env: {},
    readTextFile: fixedReader(JSON.stringify({ tokens: { access_token: 't' } })),
    fetchFn: fakeFetch({ allowed: true, primary_window: { used_percent: 10 } }).fn,
    defaultAccount: { vendor: 'codex', configDir: '/home/x' },
  });
}

describe('Fleet e2e with CodexAdapter', () => {
  it('routes by prefer-order (first candidate wins)', async () => {
    const fleet = new Fleet().register(buildCodex()).register(other);
    const decision = await fleet.route({ prompt: 'hi' }, { prefer: ['claude', 'codex'] });
    expect(decision.adapter.vendor).toBe('claude');
  });

  it('routes by most-quota (codex has more headroom)', async () => {
    const fleet = new Fleet().register(buildCodex()).register(other);
    const decision = await fleet.route(
      { prompt: 'hi' },
      { prefer: ['claude', 'codex'], strategy: 'most-quota' },
    );
    expect(decision.adapter.vendor).toBe('codex');
  });

  it('runs a round-trip through the codex adapter when the task pins it', async () => {
    const fleet = new Fleet().register(buildCodex()).register(other);
    const r = await fleet.run({ prompt: 'hi', account: { vendor: 'codex' } });
    expect(r.vendor).toBe('codex');
    expect(r.text).toBe('Hello world');
    expect(r.conversationId).toBe('conv_abc');
  });

  it('resumes targeting the codex vendor', async () => {
    const fleet = new Fleet().register(buildCodex()).register(other);
    const r = await fleet.resume('codex', 'conv_abc', 'again');
    expect(r.vendor).toBe('codex');
    expect(r.conversationId).toBe('conv_abc');
  });
});
