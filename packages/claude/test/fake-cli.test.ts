import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunEvent } from '@toragonite/agent-mesh';
import { ClaudeAdapter } from '../src/adapter';
import { interruptLadder, nodeLineStream, type SpawnedProcess } from '../src/exec';

/* ------------------------------------------------------------------------- *
 * End to end through a FAKE `claude` executable (a node script) and the real
 * line seam: a resumed turn reports the CLI's session id, and a SIGINT to the
 * leader — through onSpawn + interruptLadder — stops the turn, which still
 * ends with exactly one terminal event. No vendor CLI is involved.
 * ------------------------------------------------------------------------- */

const SESSION = '0b6f1c1e-3f7a-4c55-9a51-6f3a8f5e2b10';

/** The fake CLI: echoes its session id, then waits; SIGINT → an error result, exit 130. */
const FAKE_CLAUDE = `
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const id = at('--resume') || at('--session-id') || 'fresh-session';
const out = (o, cb) => process.stdout.write(JSON.stringify(o) + '\\n', cb);
process.on('SIGINT', () => out({ type: 'result', is_error: true, session_id: id, result: 'interrupted' }, () => process.exit(130)));
out({ type: 'system', subtype: 'init', session_id: id, argv: args });
setInterval(() => {}, 1000);
`;

// A shebang cannot carry spaces; skip on such a node path (and on Windows).
const runnable = process.platform !== 'win32' && !/\s/.test(process.execPath);

describe.skipIf(!runnable)('a resumed turn through a fake claude executable', () => {
  it('reports the session first, and a leader SIGINT ends the turn with one terminal event', async (ctx) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-mesh-fake-claude-'));
    const cli = path.join(dir, 'claude');
    await fs.promises.writeFile(cli, `#!${process.execPath}\n${FAKE_CLAUDE}`, { mode: 0o755 });
    try {
      try {
        fs.accessSync(cli, fs.constants.X_OK);
      } catch {
        ctx.skip(); // the temp directory does not allow executables (a noexec mount)
      }
      let proc: SpawnedProcess | undefined;
      const adapter = new ClaudeAdapter({ binary: cli, env: {} });
      const events: RunEvent[] = [];
      const start = Date.now();
      for await (const ev of adapter.stream(
        { prompt: 'keep going', resumeId: SESSION, permissionMode: 'acceptEdits', unattended: true, timeoutMs: 20_000 },
        {
          lineStream: (req, onEnd) =>
            nodeLineStream(
              {
                ...req,
                onSpawn: (p) => {
                  proc = p;
                },
              },
              onEnd,
            ),
          env: { PATH: process.env.PATH ?? '' },
        },
      )) {
        events.push(ev);
        if (ev.type === 'session') interruptLadder(proc!, { termAfterMs: 5_000, killAfterMs: 2_000 });
      }
      expect(events[0]).toEqual({ type: 'session', conversationId: SESSION });
      expect(events.map((e) => e.type)).toEqual(['session', 'done']);
      const done = events[1] as Extract<RunEvent, { type: 'done' }>;
      expect(done.result).toMatchObject({ status: 'error', text: 'interrupted', conversationId: SESSION });
      expect(proc!.hasExited()).toBe(true);
      await expect(proc!.exited).resolves.toBe(130);
      expect(Date.now() - start).toBeLessThan(5_000); // the leader SIGINT did it, not an escalation
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
