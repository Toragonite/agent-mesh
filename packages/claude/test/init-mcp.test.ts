import { describe, it, expect } from 'vitest';
import type { McpServerStatus, RunEvent, RunResult } from '@toragonite/agent-mesh';
import { ClaudeAdapter } from '../src/adapter';
import { parseInitMcpServers } from '../src/index';
import type { LineStreamFn, StreamEndMeta } from '../src/exec';

/* ------------------------------------------------------------------------- *
 * 0.1.4 — the `system/init` line's `mcp_servers`, on the `session` event and the
 * `done` result. Fake stream-json lines only — no real CLI is ever spawned here.
 * ------------------------------------------------------------------------- */

const SESSION = '0b6f1c1e-3f7a-4c55-9a51-6f3a8f5e2b10';

function lines(out: string[], end: Partial<StreamEndMeta> = {}): LineStreamFn {
  return async function* (_req, onEnd) {
    for (const l of out) yield l;
    onEnd?.({ timedOut: false, exitCode: 0, stderrTail: '', ...end });
  };
}

async function collect(it: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const INIT = (mcpServers: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION, mcp_servers: mcpServers, ...extra });
const INIT_WITHOUT = JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION, tools: [] });
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', session_id: SESSION, is_error: false, result: 'ok' });

async function run(out: string[], end?: Partial<StreamEndMeta>) {
  const a = new ClaudeAdapter({ lineStream: lines(out, end), env: {} });
  const events = await collect(a.stream({ prompt: 'p' }));
  const session = events.filter((e): e is Extract<RunEvent, { type: 'session' }> => e.type === 'session');
  const last = events.at(-1)!;
  const result: RunResult | undefined = last.type === 'done' ? last.result : undefined;
  return { events, session, result };
}

const NORMAL = [
  { name: 'team', status: 'connected' },
  { name: 'github', status: 'failed' },
  { name: 'linear', status: 'needs-auth' },
  { name: 'slow', status: 'pending' },
];

