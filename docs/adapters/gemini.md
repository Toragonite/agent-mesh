# Antigravity (Gemini)

The Antigravity adapter drives Google's official `agy` CLI headlessly behind
the [Adapter contract](/guide/architecture): `agy --output-format json -p` for
one-shot runs, `agy --conversation <id> -p` to revise a conversation, and `agy
--output-format stream-json -p` for incremental events — all under your own
Google login.

::: warning Unofficial
Not affiliated with or endorsed by Google. This package shells out to the `agy`
binary you already have installed and authenticated — it never impersonates the
service, shares credentials, or circumvents rate limits.
:::

## Install

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-gemini
```

Requires the `agy` CLI installed and logged in. Antigravity keeps its
credentials in the Electron app's data directory — there is no CLI
`login`/`status` subcommand, so [Auth](#auth) below shells out instead of
reading a file.

## Options

`new GeminiAdapter(options?)` — every option defaults to the real implementation
and is overridable for testing:

| Option | Type | Default | Description |
|---|---|---|---|
| `exec` | `ExecFn` | `nodeExec` | Run-to-completion process seam. |
| `lineStream` | `LineStreamFn` | `nodeLineStream` | Streaming process seam backing `stream()`. |
| `binary` | `string` | `'agy'` | The agy executable path or command name. |
| `defaultAccount` | `Account` | — | Account used when a call passes none. Its `configDir` sets `AGY_HOME` (undocumented for `agy`; see [Behaviour notes](#behaviour-notes)). |
| `env` | `Record<string, string \| undefined>` | `process.env` | Environment seam — the base of every child env and every env read. |
| `authTimeoutMs` | `number` | `20000` | Wall-clock cap for the `agy models` auth probe. |

## Run and resume

```ts
import { Fleet } from '@toragonite/agent-mesh'
import { GeminiAdapter } from '@toragonite/agent-mesh-gemini'

const fleet = new Fleet().register(new GeminiAdapter())

// Antigravity answers a one-word prompt in ~12-15s; set timeoutMs generously
// (see Latency below).
const res = await fleet.run(
  { prompt: 'Reply with exactly: MESH-OK', timeoutMs: 60_000 },
  { policy: { prefer: ['gemini'] } },
)
console.log(res.status, res.conversationId, res.text)

