import { describe, it, expect } from 'vitest';
import {
  canStream,
  type Adapter,
  type InteractiveResumeSpec,
  type LineStreamFn,
  type McpAttachment,
  type McpServerStatus,
  type RunEvent,
  type RunOptions,
  type RunResult,
  type RunTask,
} from '../src/index.js';
import { makeAdapter, okResult } from './helpers.js';

/* ------------------------------------------------------------------------- *
 * 0.1.3 — the turn-lane additions are ADDITIVE: an adapter written against
 * 0.1.2 still satisfies `Adapter`, and the new surface is optional throughout.
 * These are compile-time checks as much as runtime ones (typecheck covers test/).
 * ------------------------------------------------------------------------- */

describe('0.1.3 contract additions are additive', () => {
  it('a 0.1.2-shaped adapter (run(task) only, no interactiveResume) still satisfies Adapter', async () => {
    const legacy: Adapter = makeAdapter('codex');
    // The new per-call options can be passed; an adapter that predates them ignores them.
    const opts: RunOptions = { env: { A: '1' }, skipAuthCheck: true };
    const r = await legacy.run({ prompt: 'go', resumeId: 'c1' }, opts);
    expect(r.status).toBe('ok');
    expect(legacy.interactiveResume).toBeUndefined();
  });

  it('a stream taking (task, opts) passes canStream and receives the per-call options', async () => {
    const seen: Array<RunOptions | undefined> = [];
    const a = makeAdapter('claude', { capabilities: { stream: true } });
    a.stream = async function* (_task: RunTask, opts?: RunOptions): AsyncGenerator<RunEvent> {
      seen.push(opts);
      yield { type: 'session', conversationId: 'sess-1' };
      yield { type: 'done', result: okResult('claude', { conversationId: 'sess-1' }) };
    };
    expect(canStream(a)).toBe(true);

    const lineStream: LineStreamFn = async function* () {
      /* a seam that yields nothing */
    };
    const events: RunEvent[] = [];
    if (canStream(a)) {
      for await (const ev of a.stream({ prompt: 'p' }, { lineStream })) events.push(ev);
    }
    expect(seen[0]?.lineStream).toBe(lineStream);
    expect(events.map((e) => e.type)).toEqual(['session', 'done']);
  });

  it('narrows the session event by its type tag', () => {
    const events: RunEvent[] = [
      { type: 'session', conversationId: 'abc' },
      { type: 'text', text: 'hi' },
    ];
    const ids = events.flatMap((e) => (e.type === 'session' ? [e.conversationId] : []));
    expect(ids).toEqual(['abc']);
  });

  it('types the new task fields, the MCP attachment and the take-over spec', () => {
    const mcp: McpAttachment = {
      name: 'team',
      command: '/usr/local/bin/node',
      args: ['/srv/team/cli.js', '--serve', '/srv/team/spec.json'],
      configFile: '/srv/team/mcp.json',
    };
    const task: RunTask = {
      prompt: 'p',
      resumeId: 'r-1',
      appendSystemPromptFile: '/srv/team/brief.md',
      unattended: true,
      mcp,
      disallowedTools: ['SendMessage'],
      settingSources: 'user,project',
      elevated: false,
    };
    const spec: InteractiveResumeSpec = {
      command: 'claude',
      args: ['--resume', 'r-1'],
      env: {},
      unsetEnv: ['CLAUDE_CONFIG_DIR'],
      verified: false,
    };
    expect(task.mcp?.name).toBe('team');
    expect(spec.args).toEqual(['--resume', 'r-1']);
  });
});

describe('0.1.4 contract additions are additive', () => {
  it('a session event and a RunResult without mcpServers are still valid; with it they narrow', () => {
    const servers: McpServerStatus[] = [{ name: 'team', status: 'connected' }];
    const legacy: RunEvent = { type: 'session', conversationId: 'abc' };
    const withServers: RunEvent = { type: 'session', conversationId: 'abc', mcpServers: servers };
    const result: RunResult = { vendor: 'claude', conversationId: 'abc', text: '', status: 'ok', mcpServers: servers };
    const statusOf = (e: RunEvent) => (e.type === 'session' ? e.mcpServers?.map((s) => s.status) : undefined);
    expect(statusOf(legacy)).toBeUndefined();
    expect(statusOf(withServers)).toEqual(['connected']);
    expect(result.mcpServers?.[0]?.name).toBe('team');
  });
});
