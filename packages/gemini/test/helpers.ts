import type {
  ExecFn,
  ExecRequest,
  ExecResult,
  LineStreamFn,
  StreamEndMeta,
} from '../src/exec.js';

/** A fake ExecFn that records requests and returns a preset result. */
export function recordingExec(result: Partial<ExecResult> = {}): {
  exec: ExecFn;
  calls: ExecRequest[];
} {
  const calls: ExecRequest[] = [];
  const exec: ExecFn = async (req) => {
    calls.push(req);
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...result };
  };
  return { exec, calls };
}

/** A fake ExecFn that rejects — models a spawn-level failure like ENOENT. */
export function throwingExec(err: Error): ExecFn {
  return async () => {
    throw err;
  };
}

/**
 * A fake ExecFn whose result is chosen per call from the prompt (the last argv
 * element). Lets two concurrent run() calls resolve independently.
 */
export function execByPrompt(map: Record<string, Partial<ExecResult>>): {
  exec: ExecFn;
  calls: ExecRequest[];
} {
  const calls: ExecRequest[] = [];
  const exec: ExecFn = async (req) => {
    calls.push(req);
    const prompt = req.args[req.args.length - 1] ?? '';
    const preset = map[prompt] ?? {};
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...preset };
  };
  return { exec, calls };
}

/**
 * A fake LineStreamFn that yields the given lines then reports end metadata via
 * `onEnd`. Defaults to a clean exit (code 0, no timeout).
 */
export function recordingLineStream(
  lines: string[],
  meta: Partial<StreamEndMeta> = {},
): { lineStream: LineStreamFn; calls: ExecRequest[] } {
  const calls: ExecRequest[] = [];
  const lineStream: LineStreamFn = (req, onEnd) => {
    calls.push(req);
    return (async function* () {
      for (const line of lines) yield line;
      onEnd?.({ timedOut: false, exitCode: 0, stderrTail: '', ...meta });
    })();
  };
  return { lineStream, calls };
}

/** Join JSON objects into a JSONL stdout string (one object per line). */
export function jsonl(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

/** Last element of an argv array (typed, non-undefined for non-empty arrays). */
export function last<T>(xs: T[]): T {
  return xs[xs.length - 1] as T;
}

/** Drain an async iterable of RunEvents into an array. */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
