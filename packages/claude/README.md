# @toragonite/agent-mesh-claude

The **Claude Code adapter** for [agent-mesh](https://www.npmjs.com/package/@toragonite/agent-mesh).
It drives Anthropic's official `claude` CLI as a headless worker behind the vendor-neutral
`Adapter` contract — so a `Fleet` can spawn runs, revise conversations, stream events, read
quota, and route across vendors without knowing anything Claude-specific.

It also **absorbs [claude-mesh](https://www.npmjs.com/package/@toragonite/claude-mesh)**: the
background-agent lifecycle (`spawnAgent` / `listAgents` / `stopAgent`), session discovery, the
cross-session messaging **gateway** (`MeshGateway`), and the cross-account **bridge**
(`MeshBridge`) are all re-exported and still usable on their own. The live claude.ai
plan-usage reader (`getLiveUsage`) is bundled too and backs `quota()`.

> **Unofficial.** This package shells out to your local `claude` CLI and reads local files
> under your own login. It never reads, proxies, or logs your credentials, and makes no
> network calls of its own.

## Install

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-claude
```

Requires Node ≥ 18.17 and the Claude Code CLI on your `PATH` (or pass a `binary` path).

## Usage

```ts
import { Fleet } from '@toragonite/agent-mesh';
import { ClaudeAdapter } from '@toragonite/agent-mesh-claude';

const fleet = new Fleet().register(new ClaudeAdapter());

// One-shot run — routed to the only registered vendor here.
const res = await fleet.run({ prompt: 'Summarize the repo README in 3 bullets.' });
console.log(res.text, res.conversationId);

// Revise the same conversation.
const followUp = await fleet.resume('claude', res.conversationId, 'Now make it 1 bullet.');
console.log(followUp.text);
```

Every seam is injectable for hermetic tests: `new ClaudeAdapter({ exec, lineStream, binary,
defaultAccount, gateway, readTextFile, getUsage, env })`. The `env` seam (default `process.env`)
is the base of the spawned child's environment: when you inject it, it becomes the child's whole
environment (plus `CLAUDE_CONFIG_DIR` for an explicit account), so introspection and execution
always resolve the same account.

## Behavior notes

- **Model selection.** Omitting `task.model` lets the **CLI choose its own default** — the adapter
  passes no `--model`, so whatever model your `claude` install defaults to is what runs.
  `availableModels()` therefore advertises **no** `default` model: the adapter never injects one on
  your behalf. Pass `task.model` to pin a model; an id outside the known catalog still runs but adds
  a `RunResult.note`.
- **Resume working directory.** `ResumeOptions` has no `cwd` field, so `resume()` reads
  `opts.extra?.cwd` when it is a string and runs the child there; otherwise it inherits the process
  working directory. Pass `resume(id, message, { extra: { cwd: '/path/to/repo' } })` to run the
  revision in the conversation's workspace.

## License

MIT © Toragonite
