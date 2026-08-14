import { describe, it, expect } from 'vitest';
import { Fleet } from '../src/index.js';
import { makeAdapter, snapshot } from './helpers.js';

const task = { prompt: 'hi' };

describe('Fleet.route() quotaCeiling gate', () => {
  it('ceiling >= 100 disables worst-window filtering (an allowed adapter at 99% passes)', async () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude', { quota: async () => snapshot('claude', { usedPercent: 99 }) }));
    const decision = await fleet.route(task, { quotaCeiling: 100 });
    expect(decision.adapter.vendor).toBe('claude');
    expect(decision.note).toBeUndefined();
  });

  it('allowed:false is a hard gate regardless of ceiling — sole option falls back with a note', async () => {
    const fleet = new Fleet();
    fleet.register(
      makeAdapter('claude', {
        quota: async () => snapshot('claude', { allowed: false, usedPercent: 10 }),
      }),
    );
    const decision = await fleet.route(task, { quotaCeiling: 100 });
    expect(decision.adapter.vendor).toBe('claude'); // only option → best-effort
    expect(decision.note).toContain('best-effort fallback');
  });

  it('prefers an allowed:true adapter over an allowed:false one at the default ceiling', async () => {
    const fleet = new Fleet();
    fleet
      .register(
        makeAdapter('claude', {
          quota: async () => snapshot('claude', { allowed: false, usedPercent: 10 }),
        }),
      )
      .register(makeAdapter('codex', { quota: async () => snapshot('codex', { usedPercent: 95 }) }));
    const decision = await fleet.route(task); // default ceiling 100
    expect(decision.adapter.vendor).toBe('codex'); // allowed:false claude is hard-gated out
    expect(decision.note).toBeUndefined();
  });

  it('a null snapshot passes the gate under a strict ceiling (unknown headroom is not disqualifying)', async () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude', { quota: async () => null }));
    const decision = await fleet.route(task, { quotaCeiling: 50 });
    expect(decision.adapter.vendor).toBe('claude');
    expect(decision.note).toBeUndefined();
  });

  it('allowed:false disqualifies under a ceiling < 100', async () => {
    const fleet = new Fleet();
    fleet
      .register(
        makeAdapter('claude', {
          quota: async () => snapshot('claude', { allowed: false, usedPercent: 1 }),
        }),
      )
      .register(makeAdapter('codex', { quota: async () => snapshot('codex', { usedPercent: 1 }) }));
    const decision = await fleet.route(task, { quotaCeiling: 80 });
    expect(decision.adapter.vendor).toBe('codex');
  });

  it('disqualifies an adapter whose worst window exceeds the ceiling', async () => {
    const fleet = new Fleet();
    fleet
      .register(makeAdapter('claude', { quota: async () => snapshot('claude', { usedPercent: 90 }) }))
      .register(makeAdapter('codex', { quota: async () => snapshot('codex', { usedPercent: 20 }) }));
    const decision = await fleet.route(task, { quotaCeiling: 50 });
    expect(decision.adapter.vendor).toBe('codex');
  });

  it('worstWindow is the max usedPercent across windows', async () => {
    const fleet = new Fleet();
    fleet
      .register(
        makeAdapter('claude', {
          quota: async () =>
            snapshot('claude', {
              windows: [
                { label: '5h', usedPercent: 10 },
                { label: 'weekly', usedPercent: 70 },
              ],
            }),
        }),
      )
      .register(makeAdapter('codex', { quota: async () => snapshot('codex', { usedPercent: 5 }) }));
    // ceiling 50: claude's worst window (70) exceeds it, codex (5) passes.
    const decision = await fleet.route(task, { quotaCeiling: 50 });
    expect(decision.adapter.vendor).toBe('codex');
  });

  it('an empty windows array yields worstWindow 0 and passes any ceiling', async () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude', { quota: async () => snapshot('claude', { windows: [] }) }));
    const decision = await fleet.route(task, { quotaCeiling: 0 });
    expect(decision.adapter.vendor).toBe('claude');
    expect(decision.note).toBeUndefined();
  });

  it('a window exactly at the ceiling passes (boundary is inclusive)', async () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude', { quota: async () => snapshot('claude', { usedPercent: 50 }) }));
    const decision = await fleet.route(task, { quotaCeiling: 50 });
    expect(decision.adapter.vendor).toBe('claude');
  });
});

describe('Fleet.route() all-over-ceiling best-effort fallback', () => {
  it('falls back to the full pool and notes the best-effort choice', async () => {
    const fleet = new Fleet();
    fleet
      .register(makeAdapter('claude', { quota: async () => snapshot('claude', { usedPercent: 95 }) }))
      .register(makeAdapter('codex', { quota: async () => snapshot('codex', { usedPercent: 96 }) }));
    const decision = await fleet.route(task, { quotaCeiling: 50 });
    // prefer-order over the full (gated) pool → first candidate.
    expect(decision.adapter.vendor).toBe('claude');
    expect(decision.note).toContain('best-effort fallback');
    expect(decision.note).toContain('claude');
    expect(decision.note).toContain('50%');
  });

  it('under most-quota fallback, the note names the lowest-usage vendor actually chosen', async () => {
    const fleet = new Fleet();
    fleet
      .register(makeAdapter('claude', { quota: async () => snapshot('claude', { usedPercent: 95 }) }))
      .register(makeAdapter('codex', { quota: async () => snapshot('codex', { usedPercent: 90 }) }));
    const decision = await fleet.route(task, { quotaCeiling: 50, strategy: 'most-quota' });
    expect(decision.adapter.vendor).toBe('codex');
    expect(decision.note).toContain('codex');
  });
});
