import { describe, it, expect } from 'vitest';
import { canSteer, canStream } from '../src/index.js';
import { makeAdapter } from './helpers.js';

const noop = async () => {};
async function* emptyStream() {
  /* yields nothing */
}

describe('canSteer()', () => {
  it('is true only when capabilities.steer === "mid-run" AND a steer method exists', () => {
    const a = makeAdapter('claude', { capabilities: { steer: 'mid-run' }, steer: noop });
    expect(canSteer(a)).toBe(true);
  });

  it('is false when capabilities say mid-run but no steer method is present', () => {
    const a = makeAdapter('claude', { capabilities: { steer: 'mid-run' } });
    expect(canSteer(a)).toBe(false);
  });

  it('is false when a steer method exists but capabilities are not mid-run', () => {
    const a = makeAdapter('claude', { capabilities: { steer: 'turn' }, steer: noop });
    expect(canSteer(a)).toBe(false);
  });

  it('is false when neither capability nor method is present', () => {
    const a = makeAdapter('claude', { capabilities: { steer: 'none' } });
    expect(canSteer(a)).toBe(false);
  });
});

describe('canStream()', () => {
  it('is true only when capabilities.stream AND a stream method exists', () => {
    const a = makeAdapter('claude', { capabilities: { stream: true }, stream: emptyStream });
    expect(canStream(a)).toBe(true);
  });

  it('is false when capabilities.stream is true but no stream method is present', () => {
    const a = makeAdapter('claude', { capabilities: { stream: true } });
    expect(canStream(a)).toBe(false);
  });

  it('is false when a stream method exists but capabilities.stream is false', () => {
    const a = makeAdapter('claude', { capabilities: { stream: false }, stream: emptyStream });
    expect(canStream(a)).toBe(false);
  });

  it('is false when neither capability nor method is present', () => {
    const a = makeAdapter('claude', { capabilities: { stream: false } });
    expect(canStream(a)).toBe(false);
  });
});
