/**
 * exec — the process seam every agent-mesh adapter drives its vendor CLI through.
 *
 * Duplicated by design across adapters (there is no shared runtime module): a tiny,
 * dependency-free wrapper over `child_process.spawn` with `shell:false`, so a prompt or a
 * flag value never touches a command line and has no interpolation surface. Two shapes:
 * {@link nodeExec} collects a whole run into one buffer, {@link nodeLineStream} yields the
 * child's stdout line by line for streaming consumers.
 *
 * Zero runtime dependencies: Node built-ins only (`child_process`, `readline`).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/**
 * One process invocation. When `env` is provided it IS the child env — it is NOT merged over
 * `process.env`; keys whose value is `undefined` are dropped. When `env` is omitted the child
 * inherits the parent env (spawn's default). The adapter composes the fully-resolved env.
 */
export interface ExecRequest {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  stdin?: string;
}

/** The settled outcome of a run. `exitCode` is null on a signal kill; `timedOut` flags the wall-clock cap. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * End-of-stream metadata a {@link LineStreamFn} reports once, after its last line, so a
 * streaming consumer can distinguish a timeout from a plain non-zero exit and surface the
 * child's stderr — none of which is visible from the line stream alone.
 */
export interface StreamEndMeta {
  /** The wall-clock cap tripped and the child was signal-killed. */
  timedOut: boolean;
  /** Process exit code, or `null` on a signal kill / failed spawn. */
  exitCode: number | null;
  /** The last ≤4 KiB of the child's stderr, UTF-8 decoded. */
  stderrTail: string;
}

/** Run-to-completion seam: resolves an {@link ExecResult}; MAY reject on a spawn-level failure (ENOENT). */
export type ExecFn = (req: ExecRequest) => Promise<ExecResult>;

/**
 * Streaming seam: yields the child's stdout one line at a time. Throws on a spawn-level failure.
 * An optional `onEnd` callback receives {@link StreamEndMeta} exactly once, after the final line,
 * so the caller can tell a timeout from a failing exit and read the stderr tail.
 */
export type LineStreamFn = (
  req: ExecRequest,
  onEnd?: (meta: StreamEndMeta) => void,
) => AsyncIterable<string>;

/** SIGTERM → (grace) SIGKILL window once a run trips its timeout. */
const KILL_GRACE_MS = 5_000;

/** Cap on the stderr tail carried in {@link StreamEndMeta}, so a chatty child can't balloon memory. */
const STDERR_TAIL_CAP = 4_096;

/**
 * Signal the child's WHOLE process group, not just the direct child.
 *
 * The spawned CLI spawns its own helpers that inherit our stdout/stderr pipe FDs.
 * Killing only the direct child leaves those grandchildren holding the pipes open,
 * so the child's `'close'` event — which waits for all stdio to drain — does not
 * fire until a grandchild exits on its own (observed: ~30s). Because the child is
 * spawned `detached:true` (POSIX process group; macOS/Linux only), `-child.pid`
 * addresses the whole group, reaping the grandchildren too. Falls back to a direct
 * `child.kill` when the group send fails (pid gone) or the pid is unknown.
 */
function killProcessGroup(
  child: { pid?: number; kill(signal: NodeJS.Signals): boolean },
  signal: NodeJS.Signals,
): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // group already gone (or not permitted) — fall through to a direct kill
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/**
 * Build the child env from what the caller hands us. When `env` is provided it IS the base — we
 * do NOT merge over `process.env`. The adapter composes the fully-resolved env
 * (`{...this.env, CLAUDE_CONFIG_DIR}`) and passes it here, so a hermetic caller (e.g. `env: {}`)
 * stays isolated from the ambient environment and introspection cannot resolve a different account
 * than execution. Keys with an `undefined` value are dropped. When `env` is omitted, the child
 * inherits the parent process env (spawn's default).
 */
