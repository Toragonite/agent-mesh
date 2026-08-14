# Claude Code

The Claude Code adapter drives Anthropic's official `claude` CLI headlessly behind
the [Adapter contract](/guide/architecture): `claude -p` for one-shot JSON runs,
`claude --resume` to revise a conversation, and `claude -p --output-format
stream-json` for incremental events — all under your own login.

It also **absorbs `claude-mesh`**: the background-agent lifecycle, session
discovery, a cross-session messaging gateway, and a cross-account bridge ship in
this same package and are still usable directly.

::: warning Unofficial
Not affiliated with or endorsed by Anthropic. This package shells out to your
local `claude` CLI and reads local files under your own login — it never reads,
proxies, or logs your credentials, and makes no network calls of its own.
:::

## Install

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-claude
```

Requires Node ≥ 18.17 and the Claude Code CLI on your `PATH` (or pass a `binary`
path).

## Options

`new ClaudeAdapter(options?)` — every option defaults to the real implementation
and is overridable for testing:

| Option | Type | Default | Description |
|---|---|---|---|
| `exec` | `ExecFn` | `nodeExec` | Run-to-completion process seam. |
| `lineStream` | `LineStreamFn` | `nodeLineStream` | Streaming process seam backing `stream()`. |
| `binary` | `string` | `'claude'` | The claude executable path or command name. |
| `defaultAccount` | `Account` | — | Account used when a call passes none. Its `configDir` sets `CLAUDE_CONFIG_DIR`. |
| `gateway` | `MeshGateway` | — | A live mesh gateway; required for `steer()` (peer wake). |
| `readTextFile` | `(path) => Promise<string \| null>` | fs read | Text file reader, used by `authStatus()`. |
| `getUsage` | `typeof getLiveUsage` | `getLiveUsage` | The live-usage probe backing `quota()`. |

## Run and resume

```ts
import { Fleet } from '@toragonite/agent-mesh'
import { ClaudeAdapter } from '@toragonite/agent-mesh-claude'

const fleet = new Fleet().register(new ClaudeAdapter())

// One-shot run — routed to the only registered vendor here.
const res = await fleet.run({ prompt: 'Summarize the repo README in 3 bullets.' })
console.log(res.text, res.conversationId)

// Revise the same conversation.
const followUp = await fleet.resume('claude', res.conversationId, 'Now make it 1 bullet.')
console.log(followUp.text)
```

`resume()` rejects a `conversationId` that starts with `-` before spawning
anything — that shape reads as a CLI flag rather than a session id, so the adapter
refuses to forward it to `claude --resume`.

A `task.model` naming an id outside the static matrix in [Models](#models) is not
blocked: the adapter passes it straight through to `--model` and attaches a note
to the `RunResult` recording that the requested model fell outside the known
catalog.

## Quota

`quota()` reads live claude.ai plan usage through the absorbed usage probe
(`getLiveUsage`), running entirely in **your own runtime** against the local
`claude` CLI's config dir — nothing is proxied. It honors the adapter's `binary`
option, so the probe spawns the same CLI path/command that `run()` does. It
resolves `null` when the probe fails or the account exposes no plan limits (for
example, an `ANTHROPIC_API_KEY` login), and it never throws for an environmental
failure.

With no `configDir` on the account — the ambient-login case — `quota()` and
`authStatus()` read `~/.claude.json` and inherit the ambient environment rather
than forcing an isolated `CLAUDE_CONFIG_DIR`, so the common "just use my logged-in
CLI" setup is read correctly instead of looking like a fresh install.

`QuotaSnapshot.capturedAt` is not stamped by this adapter — stamp it yourself at
the call site if you need capture-time bookkeeping.

## Steer

`capabilities.steer` is `'mid-run'`, but it requires a live `MeshGateway` — pass
one to the constructor, or `steer()` throws. The `conversationId` argument is a
mesh session **name**, not a run id: Claude Code has no conversation-id→socket
mapping, so the adapter resolves the target by name against the local session
registry.

`createGateway()` requires a `cwd` (the workspace the gateway session runs in),
and the gateway must be started before it can relay anything:

```ts
import { ClaudeAdapter, createGateway } from '@toragonite/agent-mesh-claude'

const gateway = createGateway({ cwd: process.cwd() })
await gateway.start()

const adapter = new ClaudeAdapter({ gateway })

// Wake a running background session by its mesh name and inject guidance.
await adapter.steer('my-background-session', 'Focus on the auth module next.')

await gateway.stop()
```

## Absorbed mesh layers

This package re-exports the full `claude-mesh` surface for callers who want it
directly, without going through the `Adapter` contract:

- **Background agents** — `spawnAgent`, `listAgents`, `stopAgent`, `agentLogs`, `attachCommand`
- **Session discovery** — `listSessions`, `findSession`, `isSessionAlive`
- **Messaging gateway** — `MeshGateway`, `createGateway`
- **Cross-account bridge** — `MeshBridge`

See the package's exports (`packages/claude/src/index.ts`) for the full list of
re-exported types and protocol helpers.

## Models

No auth-mode gating for Claude Code — every model below is selectable under any
login. Naming a model id outside this list is not an error (see [Run and
resume](#run-and-resume)); the adapter passes it through and notes the fallback.

| Model | Latency | Default |
|---|---|---|
| `claude-opus-4-8` | slow | |
| `claude-sonnet-5` | fast | ✅ |
| `claude-haiku-4-5` | fast | |
| `claude-fable-5` | slow | |
