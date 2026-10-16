/**
 * A short JSON-RPC session with `codex app-server` that asks the CLI for its model
 * list — the same list the CLI's own model picker shows for the signed-in account.
 *
 * Protocol (newline-delimited JSON on stdio, as `codex app-server` speaks it):
 *
 *   → {"id":1,"method":"initialize","params":{"clientInfo":{"name","title","version"}}}
 *   ← {"id":1,"result":{userAgent, codexHome, platformFamily, platformOs}}
 *   → {"method":"initialized"}
 *   → {"id":2,"method":"model/list","params":{}}
 *   ← {"id":2,"result":{"data":[…],"nextCursor":"…"|null}}
 *   → {"id":3,"method":"model/list","params":{"cursor":"…"}}     (while nextCursor, ≤ 10 pages)
 *
 * The session is then ENDED by closing the app-server's stdin, and it counts as an
 * answer only when the app-server then exits BY ITSELF with code 0. Every other
 * outcome — a spawn error, a JSON-RPC error, a line that is not a JSON object, an
 * early or non-zero exit, the deadline (whether it never answered or never exited)
 * — resolves `null` after the whole process group is killed and gone (bounded), so
 * nothing is left running and the caller never hangs. This module never throws.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { buildEnv, killProcessGroup } from './exec.js';

export interface AppServerRequest {
  /** The codex binary (name or path). Spawned as `<cmd> app-server`, `shell:false`. */
  cmd: string;
  /** The child env, exactly (not merged over process.env). */
  env: Record<string, string | undefined>;
  /** Deadline for the whole session — answer AND self-exit — in ms. */
  timeoutMs: number;
  /** `clientInfo.version` sent in `initialize`. */
  clientVersion: string;
}

/** At most this many `model/list` pages are requested. */
export const MAX_MODEL_PAGES = 10;
/** A single stdout line longer than this is not a protocol line — the session fails. */
const MAX_LINE_CHARS = 1_048_576;
/** Total stdout cap for one session. */
const MAX_STDOUT_CHARS = 8 * 1_048_576;
/** Raw `data` entries kept across all pages. */
const MAX_ENTRIES = 4_096;
/** After a kill, how long to wait for the exit before resolving anyway. */
const EXIT_WAIT_MS = 2_000;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Run one listing session. Resolves the raw `data` entries of every page, in order,
 * or `null` on any failure (see the module comment). Never rejects.
 */
export function listAppServerModels(req: AppServerRequest): Promise<unknown[] | null> {
  return new Promise<unknown[] | null>((resolve) => {
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(req.cmd, ['app-server'], {
        env: buildEnv(req.env),
        shell: false,
        // Own process group, so a kill reaps whatever the app-server spawned too.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
    } catch {
      resolve(null);
      return;
    }

    const entries: unknown[] = [];
    let settled = false;
    let failing = false;
    let answered = false; // every page received and stdin closed: waiting for the self-exit
    let exited = false;
    let phase: 'initialize' | 'list' = 'initialize';
    let pendingId = 1;
    let pages = 0;
    const cursorsSent = new Set<string>();
    let buffer = '';
    let stdoutChars = 0;

    const settle = (result: unknown[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    // Any failure: kill the whole group now and settle null once it is gone — or after
    // EXIT_WAIT_MS at the latest, so a process that somehow survives cannot hang us.
    const fail = (): void => {
      if (settled || failing) return;
      failing = true;
      if (exited) {
        settle(null);
        return;
      }
      killProcessGroup(child, 'SIGKILL');
      const cap = setTimeout(() => settle(null), EXIT_WAIT_MS);
      cap.unref?.();
    };

    const deadline = setTimeout(fail, req.timeoutMs);
    deadline.unref?.();

    const send = (message: Record<string, unknown>): void => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        fail();
      }
    };

    const requestPage = (cursor: string | undefined): void => {
      pendingId += 1;
      send({ id: pendingId, method: 'model/list', params: cursor === undefined ? {} : { cursor } });
    };

    const endSession = (): void => {
      answered = true;
      try {
        child.stdin.end();
      } catch {
        fail();
      }
    };

    const handleLine = (line: string): void => {
      if (line.trim() === '') return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        fail(); // not a protocol line
        return;
      }
      if (!isRecord(message)) {
        fail();
        return;
      }
      // A notification or a server-to-client request: not an answer to us, not ours to answer.
      if (typeof message.method === 'string') return;
      // A JSON-RPC error — to our request, or with a null id (e.g. a parse error) — ends it.
      if (message.error !== undefined && message.error !== null) {
        fail();
        return;
      }
      if (message.id !== pendingId) return; // a response to something we are not waiting on
      const result = message.result;
      if (phase === 'initialize') {
        if (!isRecord(result)) {
          fail();
          return;
        }
        phase = 'list';
        send({ method: 'initialized' });
        requestPage(undefined);
        return;
      }
      if (!isRecord(result) || !Array.isArray(result.data)) {
        fail();
        return;
      }
      for (const entry of result.data) {
        if (entries.length >= MAX_ENTRIES) break;
        entries.push(entry);
      }
      pages += 1;
      const next = result.nextCursor;
      // Follow the cursor while there is a new one and the page budget allows; a cursor
      // seen before would loop, so it ends the listing like a missing one does.
      if (typeof next === 'string' && next !== '' && pages < MAX_MODEL_PAGES && !cursorsSent.has(next)) {
        cursorsSent.add(next);
        requestPage(next);
        return;
      }
      endSession();
    };

    child.stdin.on('error', () => {
      /* EPIPE once the child is gone — the exit/deadline path owns the outcome */
    });
    child.stderr.on('data', () => {
      /* drained so a chatty child can never fill the pipe and wedge */
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled || failing || answered) return; // keep draining, stop interpreting
      stdoutChars += chunk.length;
      if (stdoutChars > MAX_STDOUT_CHARS) {
        fail();
        return;
      }
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        handleLine(line);
        if (settled || failing || answered) return;
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_LINE_CHARS) fail();
    });

    child.on('error', () => {
      // A spawn failure (ENOENT, EACCES) — or a signal we could not send. Make sure
      // nothing keeps running, then settle; no 'exit' may follow a failed spawn.
      if (!exited) killProcessGroup(child, 'SIGKILL');
      settle(null);
    });
    child.on('exit', (code, signal) => {
      exited = true;
      if (!failing && answered && code === 0 && signal === null) {
        settle(entries);
        return;
      }
      settle(null); // killed, or exited early / non-zero: not a usable answer
    });

    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'agent-mesh', title: 'agent-mesh', version: req.clientVersion },
      },
    });
  });
}
