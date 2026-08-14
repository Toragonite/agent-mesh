import { describe, it, expect } from 'vitest';
import * as codex from '../src/index.js';

describe('package entry exports (seam parity)', () => {
  it('re-exports both process seams — nodeExec and nodeLineStream — from the entry', () => {
    expect(typeof codex.nodeExec).toBe('function');
    expect(typeof codex.nodeLineStream).toBe('function');
  });
});
