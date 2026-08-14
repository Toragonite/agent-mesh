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

/** A fake ExecFn whose result depends on the request (e.g. keyed on the prompt). */
export function scriptedExec(handler: (req: ExecRequest) => Partial<ExecResult>): {
  exec: ExecFn;
  calls: ExecRequest[];
} {
  const calls: ExecRequest[] = [];
  const exec: ExecFn = async (req) => {
    calls.push(req);
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...handler(req) };
  };
  return { exec, calls };
}

/** A fake ExecFn that rejects — models a spawn-level failure like ENOENT. */
export function throwingExec(err: Error): { exec: ExecFn; calls: ExecRequest[] } {
  const calls: ExecRequest[] = [];
  const exec: ExecFn = async (req) => {
    calls.push(req);
    throw err;
  };
  return { exec, calls };
}

/** A fake LineStreamFn that yields the given lines, then reports onEnd metadata. */
export function fakeLineStream(
  lines: string[],
  end: Partial<StreamEndMeta> = {},
): { lineStream: LineStreamFn; calls: ExecRequest[] } {
  const calls: ExecRequest[] = [];
  const lineStream: LineStreamFn = async function* (req, onEnd) {
    calls.push(req);
    for (const l of lines) yield l;
    onEnd?.({ timedOut: false, exitCode: 0, stderrTail: '', ...end });
  };
  return { lineStream, calls };
}

/** A fake LineStreamFn that throws before yielding — models a spawn failure. */
export function throwingLineStream(err: Error): LineStreamFn {
  return async function* () {
    throw err;
    // eslint-disable-next-line no-unreachable
    yield '';
  };
}

/** Last element of an argv array (typed, non-undefined for non-empty arrays). */
export function last<T>(xs: T[]): T {
  return xs[xs.length - 1] as T;
}

/** Captured `--output-format json` payload (ground truth D), verbatim shape. */
export const RESULT_JSON = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 4988,
  duration_api_ms: 4988,
  result: 'MESH-OK',
  session_id: '630ad917-aaaa',
  request_id: '93277d2f',
  usage: { inputTokens: 12585, outputTokens: 30, cacheReadTokens: 5632, cacheWriteTokens: 0 },
});

/** Captured `--output-format stream-json --stream-partial-output` lines (ground truth E), verbatim. */
export const STREAM_LINES: string[] = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'login',
    cwd: '/tmp/x',
    session_id: 'fe11978d',
    model: 'Composer 2.5',
    permissionMode: 'default',
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Say only: RAW-C' }] },
    session_id: 'fe11978d',
  }),
  JSON.stringify({
    type: 'thinking',
    subtype: 'delta',
    text: 'The user wants me to',
    session_id: 'fe11978d',
    timestamp_ms: 1786440902478,
  }),
  JSON.stringify({ type: 'thinking', subtype: 'completed', session_id: 'fe11978d', timestamp_ms: 1786440903108 }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'RAW' }] },
    session_id: 'fe11978d',
    timestamp_ms: 1786440903111,
  }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '-C' }] },
    session_id: 'fe11978d',
    timestamp_ms: 1786440903112,
  }),
  // The trap: the final full-answer repeat, distinguishable by carrying NO timestamp_ms.
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'RAW-C' }] },
    session_id: 'fe11978d',
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    duration_ms: 18539,
    duration_api_ms: 18539,
    is_error: false,
    result: 'RAW-C',
    session_id: 'fe11978d',
    request_id: 'bc818704',
    usage: { inputTokens: 14186, outputTokens: 36, cacheReadTokens: 5957, cacheWriteTokens: 0 },
  }),
];

/** A `cursor-agent models` stdout capture with header, model lines, blank line, and Tip trailer. */
export const MODELS_STDOUT = [
  'Available models',
  '',
  'auto - Auto',
  'composer-2.5 - Composer 2.5',
  'cursor-grok-4.5-high - Grok 4.5 High',
  'claude-opus-4-8 - Claude Opus 4.8',
  'gpt-5.6 - GPT 5.6',
  '',
  "Tip: use --model <id>, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'",
].join('\n');
