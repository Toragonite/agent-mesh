import { describe, it, expect } from 'vitest';
import { CursorAdapter } from '../src/adapter.js';
import { scriptedExec, last } from './helpers.js';

describe('concurrency', () => {
  it('two concurrent run() calls on one instance resolve independently (no shared mutable run state)', async () => {
    const { exec } = scriptedExec((req) => {
      const prompt = last(req.args);
      const session = prompt === 'A' ? 'sA' : 'sB';
      const result = prompt === 'A' ? 'answer-A' : 'answer-B';
      return {
        stdout: JSON.stringify({ type: 'result', subtype: 'success', result, session_id: session }),
      };
    });
    const a = new CursorAdapter({ exec, env: {} });
    const [rA, rB] = await Promise.all([a.run({ prompt: 'A' }), a.run({ prompt: 'B' })]);
    expect(rA.text).toBe('answer-A');
    expect(rA.conversationId).toBe('sA');
    expect(rB.text).toBe('answer-B');
    expect(rB.conversationId).toBe('sB');
  });

  it('the shared model memo stays correct under concurrent availableModels() calls', async () => {
    const { exec } = scriptedExec((req) => {
      if (req.args[0] === 'models') {
        return { stdout: 'Available models\n\nauto - Auto\ncomposer-2.5 - Composer 2.5' };
      }
      return {};
    });
    const a = new CursorAdapter({ exec, env: {} });
    const [m1, m2] = await Promise.all([a.availableModels(), a.availableModels()]);
    expect(m1.map((m) => m.id)).toEqual(['auto', 'composer-2.5']);
    expect(m2.map((m) => m.id)).toEqual(['auto', 'composer-2.5']);
  });
});
