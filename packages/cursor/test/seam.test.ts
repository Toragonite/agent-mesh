import { describe, it, expect, vi } from 'vitest';
import {
  execOverLineStream,
  interruptLadder,
  nodeExec,
  nodeLineStream,
  type LineStreamFn,
  type SpawnedProcess,
  type StreamEndMeta,
} from '../src/exec.js';

/* ------------------------------------------------------------------------- *
 * The process seam's 0.1.3 additions: `onSpawn` (the started child's handle),
 * the leader-only interrupt with group escalation (`interruptLadder`), and
 * `execOverLineStream`. The real-process cases spawn only `node` children —
 * no vendor CLI, no network.
 * ------------------------------------------------------------------------- */

const posix = process.platform !== 'win32';

/** Resolve once `cond()` holds, polling every 10 ms; reject after `ms`. */
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe.skipIf(!posix)('leader SIGINT through onSpawn + interruptLadder (real node children)', () => {
  it('reports the started child and stops it with a SIGINT to the LEADER', async () => {
    const script = [
      "process.on('SIGINT', () => process.stdout.write('interrupted\\n', () => process.exit(130)));",
      "process.stdout.write('ready\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    let proc: SpawnedProcess | undefined;
    let end: StreamEndMeta | undefined;
    const seen: string[] = [];
    const start = Date.now();
    for await (const line of nodeLineStream(
      {
        cmd: process.execPath,
        args: ['-e', script],
        timeoutMs: 20_000,
        onSpawn: (p) => {
          proc = p;
        },
      },
      (meta) => {
        end = meta;
      },
    )) {
      seen.push(line);
      if (line === 'ready') interruptLadder(proc!, { termAfterMs: 5_000, killAfterMs: 2_000 });
    }
    expect(proc!.pid).toBeGreaterThan(0);
    expect(seen).toEqual(['ready', 'interrupted']);
    expect(end?.exitCode).toBe(130);
    expect(Date.now() - start).toBeLessThan(5_000); // the SIGINT did it, not the SIGTERM stage
    expect(proc!.hasExited()).toBe(true);
    await expect(proc!.exited).resolves.toBe(130);
    // Its pid may belong to another process by now: the handle refuses to signal it.
    expect(proc!.signal('SIGINT')).toBe(false);
    expect(proc!.signalGroup('SIGTERM')).toBe(false);
  }, 20_000);

  it('never SIGINTs the group: a grandchild sees only the escalation to SIGTERM', async () => {
    const grandchild = [
      "process.on('SIGINT', () => process.stdout.write('grandchild-sigint\\n'));",
      "process.on('SIGTERM', () => process.stdout.write('grandchild-term\\n', () => process.exit(0)));",
      "process.stdout.write('grandchild-ready\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const leader = [
      `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' });`,
      // The leader acknowledges the SIGINT but keeps running, so the ladder must escalate.
      "process.on('SIGINT', () => process.stdout.write('leader-sigint\\n'));",
      "process.stdout.write('leader-ready\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    let proc: SpawnedProcess | undefined;
    const seen: string[] = [];
    let ready = 0;
    for await (const line of nodeLineStream({
      cmd: process.execPath,
      args: ['-e', leader],
      timeoutMs: 30_000,
      onSpawn: (p) => {
        proc = p;
      },
    })) {
      seen.push(line);
      if (line === 'leader-ready' || line === 'grandchild-ready') {
        ready += 1;
        if (ready === 2) interruptLadder(proc!, { termAfterMs: 500, killAfterMs: 3_000 });
      }
    }
    expect(seen).toContain('leader-sigint');
    expect(seen).toContain('grandchild-term');
    expect(seen).not.toContain('grandchild-sigint');
  }, 30_000);

  it('reports when the child last wrote output', async () => {
    const script = "process.stdout.write('a\\n'); setTimeout(() => process.stdout.write('b\\n'), 300);";
    let proc: SpawnedProcess | undefined;
    let spawnedAt = 0;
    const marks: number[] = [];
    for await (const _line of nodeLineStream({
      cmd: process.execPath,
      args: ['-e', script],
      timeoutMs: 20_000,
      onSpawn: (p) => {
        proc = p;
        spawnedAt = p.lastOutputAt();
      },
    })) {
      marks.push(proc!.lastOutputAt());
    }
    expect(marks).toHaveLength(2);
    expect(marks[0]!).toBeGreaterThanOrEqual(spawnedAt);
    expect(marks[1]! - marks[0]!).toBeGreaterThanOrEqual(200);
  }, 20_000);

  it('nodeExec reports the child too, and a leader SIGINT stops it', async () => {
    const script = [
      "process.on('SIGINT', () => process.stdout.write('bye\\n', () => process.exit(130)));",
      "process.stdout.write('ready\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    let proc: SpawnedProcess | undefined;
    let firstOutput = 0;
    const pending = nodeExec({
      cmd: process.execPath,
      args: ['-e', script],
      timeoutMs: 20_000,
      onSpawn: (p) => {
        proc = p;
        firstOutput = p.lastOutputAt();
      },
    });
    await until(() => proc !== undefined && proc.lastOutputAt() > firstOutput);
    expect(proc!.signal('SIGINT')).toBe(true);
    const res = await pending;
    expect(res.exitCode).toBe(130);
    expect(res.stdout).toBe('ready\nbye\n');
    expect(res.timedOut).toBe(false);
  }, 20_000);

  it('a throwing onSpawn never breaks the seam', async () => {
    const res = await nodeExec({
      cmd: process.execPath,
      args: ['-e', "process.stdout.write('ok')"],
      timeoutMs: 20_000,
      onSpawn: () => {
        throw new Error('hook failed');
      },
    });
    expect(res.stdout).toBe('ok');
    expect(res.exitCode).toBe(0);
  }, 20_000);
});

/** A fake handle that records the signals the ladder sends. */
function fakeProc(): { proc: SpawnedProcess; sent: string[]; exit: (code: number | null) => void } {
  const sent: string[] = [];
  let exited = false;
  let resolveExit: (code: number | null) => void = () => {};
  const exitedPromise = new Promise<number | null>((r) => {
    resolveExit = r;
  });
  const proc: SpawnedProcess = {
    pid: 4242,
    exited: exitedPromise,
    signal: (sig) => {
      sent.push(`leader:${sig}`);
      return true;
    },
    signalGroup: (sig) => {
      sent.push(`group:${sig}`);
      return true;
    },
    hasExited: () => exited,
    lastOutputAt: () => 0,
  };
  return {
    proc,
    sent,
    exit: (code) => {
      exited = true;
      resolveExit(code);
    },
  };
}

describe('interruptLadder stages', () => {
  it('SIGINT to the leader, then SIGTERM and SIGKILL to the GROUP on the given stages', () => {
    vi.useFakeTimers();
    try {
      const f = fakeProc();
      interruptLadder(f.proc, { termAfterMs: 100, killAfterMs: 50 });
      expect(f.sent).toEqual(['leader:SIGINT']);
      vi.advanceTimersByTime(99);
      expect(f.sent).toEqual(['leader:SIGINT']);
      vi.advanceTimersByTime(1);
      expect(f.sent).toEqual(['leader:SIGINT', 'group:SIGTERM']);
      vi.advanceTimersByTime(50);
      expect(f.sent).toEqual(['leader:SIGINT', 'group:SIGTERM', 'group:SIGKILL']);
      vi.advanceTimersByTime(10_000);
      expect(f.sent).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults to 10 s before SIGTERM and 5 s more before SIGKILL', () => {
    vi.useFakeTimers();
    try {
      const f = fakeProc();
      interruptLadder(f.proc);
      vi.advanceTimersByTime(9_999);
      expect(f.sent).toEqual(['leader:SIGINT']);
      vi.advanceTimersByTime(1);
      expect(f.sent).toEqual(['leader:SIGINT', 'group:SIGTERM']);
      vi.advanceTimersByTime(4_999);
      expect(f.sent).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(f.sent).toEqual(['leader:SIGINT', 'group:SIGTERM', 'group:SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops escalating once the child exits', () => {
    vi.useFakeTimers();
    try {
      const f = fakeProc();
      interruptLadder(f.proc, { termAfterMs: 100, killAfterMs: 50 });
      f.exit(130);
      vi.advanceTimersByTime(1_000);
      expect(f.sent).toEqual(['leader:SIGINT']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the returned function cancels the pending stages', () => {
    vi.useFakeTimers();
    try {
      const f = fakeProc();
      const cancel = interruptLadder(f.proc, { termAfterMs: 100, killAfterMs: 50 });
      cancel();
      vi.advanceTimersByTime(1_000);
      expect(f.sent).toEqual(['leader:SIGINT']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing to a child that has already exited', () => {
    const f = fakeProc();
    f.exit(0);
    interruptLadder(f.proc);
    expect(f.sent).toEqual([]);
  });
});

describe('execOverLineStream', () => {
  it('joins the lines and maps the end metadata', async () => {
    const seam: LineStreamFn = async function* (_req, onEnd) {
      yield 'a';
      yield 'b';
      onEnd?.({ timedOut: true, exitCode: null, stderrTail: 'tail' });
    };
    await expect(execOverLineStream(seam, { cmd: 'x', args: [] })).resolves.toEqual({
      stdout: 'a\nb',
      stderr: 'tail',
      exitCode: null,
      timedOut: true,
    });
  });

  it('hands the request to the seam unchanged', async () => {
    const seen: unknown[] = [];
    const seam: LineStreamFn = async function* (req, onEnd) {
      seen.push(req);
      onEnd?.({ timedOut: false, exitCode: 0, stderrTail: '' });
    };
    const req = { cmd: 'x', args: ['--y'], cwd: '/w', env: { A: '1' }, timeoutMs: 5 };
    await expect(execOverLineStream(seam, req)).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
    expect(seen).toEqual([req]);
  });

  it('reports exitCode null when the seam never reports its end', async () => {
    const seam: LineStreamFn = async function* () {
      yield 'only';
    };
    await expect(execOverLineStream(seam, { cmd: 'x', args: [] })).resolves.toEqual({
      stdout: 'only',
      stderr: '',
      exitCode: null,
      timedOut: false,
    });
  });

  it('rejects when the seam throws (a spawn failure)', async () => {
    const seam: LineStreamFn = async function* () {
      throw new Error('spawn x ENOENT');
    };
    await expect(execOverLineStream(seam, { cmd: 'x', args: [] })).rejects.toThrow('spawn x ENOENT');
  });
});