describe('init mcp_servers on stream() (0.1.4)', () => {
  it('normal: the list rides on the session event and on the done result', async () => {
    const { session, result, events } = await run([INIT(NORMAL), RESULT]);
    expect(session).toEqual([{ type: 'session', conversationId: SESSION, mcpServers: NORMAL }]);
    expect(result!.mcpServers).toEqual(NORMAL);
    expect(events.map((e) => e.type)).toEqual(['session', 'done']);
    // Each consumer gets its own copy.
    expect(session[0]!.mcpServers).not.toBe(result!.mcpServers);
  });

  it('extra keys on an entry are ignored; names and statuses are trimmed', async () => {
    const { session } = await run([
      INIT([{ name: '  team  ', status: ' connected\n', serverInfo: { name: 'x', version: '1' }, scope: 'project' }]),
      RESULT,
    ]);
    expect(session[0]!.mcpServers).toEqual([{ name: 'team', status: 'connected' }]);
  });

  it('an empty list stays an empty list (the CLI reported no servers)', async () => {
    const { session, result } = await run([INIT([]), RESULT]);
    expect(session[0]!.mcpServers).toEqual([]);
    expect(result!.mcpServers).toEqual([]);
  });

  it('missing: no mcp_servers → the field is absent (the session event is exactly as before)', async () => {
    const { session, result } = await run([INIT_WITHOUT, RESULT]);
    expect(session).toEqual([{ type: 'session', conversationId: SESSION }]);
    expect(result).not.toHaveProperty('mcpServers');
  });

  it('malformed → absent, never a throw, and the run is otherwise unchanged', async () => {
    const malformed: unknown[] = [
      null,
      'connected',
      42,
      { team: 'connected' }, // not an array
      [null],
      ['team'],
      [[{ name: 'team', status: 'connected' }]],
      [{ status: 'connected' }], // no name
      [{ name: '', status: 'connected' }], // blank name
      [{ name: '   ', status: 'connected' }],
      [{ name: 7, status: 'connected' }],
      [{ name: 'team' }], // no status
      [{ name: 'team', status: 1 }], // non-string status
      [{ name: 'team', status: null }],
      [{ name: 'team', status: { state: 'connected' } }],
      [{ name: 'team', status: 'connected' }, { name: 'bad', status: false }], // one bad entry spoils the list
    ];
    for (const value of malformed) {
      const { session, result, events } = await run([INIT(value), RESULT]);
      expect(session).toEqual([{ type: 'session', conversationId: SESSION }]);
      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('mcpServers');
      expect(result!.status).toBe('ok');
      expect(events.map((e) => e.type)).toEqual(['session', 'done']);
    }
  });

  it('oversized: at most 64 entries kept, each string cut to 200 characters', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `s${i}`, status: 'connected' }));
    // Past the cap, an entry is dropped unchecked — it cannot spoil the kept 64.
    many[80] = { name: 7, status: null } as never;
    const { session, result } = await run([INIT(many), RESULT]);
    expect(session[0]!.mcpServers).toHaveLength(64);
    expect(session[0]!.mcpServers![63]).toEqual({ name: 's63', status: 'connected' });
    expect(result!.mcpServers).toHaveLength(64);

    const long = [{ name: 'n'.repeat(10_000), status: `${'s'.repeat(250)}` }];
    const cut = (await run([INIT(long), RESULT])).session[0]!.mcpServers!;
    expect(cut[0]!.name).toHaveLength(200);
    expect(cut[0]!.status).toHaveLength(200);
    // Cut by code point, never through a surrogate pair.
    const emoji = [{ name: '😀'.repeat(300), status: 'connected' }];
    const e = (await run([INIT(emoji), RESULT])).session[0]!.mcpServers![0]!;
    expect(Array.from(e.name)).toHaveLength(200);
    expect(e.name).toBe('😀'.repeat(200));
  });

  it('an init line that did not open the session still reaches the done result', async () => {
    // e.g. a hook line reported the session first: no second session event, the list is on done.
    const hook = JSON.stringify({ type: 'system', subtype: 'hook_response', session_id: SESSION });
    const { session, result } = await run([hook, INIT(NORMAL), RESULT]);
    expect(session).toEqual([{ type: 'session', conversationId: SESSION }]);
    expect(result!.mcpServers).toEqual(NORMAL);
  });

  it('only a system/init line counts; the first well-formed list wins', async () => {
    const notInit = JSON.stringify({ type: 'system', subtype: 'status', session_id: SESSION, mcp_servers: NORMAL });
    expect((await run([notInit, RESULT])).result).not.toHaveProperty('mcpServers');
    const second = [{ name: 'later', status: 'connected' }];
    const { result } = await run([INIT(NORMAL), INIT(second), RESULT]);
    expect(result!.mcpServers).toEqual(NORMAL);
  });

  it('a timed-out stream (no result line) carries the list on its incomplete done', async () => {
    const { result } = await run([INIT(NORMAL)], { timedOut: true, exitCode: null });
    expect(result!.status).toBe('incomplete');
    expect(result!.mcpServers).toEqual(NORMAL);
  });
});

describe('parseInitMcpServers()', () => {
  it('reads only {"type":"system","subtype":"init"} objects', () => {
    const list: McpServerStatus[] = [{ name: 'a', status: 'connected' }];
    expect(parseInitMcpServers({ type: 'system', subtype: 'init', mcp_servers: list })).toEqual(list);
    expect(parseInitMcpServers({ type: 'system', subtype: 'other', mcp_servers: list })).toBeUndefined();
    expect(parseInitMcpServers({ type: 'assistant', subtype: 'init', mcp_servers: list })).toBeUndefined();
    for (const x of [undefined, null, 'init', 1, [], [{ type: 'system', subtype: 'init', mcp_servers: list }]]) {
      expect(parseInitMcpServers(x)).toBeUndefined();
    }
  });

  it('never throws, even on a hostile getter', () => {
    const hostile = {
      type: 'system',
      subtype: 'init',
      get mcp_servers(): unknown {
        throw new Error('boom');
      },
    };
    expect(parseInitMcpServers(hostile)).toBeUndefined();
    const entry = {
      get name(): string {
        throw new Error('boom');
      },
      status: 'connected',
    };
    expect(parseInitMcpServers({ type: 'system', subtype: 'init', mcp_servers: [entry] })).toBeUndefined();
  });

  it('returns fresh objects (no aliasing of the parsed line)', () => {
    const entry = { name: 'a', status: 'connected' };
    const out = parseInitMcpServers({ type: 'system', subtype: 'init', mcp_servers: [entry] })!;
    expect(out[0]).toEqual(entry);
    expect(out[0]).not.toBe(entry);
  });
});
