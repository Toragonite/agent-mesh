# @toragonite/agent-mesh

**One vendor-neutral interface for driving coding agents as headless workers.**

`@toragonite/agent-mesh` is the core of the [agent-mesh](https://toragonite.github.io/agent-mesh/)
project: the `Adapter` contract that every vendor package implements, and the
`Fleet` router that schedules a task across the adapters you register — by
preference order, remaining quota, or latency class. The core holds **no vendor
knowledge**; all vendor behavior lives in the adapter packages.

> **Unofficial.** agent-mesh is not affiliated with, endorsed by, or supported by
> Anthropic, OpenAI, Google, or Cursor. Each adapter drives the vendor's own
> official CLI under your own login.

## Install

```sh
npm install @toragonite/agent-mesh \
            @toragonite/agent-mesh-claude \
            @toragonite/agent-mesh-codex
```

The core is a peer of the adapters — install the core plus whichever vendor
adapters you need.

## Example

Register two adapters and let the Fleet route a task to whichever has quota,
preferring Claude:

```ts
import { Fleet } from '@toragonite/agent-mesh';
import { ClaudeAdapter } from '@toragonite/agent-mesh-claude';
import { CodexAdapter } from '@toragonite/agent-mesh-codex';

const fleet = new Fleet()
  .register(new ClaudeAdapter())
  .register(new CodexAdapter());

const result = await fleet.run(
  { prompt: 'Summarize the README in one sentence.', cwd: process.cwd() },
  { policy: { prefer: ['claude', 'codex'], strategy: 'most-quota' } },
);

console.log(`[${result.vendor}] ${result.text}`);
```

`fleet.run` resolves a `RunResult` — the final `text`, the `vendor` that ran, a
`conversationId` you can feed to `resume()`, `status`, and optional `usage`.

## What's in the box

- **`Adapter`** — the frozen contract every vendor package implements: `run`,
  `resume`, `stream`, `quota`, `authStatus`, `availableModels`, and the
  `capabilities` each vendor advertises.
- **`Fleet`** — registers adapters by vendor and routes a `RunTask` across them
  with `prefer-order`, `most-quota`, or `lowest-latency` strategies, gated by a
  `quotaCeiling`.
- **Data contract & errors** — `RunTask`, `RunResult`, `QuotaSnapshot`,
  `ModelInfo`, and the `AgentMeshError` hierarchy.

## Turns that resume one conversation (since 0.1.3)

A host can drive a coding agent as a series of headless **turns** — the first starts a
conversation, every later one resumes it — with the same calls on every vendor. All of it is
optional and additive; an adapter written against 0.1.2 still satisfies `Adapter`.

```ts
const events = adapter.stream(
  {
    prompt: 'Pick up where you left off.',
    resumeId: conversationId,        // continue it (run() honours it too)
    model: 'gpt-6-luna',             // passed again on every turn (Codex requires it on a resume)
    permissionMode: 'workspace-write',
    mcp: { name: 'team', command: '/usr/local/bin/node', args: ['/srv/team.js'], configFile: '/srv/team.json' },
  },
  { lineStream: mySeam, env: childEnv }, // RunOptions: the spawn seam and the WHOLE child env
);
for await (const ev of events) {
  if (ev.type === 'session' && ev.conversationId !== conversationId) {
    // The CLI continued in a NEW conversation (Cursor and Antigravity do this silently
    // for an id they do not know) — re-brief it.
  }
}
```

- **`RunTask`** gains `resumeId`, `sessionId`, `appendSystemPromptFile`, `unattended`, `mcp`
  (an `McpAttachment`), `disallowedTools`, `settingSources` and `elevated`. Each adapter maps
  them to its CLI's own flags and notes (on `RunResult.note`) the ones its CLI has no
  equivalent for; an invalid value throws before anything is spawned.
- **`RunOptions`** — the optional second argument of `run()` / `stream()`: `lineStream` (every
  process of the run is started through it), `env` (the complete child environment, used as
  is — the adapter adds no account variable), `skipAuthCheck`.
- **`RunEvent` `session`** — the conversation id as the vendor's own stream reported it, never
  synthesized from `sessionId` or `resumeId`. A stream ends with exactly one `done` or `error`.
- **`Adapter.interactiveResume?()`** — the command line that opens the vendor's interactive
  terminal on a conversation (an `InteractiveResumeSpec`), or `undefined`.

## Adapter packages

| Package | Vendor |
| --- | --- |
| [`@toragonite/agent-mesh-claude`](https://www.npmjs.com/package/@toragonite/agent-mesh-claude) | Claude Code |
| [`@toragonite/agent-mesh-codex`](https://www.npmjs.com/package/@toragonite/agent-mesh-codex) | Codex (OpenAI) |

## Documentation

Full guide, adapter references, and routing docs at
**<https://toragonite.github.io/agent-mesh/>**.

## License

[MIT](https://github.com/Toragonite/agent-mesh/blob/main/LICENSE) © Toragonite
