import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunEvent } from '@toragonite/agent-mesh';
import { CodexAdapter } from '../src/adapter.js';

/* ------------------------------------------------------------------------- *
 * End to end through a FAKE `codex` executable (a node script) and the real
 * default line seam: a resumed turn's exact argv reaches the process intact,
 * and stream() maps its JSONL to session/text/usage/done. No vendor CLI.
 * ------------------------------------------------------------------------- */

const THREAD = '019a3b7c-1111-7222-8333-444455556666';

/** The fake CLI: reports a thread (the resumed one, else a new one) and echoes its argv. */
const FAKE_CODEX = `
const args = process.argv.slice(2);
const i = args.indexOf('resume');
const thread = i >= 0 ? args[i + 1] : 'thread-new';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'thread.started', thread_id: thread });
out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: JSON.stringify(args) } });
out({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } });
`;

// A shebang cannot carry spaces; skip on such a node path (and on Windows).
const runnable = process.platform !== 'win32' && !/\s/.test(process.execPath);

describe.skipIf(!runnable)('a resumed turn through a fake codex executable', () => {
  it('passes the resume argv intact and streams session, text, usage, done', async (ctx) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-mesh-fake-codex-'));
    const cli = path.join(dir, 'codex');
    await fs.promises.writeFile(cli, `#!${process.execPath}\n${FAKE_CODEX}`, { mode: 0o755 });
    try {
      try {
        fs.accessSync(cli, fs.constants.X_OK);
      } catch {
        ctx.skip(); // the temp directory does not allow executables (a noexec mount)
      }
      const adapter = new CodexAdapter({ binary: cli, env: { PATH: process.env.PATH ?? '' } });
      const events: RunEvent[] = [];
      for await (const ev of adapter.stream(
        {
          prompt: 'next step',
          resumeId: THREAD,
          model: 'gpt-6-luna',
          permissionMode: 'workspace-write',
          mcp: {
            name: 'team',
            command: '/usr/local/bin/node',
            args: ['/srv/team/cli.js', '--serve'],
            configFile: '/srv/team/mcp.json',
          },
          timeoutMs: 20_000,
        },
        { skipAuthCheck: true },
      )) {
        events.push(ev);
      }
      expect(events.map((e) => e.type)).toEqual(['session', 'text', 'usage', 'done']);
      expect(events[0]).toEqual({ type: 'session', conversationId: THREAD });
      const argv = JSON.parse((events[1] as Extract<RunEvent, { type: 'text' }>).text) as string[];
      expect(argv).toEqual([
        'exec',
        'resume',
        THREAD,
        '--json',
        '--model',
        'gpt-6-luna',
        '-c',
        'sandbox_mode="workspace-write"',
        '-c',
        'mcp_servers.team.command="/usr/local/bin/node"',
        '-c',
        'mcp_servers.team.args=["/srv/team/cli.js","--serve"]',
        '-c',
        'mcp_servers.team.default_tools_approval_mode="approve"',
        '--',
        'next step',
      ]);
      const done = events[3] as Extract<RunEvent, { type: 'done' }>;
      expect(done.result).toMatchObject({ status: 'ok', conversationId: THREAD, model: 'gpt-6-luna' });
      expect(done.result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
