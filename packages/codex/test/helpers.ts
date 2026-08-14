import type { ExecFn, ExecRequest, ExecResult } from '../src/exec.js';
import type { ReadTextFile } from '../src/auth.js';

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

/** A file reader that ignores the path and returns a fixed body (or null). */
export function fixedReader(content: string | null): ReadTextFile {
  return async () => content;
}

/** A fetch fake that records calls and returns a JSON body with a chosen ok flag. */
export function fakeFetch(
  body: unknown,
  ok = true,
): { fn: typeof fetch; calls: Array<{ url: unknown; init: unknown }> } {
  const calls: Array<{ url: unknown; init: unknown }> = [];
  const fn = (async (url: unknown, init: unknown) => {
    calls.push({ url, init });
    return { ok, status: ok ? 200 : 429, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** Join JSONL event objects into a stdout string. */
export function jsonl(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

/** Last element of an argv array (typed, non-undefined for non-empty arrays). */
export function last<T>(xs: T[]): T {
  return xs[xs.length - 1] as T;
}
