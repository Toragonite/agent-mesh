/**
 * exec — the process seam every agent-mesh adapter drives its vendor CLI through.
 *
 * Duplicated by design across adapters (there is no shared runtime module): a tiny,
 * dependency-free wrapper over `child_process.spawn` with `shell:false`, so a prompt or a
 * flag value never touches a command line and has no interpolation surface. Two shapes:
 * {@link nodeExec} collects a whole run into one buffer, {@link nodeLineStream} yields the
 * child's stdout line by line for streaming consumers. The Antigravity copy also honours
 * `ignoreStdin` (both shapes) and `maxStdoutBytes` (nodeExec), which the usage read needs.
 *
 * Since 0.1.3 a request may carry `onSpawn`, which receives a {@link SpawnedProcess} handle for
 * the started child (its pid, a leader-only signal, a whole-group signal, its exit, and the time
 * of its last output); {@link interruptLadder} stops a child through that handle the way every
 * vendor CLI here stops cleanly; {@link execOverLineStream} runs a child to completion through
 * any {@link LineStreamFn}.
 *
 * Zero runtime dependencies: Node built-ins only (`child_process`, `readline`).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/**
 * A started child, as {@link ExecRequest.onSpawn} reports it. The seams start every child
 * `detached`, alone in its own process group, so its pid is also its process-group id.
 */
export interface SpawnedProcess {
  /** The child's pid — also its process-group id. */
  readonly pid: number;
  /** Resolves with the exit code (`null` after a signal death) once the child has exited. Never rejects. */
  readonly exited: Promise<number | null>;
  /**
   * Signal the child ONLY, never its group. Interrupt a run with `signal('SIGINT')` here: a CLI
   * may ignore a SIGINT sent to its whole group and finish the turn (Codex does). `false` once the
   * child has exited (its pid may already belong to another process) or when the send fails.
   */
  signal(sig: string): boolean;
  /**
   * Signal the child's whole process group — the escalation after an interrupt (SIGTERM, then
   * SIGKILL). `false` once the seam is done with the child (its stdio closed) or when the send fails.
   */
  signalGroup(sig: string): boolean;
  /** True once the child has exited. */
  hasExited(): boolean;
  /** Epoch ms of the child's last stdout/stderr output — its spawn time until the first. */
  lastOutputAt(): number;
}

/**
 * One process invocation. When `env` is provided it IS the child env — it is NOT merged over
 * `process.env`; keys whose value is `undefined` are dropped. When `env` is omitted the child
 * inherits the parent env (spawn's default). The adapter composes the fully-resolved env.
 *
 * `ignoreStdin` and `maxStdoutBytes` are optional and additive: a host's own {@link ExecFn}
 * that does not know them still works (stdin is then a pipe ended at once, and stdout is not
 * capped while the child runs) — the adapter re-checks the stdout size itself.
 */
export interface ExecRequest {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  stdin?: string;
  /**
   * When true the child's stdin is the null device (spawn's `'ignore'`) instead of a pipe,
   * and `stdin` is not written. A CLI can tell a pipe from `/dev/null` — a common "is stdin
   * piped?" test reads a pipe as input, while `/dev/null` is a character device — so a call
   * that was verified against `/dev/null` must not be handed a pipe.
   */
  ignoreStdin?: boolean;
  /**
   * {@link nodeExec} only: keep at most this many bytes of stdout. The chunk that would cross
   * the cap is dropped, the child's process group is killed (as on a timeout), and the result
   * carries `stdoutOverflow: true` — so a runaway child cannot grow the parent's memory.
   */
  maxStdoutBytes?: number;
  /**
   * Since 0.1.3: called once, synchronously, right after the child started, with its
   * {@link SpawnedProcess} handle. Never called for a spawn that failed; a throw from it is
   * ignored. A host's own seam that does not know this field simply never calls it.
   */
  onSpawn?: (proc: SpawnedProcess) => void;
}

/**
 * The settled outcome of a run. `exitCode` is null on a signal kill; `timedOut` flags the
 * wall-clock cap; `stdoutOverflow` is present (true) only when `maxStdoutBytes` tripped.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutOverflow?: boolean;
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

/** The stages of {@link interruptLadder}, in milliseconds. */
export interface InterruptLadderStages {
  /** After the SIGINT, how long the child gets to exit before its group gets SIGTERM. Default 10000. */
  termAfterMs?: number;
  /** After the SIGTERM, how long before the group gets SIGKILL. Default 5000. */
  killAfterMs?: number;
}

/** SIGTERM → (grace) SIGKILL window once a run trips its timeout. */
const KILL_GRACE_MS = 5_000;

/** Cap on the stderr tail carried in {@link StreamEndMeta}, so a chatty child can't balloon memory. */
const STDERR_TAIL_CAP = 4_096;

