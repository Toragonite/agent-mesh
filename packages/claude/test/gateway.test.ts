import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MeshGateway } from '../src/gateway';

/* ------------------------------------------------------------------------- *
 * A3 — send() must map stdin BACKPRESSURE (write() → false) to a queued write,
 * not to gateway_down. Reserve gateway_down for a genuinely dead pipe.
 *
 * A fake writable lets us drive the exact false-then-drain sequence with no real child.
 * ------------------------------------------------------------------------- */

/** A stdin double whose first write() reports backpressure (false), then accepts (true). */
class FakeStdin extends EventEmitter {
  writable = true;
  destroyed = false;
  readonly writes: string[] = [];
  private failOnce = true;
  write(chunk: string): boolean {
    this.writes.push(chunk);
    if (this.failOnce) {
      this.failOnce = false;
      return false; // kernel buffer full — backpressure, NOT a dead gateway
    }
    return true;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('send() maps backpressure, not gateway_down (A3)', () => {
  it('does not reject on a false write(); the queued relay resolves on its RELAY_RESULT', async () => {
    const gw = new MeshGateway({ cwd: path.join(os.tmpdir(), 'am-gw-a3') });
    const stdin = new FakeStdin();
    (gw as any).child = { stdin };
    (gw as any)._state = 'ready';

    const p = gw.send({ to: 'peer', message: 'hi' });
    let rejected: unknown;
    p.catch((e) => {
      rejected = e;
    });
    // Give the executor a tick to run; a backpressure=false must NOT have rejected it.
    await new Promise((r) => setImmediate(r));
    expect(rejected).toBeUndefined();
    expect(stdin.writes).toHaveLength(1); // the frame WAS written (queued behind the full buffer)

    // Relieve backpressure, then deliver the matching RELAY_RESULT so the parked relay resolves.
    stdin.emit('drain');
    const id = [...((gw as any).pending as Map<string, unknown>).keys()][0] as string;
    (gw as any).resolvePending({ id, delivered: true, msgId: 'm1' });
    await expect(p).resolves.toEqual({ delivered: true, msgId: 'm1', error: undefined });
  });

  it('still reports gateway_down when the stdin stream is destroyed (a genuinely dead pipe)', async () => {
    const gw = new MeshGateway({ cwd: path.join(os.tmpdir(), 'am-gw-a3b') });
    const stdin = new FakeStdin();
    stdin.destroyed = true;
    (gw as any).child = { stdin };
    (gw as any)._state = 'ready';
    await expect(gw.send({ to: 'peer', message: 'hi' })).rejects.toThrow(/gateway_down/);
  });
});

/* eslint-enable @typescript-eslint/no-explicit-any */

/* ------------------------------------------------------------------------- *
 * A1 — the gateway's stdout handler must decode UTF-8 across pipe-chunk
 * boundaries. A fake `claude` gateway child speaks just enough of the protocol
 * (extract the nonce from the standing prompt, reply READY, then echo one INBOUND
 * line whose CJK text is split mid-character across two stdout writes).
 * ------------------------------------------------------------------------- */

const FAKE_GATEWAY_SRC = `#!${process.execPath}
let buf = '';
let handled = false;
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    handle(line);
  }
});
function emit(text) {
  process.stdout.write(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\\n',
  );
}
function handle(line) {
  if (handled) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const content = msg && msg.message && msg.message.content;
  if (typeof content !== 'string') return;
  const m = content.match(/token is ([0-9a-f]{32})/);
  if (!m) return;
  handled = true;
  const nonce = m[1];
  emit('READY');
  const inbound =
    'INBOUND ' + nonce + ' ' +
    JSON.stringify({ from: 'uds:/tmp/cc-socks/123.sock', fromName: 'peer', text: '한국어 답변 ✅' });
  const eventStr = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: inbound }] } });
  const bytes = Buffer.from(eventStr + '\\n', 'utf8');
  const charIdx = eventStr.indexOf('한');
  const cut = Buffer.byteLength(eventStr.slice(0, charIdx), 'utf8') + 1; // one byte INTO '한'
  process.stdout.write(bytes.subarray(0, cut));
  setTimeout(() => process.stdout.write(bytes.subarray(cut)), 60);
}
`;

describe('gateway stdout UTF-8 across chunk boundaries (A1)', () => {
  it('an inbound CJK char split across pipe chunks arrives intact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-gw-a1-'));
    const scriptPath = path.join(dir, 'fake-claude');
    fs.writeFileSync(scriptPath, FAKE_GATEWAY_SRC, { mode: 0o755 });
    const gw = new MeshGateway({ cwd: dir, claudePath: scriptPath });
    try {
      await gw.start();
      const msgs = await gw.receive(3000, 10);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.text).toBe('한국어 답변 ✅');
    } finally {
      await gw.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
