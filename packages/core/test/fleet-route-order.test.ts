import { describe, it, expect } from 'vitest';
import { Fleet, NoRouteError } from '../src/index.js';
import { makeAdapter } from './helpers.js';

const task = { prompt: 'hi' };

describe('Fleet.route() candidate selection & prefer-order (default)', () => {
  it('defaults to prefer-order: first registered adapter past the gate wins', async () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude')).register(makeAdapter('codex'));
    const decision = await fleet.route(task);
    expect(decision.adapter.vendor).toBe('claude');
    expect(decision.note).toBeUndefined();
  });

  it('prefer restricts AND orders the candidate set', async () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude')).register(makeAdapter('codex')).register(makeAdapter('gemini'));
    const decision = await fleet.route(task, { prefer: ['codex', 'claude'] });
    expect(decision.adapter.vendor).toBe('codex');
  });

  it('skips prefer vendors that have no registered adapter', async () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude')).register(makeAdapter('codex'));
    const decision = await fleet.route(task, { prefer: ['gemini', 'codex'] });
    expect(decision.adapter.vendor).toBe('codex');
  });

  it('throws NoRouteError when prefer names only unregistered vendors', async () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude'));
    await expect(fleet.route(task, { prefer: ['gemini'] })).rejects.toBeInstanceOf(NoRouteError);
  });

  it('throws NoRouteError when no adapters are registered at all', async () => {
    const fleet = new Fleet();
    await expect(fleet.route(task)).rejects.toBeInstanceOf(NoRouteError);
  });

  it('treats an empty prefer array as "no preference" and uses the full list', async () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude')).register(makeAdapter('codex'));
    const decision = await fleet.route(task, { prefer: [] });
    expect(decision.adapter.vendor).toBe('claude');
  });
});
