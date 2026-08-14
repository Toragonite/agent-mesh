import { describe, it, expect } from 'vitest';
import { nodeExec } from '../src/exec.js';

// These drive the REAL nodeExec against a real `node` child (hermetic: no codex
// CLI, no network). They pin the streaming-decode and stdin fixes that fake exec
// seams can never exercise.

describe('nodeExec UTF-8 stream decoding (M1)', () => {
  it('reassembles a multi-byte character split across stdout chunks', async () => {
    // Write a CJK+emoji payload in two chunks, splitting INSIDE a multi-byte char.
    const script = [
      "const b = Buffer.from('\\uD55C\\uAD6D\\uC5B4 test \\uD83C\\uDF10', 'utf8');",
      'const mid = 4;', // byte 4 lands inside the 2nd Hangul syllable
      'process.stdout.write(b.subarray(0, mid));',
      'setTimeout(() => { process.stdout.write(b.subarray(mid)); }, 30);',
    ].join('\n');
    const res = await nodeExec({ cmd: process.execPath, args: ['-e', script], timeoutMs: 10000 });
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toBe('한국어 test 🌐');
    expect(res.stdout).not.toContain('�');
  });
});

describe('nodeExec stdin handling (L2)', () => {
  it('always ends stdin so a stdin-waiting child cannot hang', async () => {
    // The child exits only once it sees stdin EOF. If stdin were left open it would
    // hang until the timeout; ending it always → a clean exit code 0.
    const script = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";
    const res = await nodeExec({ cmd: process.execPath, args: ['-e', script], timeoutMs: 5000 });
    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(0);
  });

  it('does not crash the parent when writing stdin to a child that exits without reading', async () => {
    // A large write to a child that has already exited yields EPIPE on stdin; the
    // 'error' handler swallows it and the run still resolves via the close path.
    const res = await nodeExec({
      cmd: process.execPath,
      args: ['-e', 'process.exit(0)'],
      stdin: 'x'.repeat(200000),
      timeoutMs: 5000,
    });
    expect(res.timedOut).toBe(false);
    expect(typeof res.exitCode).toBe('number');
  });
});

describe('nodeExec timeout with pipe-inheriting grandchild (L3)', () => {
  it('settles timedOut promptly when the killed child left a grandchild holding the pipes', async () => {
    // The child spawns a grandchild that inherits stdout/stderr and both sleep 30s.
    // A group-signalling kill reaps the grandchild too, and destroying the pipes on
    // 'exit' lets 'close' fire immediately. If the kill only reaped the direct child
    // and 'close' waited for pipe drain, this would stall ~30s.
    const script =
      "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'}); setTimeout(()=>{},30000);";
    const start = Date.now();
    const res = await nodeExec({
      cmd: process.execPath,
      args: ['-e', script],
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;
    expect(res.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });
});
