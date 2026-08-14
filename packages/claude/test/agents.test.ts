import { describe, it, expect } from 'vitest';
import { runProcess } from '../src/agents';

/* ------------------------------------------------------------------------- *
 * runProcess — the real child-process handler behind spawnAgent/listAgents/etc.
 *
 * Hermetic-real: spawns only node/node grandchildren — no vendor CLI, no network.
 * ------------------------------------------------------------------------- */

describe('runProcess UTF-8 across chunk boundaries (A1)', () => {
  it('holds a multi-byte character split across pipe chunks instead of decoding two U+FFFD', async () => {
    // The child writes ONE byte of the first CJK glyph, then (after a delay, so it lands in a
    // SEPARATE 'data' event) the rest. Per-chunk `Buffer.toString('utf8')` would decode the split
    // byte as U+FFFD on each half; the StringDecoder that setEncoding installs holds it over.
    const script =
      "const b=Buffer.from('한국어 답변 ✅','utf8');" +
      'process.stdout.write(b.subarray(0,1));' +
      'setTimeout(()=>process.stdout.write(b.subarray(1)),60);';
    const out = await runProcess(process.execPath, ['-e', script], process.cwd(), process.env, 10_000);
    expect(out.timedOut).toBe(false);
    expect(out.code).toBe(0);
    expect(out.output).toBe('한국어 답변 ✅');
  }, 15_000);
});

describe('runProcess timeout reaping across a process tree (A2)', () => {
  it('settles timedOut:true promptly even when the child spawned a pipe-inheriting grandchild', async () => {
    // The child spawns a grandchild that INHERITS its stdout/stderr pipes and both sleep 30s. If
    // runProcess killed only the direct child, the grandchild would keep the pipes open and the
    // settling 'close' event (which waits for stdio to drain) would not fire for ~30s. Killing the
    // whole process group reaps the grandchild too, so the call settles at the timeout.
    const grandchildKeepsPipesOpen =
      "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});" +
      'setTimeout(()=>{},30000)';

    const start = Date.now();
    const res = await runProcess(
      process.execPath,
      ['-e', grandchildKeepsPipesOpen],
      process.cwd(),
      process.env,
      300,
    );
    const elapsed = Date.now() - start;

    expect(res.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);
});