// Continue that conversation by id.
const more = await fleet.resume('gemini', res.conversationId, 'Now say it backwards.', {
  timeoutMs: 60_000,
})
console.log(more.text)
```

You can also drive the adapter directly:

```ts
const agy = new GeminiAdapter({ binary: 'agy' /* default */ })
const res = await agy.run({ prompt: 'hello', model: 'gemini-3.6-flash-high' })
```

## Stream

```ts
const agy = new GeminiAdapter()
for await (const ev of agy.stream({ prompt: 'Write a haiku about routing.', timeoutMs: 60_000 })) {
  if (ev.type === 'text') process.stdout.write(ev.text)
  else if (ev.type === 'usage') console.error('usage', ev.usage)
  else if (ev.type === 'done') console.error('\ndone', ev.result.status, ev.result.conversationId)
  else if (ev.type === 'error') console.error('error', ev.message)
}
```

Streaming maps `agy --output-format stream-json` to agent-mesh `RunEvent`s: the
`init` event only records the conversation id; only an `agent_response` step
with a non-empty `text_delta` becomes a `text` event (other step types —
`user_input`, `checkpoint`, … — are skipped, since the contract has no event
for them and their per-step usage is partial, not authoritative); the terminal
`result` event emits a `usage` event followed by a `done` event carrying the
same `RunResult` a non-streaming `run()` would produce. An empty prompt throws
synchronously at the `stream()` call, before any process spawns. If the stream
ends with no `result` event: a timeout yields a `done` result with `status:
'incomplete'` (never an `error` event); a non-zero exit yields an `error`
event with the exit code and the child's stderr tail.

## Models

`availableModels()` returns a **static** catalog and spawns nothing, because
`Fleet.route()` calls it on the routing hot path:

| id | latency | note |
| --- | --- | --- |
| `gemini-3.6-flash-high` | fast | |
| `gemini-3.6-flash-medium` | fast | |
| `gemini-3.6-flash-low` | fast | |
| `gemini-3.5-flash-high` | fast | |
| `gemini-3.5-flash-medium` | fast | |
| `gemini-3.5-flash-low` | fast | |
| `gemini-3.1-pro-high` | slow | |
| `gemini-3.1-pro-low` | slow | |
| `claude-sonnet-4-6` | fast | **resold** — selecting it spends Anthropic quota, not Gemini's |
| `claude-opus-4-6-thinking` | slow | **resold** — selecting it spends Anthropic quota, not Gemini's |
| `gpt-oss-120b-medium` | fast | **resold** — selecting it spends the provider's quota, not Gemini's |

::: warning Resold models
Three catalog entries are reachable through `agy` but bill an *other* vendor's
quota, not Google's. Routing another vendor's quota through the Gemini adapter
defeats the point of a multi-vendor fleet — prefer registering that vendor's own
adapter instead.
:::

There is no auth-mode gating — every entry is selectable under one Google
login. The `latency` classes are a provisional pin (a best guess at
interactive-vs-deep-reasoning behavior, not measured). No entry is marked
`default`: when a task names no model, `run()` omits `--model` and the CLI
applies its own default — claiming a default here would be false. A model id
outside this catalog still runs, with a `model <id> not in known catalog`
note on the result.

### Static vs live

`availableModels()` is the fast, hermetic path for routing. The authoritative
but slow counterpart is `fetchLiveModels()`, which runs `agy models`, skips the
`Fetching available models...` chatter line, and parses each TAB-separated
`id\tlabel` row:

```ts
import { fetchLiveModels } from '@toragonite/agent-mesh-gemini'
const live = await fetchLiveModels() // ModelInfo[] — or [] on any failure
```

Any failure (spawn error, non-zero exit, timeout, unparseable output) resolves
to `[]`; it never throws.

## Auth

`authStatus()` runs `agy models` — the only auth probe Antigravity exposes,
since there is no readable local credential file and no `status`/`login`
subcommand. Exit 0 with at least one parseable model line reports `{ loggedIn:
true, mode: 'google' }`; anything else (non-zero exit, missing binary, timeout,
unparseable output) reports `{ loggedIn: false }`. It never throws and never
returns a `detail` — the CLI exposes no account identifier.

**This costs a network round-trip**, so it is deliberately **not** on the
routing path — only `availableModels()` (static) is.

## Quota

`quota()` returns `null` unconditionally, and `capabilities.quota` is `false`.
Antigravity exposes no usage endpoint that has been verified. This is a
deliberate "unknown headroom" signal, not a stub filled in casually:
fabricating `{ allowed: true, windows: [] }` would tell the Fleet's router
that an exhausted account has full headroom. Returning `null` instead means
the router treats Gemini's headroom as **unconfirmed** rather than believing a
fabricated full tank — it still considers the adapter, just without
quota-ranking it against vendors that report real usage. Never throws.

## Behaviour notes

- **Trailing-newline normalization.** `agy` terminates its printed answer with
  a newline the other agent-mesh vendors do not emit. For cross-vendor
  comparability, `run()`/`resume()` and the stream's `done` result strip
  exactly one trailing newline (`\r\n` or `\n`) from the final text. Interior
  newlines are preserved, and a second trailing newline is kept. Streaming
  `text` deltas are passed through raw — only the final assembled text is
  normalized.
- **`allowedTools` is ignored.** `agy` has no equivalent flag, so
  `task.allowedTools` is dropped and the result carries an `allowedTools not
  supported by agy; ignored` note.
- **`account.configDir` → `AGY_HOME`.** There is no documented config-dir env
  var for `agy`. When you pass `account.configDir`, the adapter sets `AGY_HOME`
  to it and adds a note that Antigravity account isolation via this variable is
  **unverified**. An explicitly passed `account` with no `configDir` means the
  ambient login and does not inherit a default account's directory.
- **Latency.** A one-word answer is observed at **12–15 seconds** (versus ~5s
  for Claude Code/Codex); `agy`'s own `--print-timeout` defaults to `5m0s`. Set
  `timeoutMs` generously — a timeout resolves `status: 'incomplete'` (it never
  throws), so too tight a cap silently truncates real answers.
- **No secrets.** No token or credential value appears in any result, note,
  detail, error, or `raw`. There are no tokens on this path, but the rule
  holds regardless.