/** {@link interruptLadder}'s default stages: SIGINT → 10 s → SIGTERM (group) → 5 s → SIGKILL (group). */
const DEFAULT_TERM_AFTER_MS = 10_000;
const DEFAULT_KILL_AFTER_MS = 5_000;

/** The largest delay a Node timer honours; a longer one fires after 1 ms instead. */
const MAX_TIMER_MS = 2_147_483_647;

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

/** A non-negative finite byte cap, or undefined when the request sets none (or a meaningless one). */
function stdoutCap(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined;
}

/** What a {@link SpawnedProcess} handle reads from the seam that started the child. */
interface HandleState {
  /** The child's `'exit'` fired: its pid may be reused from here on. */
  exited: boolean;
  /** The seam is done with the child (its stdio closed): no group signal after this. */
  settled: boolean;
  /** Epoch ms of the last stdout/stderr chunk. */
  lastOutputAt: number;
}

/**
 * Hand a started child to `req.onSpawn`, if the request has one. Never throws: a child with no
 * pid (the spawn failed) is not reported, and a throwing callback is ignored.
 */
function reportSpawn(
  req: ExecRequest,
  child: { pid?: number; kill(signal: NodeJS.Signals): boolean },
  state: HandleState,
  exited: Promise<number | null>,
): void {
  const onSpawn = req.onSpawn;
  const pid = child.pid;
  if (typeof onSpawn !== 'function' || pid === undefined) {
    return;
  }
  const handle: SpawnedProcess = {
    pid,
    exited,
    signal: (sig) => {
      if (state.exited) {
        return false;
      }
      try {
        return child.kill(sig as NodeJS.Signals);
      } catch {
        return false; // an unknown signal name, or the child is gone
      }
    },
    signalGroup: (sig) => {
      if (state.settled) {
        return false;
      }
      try {
        process.kill(-pid, sig as NodeJS.Signals);
        return true;
      } catch {
        return false; // the group is gone (or not permitted), or an unknown signal name
      }
    },
    hasExited: () => state.exited,
    lastOutputAt: () => state.lastOutputAt,
  };
  try {
    onSpawn(handle);
  } catch {
    // a caller's hook never breaks the seam
  }
}

/** A non-negative finite stage length, capped to what a Node timer honours, else the default. */
function stageMs(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(x, MAX_TIMER_MS) : fallback;
}

/**
 * Stop a child the way every vendor CLI here stops cleanly: SIGINT to the child ONLY; if it has
 * not exited after `termAfterMs`, SIGTERM to its whole process group; if it still has not exited
 * after `killAfterMs` more, SIGKILL to the group. The group is never sent SIGINT — a CLI may
 * ignore a group SIGINT and finish its turn. The ladder ends as soon as the child exits; the
 * returned function cancels whatever stage is still pending.
 */
