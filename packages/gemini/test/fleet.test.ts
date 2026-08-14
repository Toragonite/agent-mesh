import { describe, it, expect } from 'vitest';
import { Fleet, type Adapter } from '@toragonite/agent-mesh';
import { GeminiAdapter } from '../src/adapter.js';
import { recordingExec, jsonl } from './helpers.js';

const HAPPY = jsonl({ conversation_id: 'conv_abc', status: 'SUCCESS', response: 'Hello world\n' });

/** A minimal inline second adapter with a known-quota window. */
const other: Adapter = {
  vendor: 'codex',
  capabilities: { resume: true, steer: 'none', peerMesh: false, quota: true, stream: false },
  async authStatus() {
    return { loggedIn: true };
  },
  async availableModels() {
    return [{ id: 'codex-x', latencyClass: 'slow' }];
  },
  async quota() {
    return { vendor: 'codex', windows: [{ label: '5h', usedPercent: 40 }], allowed: true };
  },
  async run() {
    return { vendor: 'codex', conversationId: 'c-codex', text: 'from codex', status: 'ok' };
  },
  async resume() {
    return { vendor: 'codex', conversationId: 'c-codex', text: 'resumed codex', status: 'ok' };
  },
};

function buildGemini() {
  return new GeminiAdapter({ exec: recordingExec({ stdout: HAPPY }).exec, env: {} });
}

describe('Fleet e2e with GeminiAdapter (T23)', () => {
  it('routes by prefer-order (first candidate wins)', async () => {
    const fleet = new Fleet().register(buildGemini()).register(other);
    const decision = await fleet.route({ prompt: 'hi' }, { prefer: ['gemini', 'codex'] });
    expect(decision.adapter.vendor).toBe('gemini');
  });

  it('runs a round-trip through the gemini adapter when the task pins it', async () => {
    const fleet = new Fleet().register(buildGemini()).register(other);
    const r = await fleet.run({ prompt: 'hi', account: { vendor: 'gemini' } });
    expect(r.vendor).toBe('gemini');
    expect(r.text).toBe('Hello world');
    expect(r.conversationId).toBe('conv_abc');
  });

  it('resumes targeting the gemini vendor', async () => {
    const fleet = new Fleet().register(buildGemini()).register(other);
    const r = await fleet.resume('gemini', 'conv_abc', 'again');
    expect(r.vendor).toBe('gemini');
    expect(r.conversationId).toBe('conv_abc');
  });
});
