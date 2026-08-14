import { describe, it, expect } from 'vitest';
import { nodeExec } from '../src/exec';
import type { ExecFn, ExecRequest, ExecResult } from '../src/exec';
import { ClaudeAdapter } from '../src/adapter';

/* ------------------------------------------------------------------------- *
 * Child-env isolation — the exported seam treats `req.env`, when provided, as
 * the COMPLETE child env (no merge over `process.env`), matching the codex
 * package's `buildEnv` rule. These fail against the old `mergedEnv` behavior.
 * ------------------------------------------------------------------------- */

/** An exec seam that records every request and returns a fixed (overridable) result. */
function recorder(result: Partial<ExecResult> = {}): { calls: ExecRequest[]; exec: ExecFn } {
  const calls: ExecRequest[] = [];
  const exec: ExecFn = async (req) => {
    calls.push(req);
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...result };
  };
  return { calls, exec };
}

describe('nodeExec child-env isolation (real spawn)', () => {
  it('provided env IS the child env: it carries FOO and the ambient probe is ABSENT', async () => {
    // Set an ambient var on the PARENT's process.env. Under the old `mergedEnv` rule the child
    // inherited it (env merged over process.env); under the new rule a provided env is the whole
    // child env, so it must not appear. PATH is likewise absent since it was not provided.
    process.env.__AGENT_MESH_PROBE = 'leaked';
    try {
      const script =
        "process.stdout.write(JSON.stringify({" +
        " FOO: process.env.FOO ?? 'ABSENT'," +
        " PATH: process.env.PATH ?? 'ABSENT'," +
        " PROBE: process.env.__AGENT_MESH_PROBE ?? 'ABSENT' }))";
      const res = await nodeExec({
        cmd: process.execPath,
        args: ['-e', script],
        env: { FOO: 'bar' },
        timeoutMs: 10_000,
      });
      expect(res.timedOut).toBe(false);
      const out = JSON.parse(res.stdout) as Record<string, string>;
      expect(out.FOO).toBe('bar');
      expect(out.PROBE).toBe('ABSENT');
      expect(out.PATH).toBe('ABSENT');
    } finally {
      delete process.env.__AGENT_MESH_PROBE;
    }
  }, 15_000);

  it('omitted env still inherits the parent env: the ambient probe IS visible', async () => {
    process.env.__AGENT_MESH_PROBE = 'inherited';
    try {
      const script = "process.stdout.write(process.env.__AGENT_MESH_PROBE ?? 'ABSENT')";
      const res = await nodeExec({
        cmd: process.execPath,
        args: ['-e', script],
        timeoutMs: 10_000,
      });
      expect(res.timedOut).toBe(false);
      expect(res.stdout).toBe('inherited');
    } finally {
      delete process.env.__AGENT_MESH_PROBE;
    }
  }, 15_000);
});

describe('ClaudeAdapter composes the fully-resolved child env', () => {
  it('bases the child env on the injected seam and overlays a resolved configDir', async () => {
    const { exec, calls } = recorder();
    const adapter = new ClaudeAdapter({ env: { HOME: '/tmp/x' }, exec });
    await adapter.run({ prompt: 'hi', account: { vendor: 'claude', configDir: '/cfg/acct' } });
    const env = calls[0]!.env!;
    // The base is exactly the injected seam (HOME), plus CLAUDE_CONFIG_DIR from the account.
    expect(env.HOME).toBe('/tmp/x');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/cfg/acct');
    // No arbitrary ambient key leaks in — the base is the seam, not the real process.env.
    expect(Object.keys(env).sort()).toEqual(['CLAUDE_CONFIG_DIR', 'HOME']);
    expect('PATH' in env).toBe(false);
  });

  it('carries no CLAUDE_CONFIG_DIR key for a fully ambient login', async () => {
    const { exec, calls } = recorder();
    // No account, no defaultAccount, no CLAUDE_CONFIG_DIR in the seam → fully ambient.
    const adapter = new ClaudeAdapter({ env: { HOME: '/tmp/x' }, exec });
    await adapter.run({ prompt: 'hi' });
    const env = calls[0]!.env!;
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
    expect(env).toEqual({ HOME: '/tmp/x' });
  });
});
