import { describe, it, expect } from 'vitest';
import { Fleet, NoRouteError } from '../src/index.js';
import { makeAdapter, okResult, snapshot } from './helpers.js';

describe('Fleet.run()', () => {
  it('pins the vendor from task.account without routing or reading quota', async () => {
    const fleet = new Fleet();
    const claude = makeAdapter('claude', { quota: async () => snapshot('claude', { usedPercent: 99 }) });
    const codex = makeAdapter('codex');
    fleet.register(claude).register(codex);

    const task = { prompt: 'go', account: { vendor: 'codex' as const } };
    const result = await fleet.run(task);

    expect(result.vendor).toBe('codex');
    // Routing/quota were bypassed: neither adapter's quota() was consulted.
    expect(claude.calls.quota).toHaveLength(0);
    expect(codex.calls.quota).toHaveLength(0);
    // The pinned adapter ran with the exact task.
    expect(codex.calls.run).toEqual([task]);
    expect(claude.calls.run).toHaveLength(0);
  });

  it('throws NoRouteError when the pinned vendor is not registered', async () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude'));
    await expect(fleet.run({ prompt: 'go', account: { vendor: 'gemini' } })).rejects.toBeInstanceOf(
      NoRouteError,
    );
  });

  it('routes then runs the chosen adapter when no account is pinned', async () => {
    const fleet = new Fleet();
    const claude = makeAdapter('claude', { run: async () => okResult('claude', { text: 'routed' }) });
    const codex = makeAdapter('codex');
    fleet.register(claude).register(codex);

    const task = { prompt: 'go' };
    const result = await fleet.run(task);

    expect(result.text).toBe('routed');
    expect(claude.calls.run).toEqual([task]);
    expect(codex.calls.run).toHaveLength(0);
  });

  it('applies the routing policy when selecting the adapter to run', async () => {
    const fleet = new Fleet();
    const claude = makeAdapter('claude');
    const codex = makeAdapter('codex');
    fleet.register(claude).register(codex);

    const result = await fleet.run({ prompt: 'go' }, { policy: { prefer: ['codex'] } });

    expect(result.vendor).toBe('codex');
    expect(codex.calls.run).toHaveLength(1);
    expect(claude.calls.run).toHaveLength(0);
  });
});

describe('Fleet.resume()', () => {
  it('delegates to the named vendor adapter with the conversation id, message, and opts', async () => {
    const fleet = new Fleet();
    const codex = makeAdapter('codex');
    fleet.register(makeAdapter('claude')).register(codex);

    const opts = { model: 'gpt-5' };
    await fleet.resume('codex', 'conv-9', 'keep going', opts);

    expect(codex.calls.resume).toEqual([{ conversationId: 'conv-9', message: 'keep going', opts }]);
  });

  it('returns whatever the adapter resume() produces', async () => {
    const fleet = new Fleet();
    fleet.register(
      makeAdapter('claude', { resume: async () => okResult('claude', { text: 'resumed', conversationId: 'c1' }) }),
    );
    const result = await fleet.resume('claude', 'c1', 'more');
    expect(result.text).toBe('resumed');
  });

  it('throws NoRouteError for an unregistered vendor', () => {
    // Fleet.resume() is not async: require() throws synchronously, it does not reject.
    const fleet = new Fleet();
    expect(() => fleet.resume('gemini', 'c1', 'more')).toThrow(NoRouteError);
  });
});
