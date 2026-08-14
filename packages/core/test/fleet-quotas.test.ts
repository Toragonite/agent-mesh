import { describe, it, expect } from 'vitest';
import { Fleet } from '../src/index.js';
import { makeAdapter, snapshot } from './helpers.js';

describe('Fleet.quotas()', () => {
  it('returns one entry per registered adapter, in list order', async () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude')).register(makeAdapter('codex'));
    const result = await fleet.quotas();
    expect(result.map((e) => e.vendor)).toEqual(['claude', 'codex']);
  });

  it('carries through each adapter snapshot', async () => {
    const fleet = new Fleet();
    const snap = snapshot('claude', { usedPercent: 42 });
    fleet.register(makeAdapter('claude', { quota: async () => snap }));
    const [entry] = await fleet.quotas();
    expect(entry?.snapshot).toBe(snap);
  });

  it('yields a null snapshot (never rejects) when an adapter quota() throws', async () => {
    const fleet = new Fleet();
    fleet.register(
      makeAdapter('claude', {
        quota: async () => {
          throw new Error('endpoint down');
        },
      }),
    );
    const [entry] = await fleet.quotas();
    expect(entry).toEqual({ vendor: 'claude', snapshot: null });
  });

  it('isolates a throwing adapter from a healthy one', async () => {
    const fleet = new Fleet();
    const good = snapshot('codex', { usedPercent: 10 });
    fleet
      .register(
        makeAdapter('claude', {
          quota: async () => {
            throw new Error('boom');
          },
        }),
      )
      .register(makeAdapter('codex', { quota: async () => good }));
    const result = await fleet.quotas();
    expect(result).toEqual([
      { vendor: 'claude', snapshot: null },
      { vendor: 'codex', snapshot: good },
    ]);
  });

  it('passes a null snapshot straight through when the adapter reports unknown', async () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude', { quota: async () => null }));
    const [entry] = await fleet.quotas();
    expect(entry?.snapshot).toBeNull();
  });
});
