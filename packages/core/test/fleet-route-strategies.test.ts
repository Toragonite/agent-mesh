import { describe, it, expect } from 'vitest';
import { Fleet } from '../src/index.js';
import { makeAdapter, model, snapshot } from './helpers.js';

const task = { prompt: 'hi' };

describe("Fleet.route() strategy 'most-quota'", () => {
  it('picks the adapter with the lowest worst-window usage', async () => {
    const fleet = new Fleet();
    fleet
      .register(makeAdapter('claude', { quota: async () => snapshot('claude', { usedPercent: 60 }) }))
      .register(makeAdapter('codex', { quota: async () => snapshot('codex', { usedPercent: 15 }) }))
      .register(makeAdapter('gemini', { quota: async () => snapshot('gemini', { usedPercent: 40 }) }));
    const decision = await fleet.route(task, { strategy: 'most-quota' });
    expect(decision.adapter.vendor).toBe('codex');
  });

  it('sorts a null snapshot last (treated as Infinity usage)', async () => {
    const fleet = new Fleet();
    fleet
      .register(makeAdapter('claude', { quota: async () => null }))
      .register(makeAdapter('codex', { quota: async () => snapshot('codex', { usedPercent: 80 }) }));
    const decision = await fleet.route(task, { strategy: 'most-quota' });
    expect(decision.adapter.vendor).toBe('codex');
  });

  it('breaks a tie by keeping the earlier candidate in order', async () => {
    const fleet = new Fleet();
    fleet
      .register(makeAdapter('claude', { quota: async () => snapshot('claude', { usedPercent: 30 }) }))
      .register(makeAdapter('codex', { quota: async () => snapshot('codex', { usedPercent: 30 }) }));
    const decision = await fleet.route(task, { strategy: 'most-quota' });
    expect(decision.adapter.vendor).toBe('claude');
  });

  it('honors prefer ordering when computing ties', async () => {
    const fleet = new Fleet();
    fleet
      .register(makeAdapter('claude', { quota: async () => snapshot('claude', { usedPercent: 30 }) }))
      .register(makeAdapter('codex', { quota: async () => snapshot('codex', { usedPercent: 30 }) }));
    const decision = await fleet.route(task, { strategy: 'most-quota', prefer: ['codex', 'claude'] });
    expect(decision.adapter.vendor).toBe('codex');
  });
});

describe("Fleet.route() strategy 'lowest-latency'", () => {
  it('picks the first candidate offering a fast-class model', async () => {
    const fleet = new Fleet();
    fleet
      .register(makeAdapter('claude', { availableModels: async () => [model('opus', { latencyClass: 'slow' })] }))
      .register(makeAdapter('codex', { availableModels: async () => [model('flash', { latencyClass: 'fast' })] }));
    const decision = await fleet.route(task, { strategy: 'lowest-latency' });
    expect(decision.adapter.vendor).toBe('codex');
  });

  it('treats availableModels() throwing as "no fast model"', async () => {
    const fleet = new Fleet();
    fleet
      .register(
        makeAdapter('claude', {
          availableModels: async () => {
            throw new Error('cannot list models');
          },
        }),
      )
      .register(makeAdapter('codex', { availableModels: async () => [model('flash', { latencyClass: 'fast' })] }));
    const decision = await fleet.route(task, { strategy: 'lowest-latency' });
    expect(decision.adapter.vendor).toBe('codex');
  });

  it('falls back to pool[0] when no candidate has a fast model', async () => {
    const fleet = new Fleet();
    fleet
      .register(makeAdapter('claude', { availableModels: async () => [model('opus', { latencyClass: 'slow' })] }))
      .register(makeAdapter('codex', { availableModels: async () => [] }));
    const decision = await fleet.route(task, { strategy: 'lowest-latency' });
    expect(decision.adapter.vendor).toBe('claude');
  });

  it('returns the first fast candidate even when an earlier one is fast too', async () => {
    const fleet = new Fleet();
    fleet
      .register(makeAdapter('claude', { availableModels: async () => [model('a', { latencyClass: 'fast' })] }))
      .register(makeAdapter('codex', { availableModels: async () => [model('b', { latencyClass: 'fast' })] }));
    const decision = await fleet.route(task, { strategy: 'lowest-latency' });
    expect(decision.adapter.vendor).toBe('claude');
  });
});

describe('Fleet.route() policy.latency (cross-strategy)', () => {
  it('restricts most-quota to adapters offering the requested class', async () => {
    const fleet = new Fleet();
    fleet
      .register(
        makeAdapter('claude', {
          quota: async () => snapshot('claude', { usedPercent: 10 }),
          availableModels: async () => [model('opus', { latencyClass: 'slow' })],
        }),
      )
      .register(
        makeAdapter('codex', {
          quota: async () => snapshot('codex', { usedPercent: 80 }),
          availableModels: async () => [model('flash', { latencyClass: 'fast' })],
        }),
      );
    // most-quota alone would pick claude (10% < 80%); latency:'fast' filters to codex first.
    const decision = await fleet.route(task, { strategy: 'most-quota', latency: 'fast' });
    expect(decision.adapter.vendor).toBe('codex');
  });

  it('ignores the latency preference (soft) when no adapter offers the class', async () => {
    const fleet = new Fleet();
    fleet
      .register(
        makeAdapter('claude', {
          quota: async () => snapshot('claude', { usedPercent: 10 }),
          availableModels: async () => [model('opus', { latencyClass: 'slow' })],
        }),
      )
      .register(
        makeAdapter('codex', {
          quota: async () => snapshot('codex', { usedPercent: 80 }),
          availableModels: async () => [model('o1', { latencyClass: 'slow' })],
        }),
      );
    // no fast model anywhere → preference ignored → most-quota picks claude (10%).
    const decision = await fleet.route(task, { strategy: 'most-quota', latency: 'fast' });
    expect(decision.adapter.vendor).toBe('claude');
  });
});