function buildEnv(env?: Record<string, string | undefined>): NodeJS.ProcessEnv | undefined {
  if (!env) return undefined;
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Run a child to completion, collecting stdout and stderr into separate buffers. Resolves the
 * {@link ExecResult}; a synchronous spawn throw or an async 'error' (e.g. ENOENT) REJECTS —
 * the adapter converts that into an AdapterExecError. On timeout the child is SIGTERMed, then
 * SIGKILLed after {@link KILL_GRACE_MS}, and the result resolves with `timedOut:true`.
 */
export const nodeExec: ExecFn = (req) =>
  new Promise<ExecResult>((resolve, reject) => {
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(req.cmd, req.args, {
        cwd: req.cwd,
        env: buildEnv(req.env),
        shell: false,
        // Own process group so a timeout kill can reap the whole tree (see killProcessGroup).
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
    } catch (e) {
      reject(e as Error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
    };

    // Ignore EPIPE on stdin when the child dies before we finish writing.
    child.stdin.on('error', () => {
      /* settle path owns the outcome */
    });
    // Streaming-safe UTF-8 decoding: a multi-byte char split across pipe chunks is
    // held over the boundary instead of each half decoding to U+FFFD (M1).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });

    child.on('error', (e) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      reject(e);
    });
    // Belt-and-braces: once a timeout has tripped, drop our read ends as soon as the direct
    // child exits so `'close'` fires promptly even if some inherited FD outlives the group kill.
    child.on('exit', () => {
      if (timedOut) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });

    if (req.timeoutMs !== undefined && req.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        // Signal the whole group, not just the direct child, so inherited-pipe grandchildren die too.
        killProcessGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => {
          killProcessGroup(child, 'SIGKILL');
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      }, req.timeoutMs);
      timeoutTimer.unref?.();
    }

    try {
      if (req.stdin !== undefined) {
        child.stdin.write(req.stdin);
      }
      child.stdin.end();
    } catch {
      // stdin unwritable — the child's exit settles the outcome
    }
  });

/**
 * Spawn a child and yield its stdout line by line. The child's stderr is captured (its last
 * ≤4 KiB, so it can never fill its pipe and wedge), timers enforce the wall-clock cap, and a
 * spawn 'error' is routed into the stdout stream so the `for await` throws — letting a streaming
 * caller emit a single error event. The child is force-killed when iteration ends for any reason.
 *
 * `onEnd`, if given, is invoked exactly once after the last line with {@link StreamEndMeta}
 * (timeout flag, exit code, stderr tail) so the consumer can distinguish a timeout from a
 * non-zero exit and never silently drop the child's stderr (M2).
 */
export async function* nodeLineStream(
  req: ExecRequest,
  onEnd?: (meta: StreamEndMeta) => void,
): AsyncGenerator<string> {
  const child = spawn(req.cmd, req.args, {
    cwd: req.cwd,
    env: buildEnv(req.env),
    shell: false,
    // Own process group so a timeout kill can reap the whole tree (see killProcessGroup).
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  child.stdin.on('error', () => {
    /* EPIPE if the child died first */
  });

  let timedOut = false;
  let exitCode: number | null = null;
  let stderrTail = '';
  let settled = false;
  // One settle path for both a normal exit and a failed spawn ('error' fires with no 'exit'),
  // so the finally never awaits an exit that will not come.
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((res) => {
    resolveExit = res;
  });
  const settle = (code: number | null): void => {
    if (settled) {
      return;
    }
    settled = true;
    exitCode = code;
    resolveExit();
  };

  // Streaming-safe UTF-8 decoding (M1); keep only the last STDERR_TAIL_CAP bytes of stderr,
  // which both drains the pipe (a chatty child cannot wedge) and preserves a diagnostic tail.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    stderrTail = (stderrTail + d).slice(-STDERR_TAIL_CAP);
  });
  child.stdout.setEncoding('utf8');

  child.on('exit', (code) => {
    // Belt-and-braces on a timeout: drop our read ends so readline's stream ends promptly even
    // if an inherited FD outlives the group kill (else the for-await would hang on a survivor).
    if (timedOut) {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    settle(code);
  });
  // Surface a spawn failure (ENOENT) as a stdout stream error → the for-await below throws.
  child.on('error', (e) => {
    settle(null);
    child.stdout.destroy(e);
  });

  let timeoutTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  if (req.timeoutMs !== undefined && req.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      // Signal the whole group, not just the direct child, so inherited-pipe grandchildren die too.
      killProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        killProcessGroup(child, 'SIGKILL');
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }, req.timeoutMs);
    timeoutTimer.unref?.();
  }

  try {
    if (req.stdin !== undefined) {
      child.stdin?.write(req.stdin);
    }
    child.stdin?.end();
  } catch {
    // stdin unwritable — iteration below ends when the child exits
  }

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    if (killTimer) {
      clearTimeout(killTimer);
    }
    rl.close();
    if (!settled) {
      // Reap the whole group, not just the direct child, so an early break/return that ends
      // iteration cannot orphan inherited-pipe grandchildren.
      killProcessGroup(child, 'SIGKILL');
      await exited; // SIGKILL guarantees an 'exit' → settle resolves this
    }
    onEnd?.({ timedOut, exitCode, stderrTail });
  }
}