export function interruptLadder(proc: SpawnedProcess, stages: InterruptLadderStages = {}): () => void {
  const termAfterMs = stageMs(stages.termAfterMs, DEFAULT_TERM_AFTER_MS);
  const killAfterMs = stageMs(stages.killAfterMs, DEFAULT_KILL_AFTER_MS);
  let timer: NodeJS.Timeout | undefined;
  let finished = false;
  const stop = (): void => {
    finished = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  if (proc.hasExited()) {
    stop();
    return stop;
  }
  proc.exited.then(stop, stop);
  proc.signal('SIGINT');
  timer = setTimeout(() => {
    if (finished || proc.hasExited()) {
      stop();
      return;
    }
    proc.signalGroup('SIGTERM');
    timer = setTimeout(() => {
      if (!finished && !proc.hasExited()) {
        proc.signalGroup('SIGKILL');
      }
      stop();
    }, killAfterMs);
  }, termAfterMs);
  return stop;
}

/**
 * Run a child to completion THROUGH a {@link LineStreamFn}: its stdout lines are joined with
 * `\n`, and the end metadata gives `exitCode`, `timedOut` and `stderr` (the seam's stderr tail).
 * This is how a run-to-completion call honours a caller's own line seam. Rejects exactly when
 * the seam throws (a spawn failure), as an {@link ExecFn} may. A seam that never reports its end
 * yields `exitCode: null`.
 */
export async function execOverLineStream(lineStream: LineStreamFn, req: ExecRequest): Promise<ExecResult> {
  const lines: string[] = [];
  let endMeta: StreamEndMeta | undefined;
  for await (const line of lineStream(req, (meta) => {
    endMeta = meta;
  })) {
    lines.push(line);
  }
  return {
    stdout: lines.join('\n'),
    stderr: endMeta?.stderrTail ?? '',
    exitCode: endMeta ? endMeta.exitCode : null,
    timedOut: endMeta?.timedOut ?? false,
  };
}

/**
 * Run a child to completion, collecting stdout and stderr into separate buffers. Resolves the
 * {@link ExecResult}; a synchronous spawn throw or an async 'error' (e.g. ENOENT) REJECTS —
 * the adapter converts that into an AdapterExecError. On timeout the child is SIGTERMed, then
 * SIGKILLed after {@link KILL_GRACE_MS}, and the result resolves with `timedOut:true`. Past
 * `maxStdoutBytes` the child is stopped the same way and the result has `stdoutOverflow:true`.
 */
export const nodeExec: ExecFn = (req) =>
  new Promise<ExecResult>((resolve, reject) => {
    let child: ChildProcessByStdio<Writable | null, Readable, Readable>;
    try {
      child = spawn(req.cmd, req.args, {
        cwd: req.cwd,
        env: buildEnv(req.env),
        shell: false,
        // Own process group so a timeout kill can reap the whole tree (see killProcessGroup).
        detached: true,
        stdio: [req.ignoreStdin === true ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    } catch (e) {
      reject(e as Error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stdoutOverflow = false;
    let stopping = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const maxStdout = stdoutCap(req.maxStdoutBytes);
    let stdoutBytes = 0;
    const handleState: HandleState = { exited: false, settled: false, lastOutputAt: Date.now() };
    let resolveLeaderExit: (code: number | null) => void = () => {};
    const leaderExit = new Promise<number | null>((res) => {
      resolveLeaderExit = res;
    });

    const clearTimers = (): void => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
    };

    /** SIGTERM the whole group, SIGKILL it after the grace — once, whichever cap tripped first. */
    const stop = (): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      // Signal the whole group, not just the direct child, so inherited-pipe grandchildren die too.
      killProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        killProcessGroup(child, 'SIGKILL');
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    // Ignore EPIPE on stdin when the child dies before we finish writing.
    child.stdin?.on('error', () => {
      /* settle path owns the outcome */
    });
    // Streaming-safe UTF-8 decoding: a multi-byte char split across pipe chunks is
    // held over the boundary instead of each half decoding to U+FFFD (M1).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      handleState.lastOutputAt = Date.now();
      if (stdoutOverflow) {
        return; // past the cap: drop the rest while the group is being stopped
      }
      if (maxStdout !== undefined) {
        const n = Buffer.byteLength(d, 'utf8');
        if (stdoutBytes + n > maxStdout) {
          stdoutOverflow = true;
          stop();
          return;
        }
        stdoutBytes += n;
      }
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      handleState.lastOutputAt = Date.now();
      stderr += d;
    });

    child.on('error', (e) => {
      if (settled) {
        return;
      }
      settled = true;
      handleState.settled = true;
      clearTimers();
      reject(e);
    });
    // Belt-and-braces: once the child is being stopped (a timeout or the stdout cap), drop our
    // read ends as soon as the direct child exits so `'close'` fires promptly even if some
    // inherited FD outlives the group kill.
    child.on('exit', (code) => {
      handleState.exited = true;
      resolveLeaderExit(code);
      if (stopping) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    });
    child.on('close', (code) => {
      handleState.settled = true;
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolve({ stdout, stderr, exitCode: code, timedOut, ...(stdoutOverflow ? { stdoutOverflow: true } : {}) });
    });

    reportSpawn(req, child, handleState, leaderExit);

    if (req.timeoutMs !== undefined && req.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stop();
      }, req.timeoutMs);
      timeoutTimer.unref?.();
    }

    try {
      // With `ignoreStdin` there is no pipe: the child already reads the null device.
      if (child.stdin) {
        if (req.stdin !== undefined) {
          child.stdin.write(req.stdin);
        }
        child.stdin.end();
      }
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
    stdio: [req.ignoreStdin === true ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<Writable | null, Readable, Readable>;

  child.stdin?.on('error', () => {
    /* EPIPE if the child died first */
  });

  let timedOut = false;
  let exitCode: number | null = null;
  let stderrTail = '';
  let settled = false;
  const handleState: HandleState = { exited: false, settled: false, lastOutputAt: Date.now() };
  let resolveLeaderExit: (code: number | null) => void = () => {};
  const leaderExit = new Promise<number | null>((res) => {
    resolveLeaderExit = res;
  });
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
    handleState.lastOutputAt = Date.now();
    stderrTail = (stderrTail + d).slice(-STDERR_TAIL_CAP);
  });
  child.stdout.setEncoding('utf8');

  child.on('exit', (code) => {
    handleState.exited = true;
    resolveLeaderExit(code);
    // Belt-and-braces on a timeout: drop our read ends so readline's stream ends promptly even
    // if an inherited FD outlives the group kill (else the for-await would hang on a survivor).
    if (timedOut) {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    settle(code);
  });
  child.on('close', () => {
    handleState.settled = true;
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
  // A second 'data' listener only records WHEN output arrived; readline still reads every chunk.
  child.stdout.on('data', () => {
    handleState.lastOutputAt = Date.now();
  });
  reportSpawn(req, child, handleState, leaderExit);
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
    handleState.settled = true;
    onEnd?.({ timedOut, exitCode, stderrTail });
  }
}
