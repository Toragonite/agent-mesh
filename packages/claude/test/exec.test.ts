import { describe, it, expect } from 'vitest';
import { nodeExec } from '../src/exec';

/* ------------------------------------------------------------------------- *
 * nodeExec — timeout reaping across a process tree
 *
 * Hermetic-real: spawns only node/node grandchildren — no vendor CLI, no network.
 * ------------------------------------------------------------------------- */

describe('nodeExec timeout reaping', () => {
  it('settles timedOut:true promptly even when the child spawned a pipe-inheriting grandchild', async () => {
    // The child spawns a grandchild that INHERITS its stdout/stderr pipes and then both sleep
    // for 30s. If nodeExec killed only the direct child, the grandchild would keep the pipes
    // open and the child's 'close' event (which waits for stdio to drain) would not fire for
    // ~30s. Killing the whole process group reaps the grandchild too, so 'close' fires at once.
    const grandchildKeepsPipesOpen =
      "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});" +
      'setTimeout(()=>{},30000)';

    const start = Date.now();
    const res = await nodeExec({
      cmd: process.execPath,
      args: ['-e', grandchildKeepsPipesOpen],
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;

    expect(res.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);
});
