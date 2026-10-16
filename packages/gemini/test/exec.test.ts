import { describe, it, expect } from 'vitest';
import { nodeExec, nodeLineStream } from '../src/exec.js';
import { collect } from './helpers.js';

// These drive the REAL nodeExec / nodeLineStream against a real `node` child (hermetic:
// no agy CLI, no network). They pin the two optional seam fields the usage read added.

/**
 * A child that prints what its stdin is: `char` (the null device), `pipe`, or something else.
 * Node's 'pipe' stdio is a FIFO on Linux but a Unix-domain socket pair on macOS — both are a pipe.
 */
const STDIN_KIND =
  "const st = require('fs').fstatSync(0); process.stdout.write(st.isFIFO() || st.isSocket() ? 'pipe' : st.isCharacterDevice() ? 'char' : 'other');";

describe.skipIf(process.platform === 'win32')('nodeExec ignoreStdin', () => {
  it('stdin is a pipe by default, and the null device with ignoreStdin', async () => {
    const piped = await nodeExec({ cmd: process.execPath, args: ['-e', STDIN_KIND], timeoutMs: 10_000 });
    expect(piped.stdout).toBe('pipe');
    const ignored = await nodeExec({ cmd: process.execPath, args: ['-e', STDIN_KIND], timeoutMs: 10_000, ignoreStdin: true });
    expect(ignored.stdout).toBe('char');
    expect(ignored.exitCode).toBe(0);
  });

  it('ignoreStdin wins over a stdin string (nothing is written)', async () => {
    const res = await nodeExec({
      cmd: process.execPath,
      args: ['-e', "process.stdout.write(require('fs').readFileSync(0, 'utf8') || 'EMPTY')"],
      stdin: 'should not arrive',
      ignoreStdin: true,
      timeoutMs: 10_000,
    });
    expect(res.stdout).toBe('EMPTY');
  });

  it('nodeLineStream honours it too', async () => {
    const lines = await collect(
      nodeLineStream({ cmd: process.execPath, args: ['-e', STDIN_KIND + "process.stdout.write('\\n')"], ignoreStdin: true, timeoutMs: 10_000 }),
    );
    expect(lines).toEqual(['char']);
  });
});

describe('nodeExec maxStdoutBytes', () => {
  it('under the cap: the whole stdout, and no stdoutOverflow key', async () => {
    const res = await nodeExec({
      cmd: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(1000))"],
      maxStdoutBytes: 1000,
      timeoutMs: 10_000,
    });
    expect(res.stdout).toHaveLength(1000);
    expect(res).not.toHaveProperty('stdoutOverflow');
    expect(res.exitCode).toBe(0);
  });

  it('past the cap: stdoutOverflow, at most the cap kept, and the child stopped long before its timeout', async () => {
    const start = Date.now();
    const res = await nodeExec({
      cmd: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(4 * 1048576)); setInterval(() => {}, 1000);"],
      maxStdoutBytes: 1_048_576,
      timeoutMs: 30_000,
    });
    expect(res.stdoutOverflow).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(Buffer.byteLength(res.stdout, 'utf8')).toBeLessThanOrEqual(1_048_576);
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});
