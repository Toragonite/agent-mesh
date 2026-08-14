#!/usr/bin/env node
/**
 * claude-mesh CLI — a thin front end over the library.
 *
 *   claude-mesh spawn   --name w1 --prompt "..." [--config-dir D] [--model M] [--cwd C]
 *   claude-mesh list    [--config-dir D]
 *   claude-mesh sessions[--config-dir D]
 *   claude-mesh attach  <jobId> [--config-dir D]
 *   claude-mesh logs    <jobId> [--config-dir D]
 *   claude-mesh stop    <jobId> [--config-dir D]
 *   claude-mesh send    --to NAME --message "..." [--summary S] [--config-dir D] [--cwd C] [--model M]
 *   claude-mesh receive [--wait 20] [--max 20] [--config-dir D] [--cwd C] [--model M]
 *
 * `send`/`receive` spin up a short-lived gateway session for one operation (the gateway
 * relays on your behalf because a plain process can't hold a messaging socket open across
 * separate CLI invocations); expect a few seconds of startup and a small model cost.
 */

import { spawn } from 'child_process';
import {
  spawnAgent,
  listAgents,
  stopAgent,
  agentLogs,
  listSessions,
  attachCommand,
  MeshGateway,
  renderInboundMessage,
} from './index';

interface Flags {
  _: string[];
  [key: string]: string | boolean | string[];
}

/** Minimal argv parser: --flag value, --flag=value, --bool, and positionals in `_`. */
function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      (flags._ as string[]).push(a);
    }
  }
  return flags;
}

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

const HELP = `agent-mesh-claude — Claude Code background-agent mesh

Usage:
  agent-mesh-claude spawn    --name <name> --prompt <text> [--config-dir <dir>] [--model <m>] [--cwd <dir>] [--preseed-mcp-trust]
  agent-mesh-claude list     [--config-dir <dir>]
  agent-mesh-claude sessions [--config-dir <dir>]
  agent-mesh-claude attach   <jobId> [--config-dir <dir>]
  agent-mesh-claude logs     <jobId> [--config-dir <dir>]
  agent-mesh-claude stop     <jobId> [--config-dir <dir>]
  agent-mesh-claude send     --to <name> --message <text> [--summary <s>] [--config-dir <dir>] [--cwd <dir>] [--model <m>]
  agent-mesh-claude receive  [--wait <sec>] [--max <n>] [--config-dir <dir>] [--cwd <dir>] [--model <m>]

Requires Claude Code CLI >= 2.1.224 on macOS or Linux. Unofficial.`;

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = (flags._ as string[])[0];
  const configDir = str(flags, 'config-dir');
  const cwd = str(flags, 'cwd');
  const model = str(flags, 'model');

  if (!cmd || cmd === 'help' || flags.help) {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case 'spawn': {
      const name = str(flags, 'name');
      const prompt = str(flags, 'prompt');
      if (!prompt) {
        fail('spawn requires --prompt');
      }
      const res = await spawnAgent({
        prompt: prompt!,
        name,
        configDir,
        model,
        cwd,
        preseedMcpTrust: flags['preseed-mcp-trust'] === true,
      });
      if (res.ok) {
        console.log(`spawned ${res.name} (job ${res.jobId})${res.note ? ` — ${res.note}` : ''}`);
        console.log(res.attachCommand);
      } else {
        fail(res.error ?? 'spawn failed');
      }
      break;
    }
    case 'list': {
      const agents = await listAgents({ configDir });
      if (agents.length === 0) {
        console.log('(no background agents)');
      }
      for (const a of agents) {
        console.log(`${a.jobId}  ${a.name ?? '-'}  ${a.state ?? '-'}  ${a.cwd ?? ''}`);
      }
      break;
    }
    case 'sessions': {
      const rows = listSessions(configDir);
      if (rows.length === 0) {
        console.log('(no sessions)');
      }
      for (const s of rows) {
        console.log(`${s.pid}  ${s.name ?? '-'}  ${s.kind}  ${s.status ?? ''}  ${s.messagingSocketPath ?? ''}`);
      }
      break;
    }
    case 'attach': {
      const jobId = (flags._ as string[])[1];
      if (!jobId) {
        fail('attach requires a <jobId>');
      }
      // attach is interactive — exec it inheriting this terminal.
      const cmdline = attachCommand(jobId!, configDir);
      const child = spawn('/bin/sh', ['-c', cmdline], { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code ?? 0));
      return;
    }
    case 'logs': {
      const jobId = (flags._ as string[])[1];
      if (!jobId) {
        fail('logs requires a <jobId>');
      }
      console.log(await agentLogs(jobId!, { configDir }));
      break;
    }
    case 'stop': {
      const jobId = (flags._ as string[])[1];
      if (!jobId) {
        fail('stop requires a <jobId>');
      }
      const r = await stopAgent(jobId!, { configDir });
      console.log(r.ok ? `stopped ${jobId}` : `stop failed: ${r.error ?? 'unknown'}`);
      break;
    }
    case 'send': {
      const to = str(flags, 'to');
      const message = str(flags, 'message');
      if (!to || !message) {
        fail('send requires --to and --message');
      }
      const gw = new MeshGateway({ cwd: cwd ?? process.cwd(), configDir, model });
      await gw.start();
      try {
        const r = await gw.send({ to: to!, message: message!, summary: str(flags, 'summary') });
        console.log(r.delivered ? `delivered to ${to} (msg_id ${r.msgId ?? 'unknown'})` : `NOT delivered: ${r.error ?? 'unknown'}`);
      } finally {
        await gw.stop();
      }
      break;
    }
    case 'receive': {
      const waitSec = Number(str(flags, 'wait') ?? '20');
      const max = Number(str(flags, 'max') ?? '20');
      const gw = new MeshGateway({ cwd: cwd ?? process.cwd(), configDir, model });
      await gw.start();
      try {
        const msgs = await gw.receive(Math.max(0, waitSec) * 1000, Math.max(1, max));
        if (msgs.length === 0) {
          console.log(`(no messages after ${waitSec}s)`);
        } else {
          console.log(msgs.map(renderInboundMessage).join('\n\n'));
        }
      } finally {
        await gw.stop();
      }
      break;
    }
    default:
      fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

function fail(msg: string): never {
  console.error(`agent-mesh-claude: ${msg}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`agent-mesh-claude: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
