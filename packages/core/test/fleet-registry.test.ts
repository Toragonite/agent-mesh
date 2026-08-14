import { describe, it, expect } from 'vitest';
import { Fleet } from '../src/index.js';
import { makeAdapter } from './helpers.js';

describe('Fleet registry', () => {
  it('register() returns the fleet for chaining', () => {
    const fleet = new Fleet();
    const a = makeAdapter('claude');
    expect(fleet.register(a)).toBe(fleet);
  });

  it('get() returns the registered adapter for a vendor', () => {
    const fleet = new Fleet();
    const a = makeAdapter('claude');
    fleet.register(a);
    expect(fleet.get('claude')).toBe(a);
  });

  it('get() returns undefined for an unregistered vendor', () => {
    const fleet = new Fleet();
    expect(fleet.get('codex')).toBeUndefined();
  });

  it('list() preserves insertion order', () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('codex')).register(makeAdapter('claude')).register(makeAdapter('gemini'));
    expect(fleet.list().map((a) => a.vendor)).toEqual(['codex', 'claude', 'gemini']);
  });

  it('re-registering the same vendor replaces the adapter without adding an entry', () => {
    const fleet = new Fleet();
    const first = makeAdapter('claude');
    const second = makeAdapter('claude');
    fleet.register(first).register(second);
    expect(fleet.get('claude')).toBe(second);
    expect(fleet.list()).toHaveLength(1);
  });

  it('re-registering keeps the original ordinal position (Map insertion semantics)', () => {
    const fleet = new Fleet();
    fleet.register(makeAdapter('claude')).register(makeAdapter('codex'));
    const replacement = makeAdapter('claude');
    fleet.register(replacement);
    expect(fleet.list().map((a) => a.vendor)).toEqual(['claude', 'codex']);
    expect(fleet.get('claude')).toBe(replacement);
  });
});
