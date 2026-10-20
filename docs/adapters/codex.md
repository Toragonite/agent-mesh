# Codex

The Codex adapter drives OpenAI's official `codex` CLI headlessly behind the
[Adapter contract](/guide/architecture): one-shot runs, resume-by-conversation-id,
auth-gated model introspection, and a runtime-local quota read.

::: warning Unofficial
Not affiliated with or endorsed by OpenAI. This package drives your local `codex`
CLI under your own login — no credential sharing, no rate-limit circumvention.
:::

## Install

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-codex
```

Requires the `codex` CLI installed and logged in (ChatGPT login or
`OPENAI_API_KEY`). Node.js ≥ 18.17.

## Options

`new CodexAdapter(options?)` — every option defaults to the real implementation
and is overridable for testing:

| Option | Type | Default | Description |
|---|---|---|---|
| `exec` | `ExecFn` | `nodeExec` | Process-exec seam. |
| `binary` | `string` | `'codex'` | CLI binary name/path. |
| `defaultAccount` | `Account` | — | Account used when a task/call names none. |
| `readTextFile` | `ReadTextFile` | fs read | File-read seam used by `authStatus()` and `quota()`. |
| `fetchFn` | `typeof fetch` | global `fetch` | Fetch seam for the quota endpoint. |
| `env` | `NodeJS.ProcessEnv` | `process.env` | Environment seam. |
| `quotaTimeoutMs` | `number` | `10000` | Deadline for the quota fetch. |
| `modelsTimeoutMs` | `number` | `15000` | Deadline for the `codex app-server` model listing; its process group is killed at it. |
| `modelsCacheMs` | `number` | `60000` | How long a failed listing returns the static catalog before the CLI is asked again. |
| `spawn` | `SpawnFn` | `child_process.spawn` | Process-spawn seam for the `codex app-server` model listing (since 0.1.4). With the default, a failure or the deadline kills the app-server's process group; an injected spawner's child is killed by itself only. |

## Run and resume

```ts
import { Fleet } from '@toragonite/agent-mesh'
import { CodexAdapter } from '@toragonite/agent-mesh-codex'

const fleet = new Fleet().register(new CodexAdapter())

const result = await fleet.run({ prompt: 'Summarize this repo in one line.' })
console.log(result.text, result.conversationId)

// Continue the same conversation:
const more = await fleet.resume('codex', result.conversationId, 'Now list the risks.')
console.log(more.text)
```

`run()`/`resume()` validate `task.model`/`opts.model` against the catalog in
[Auth-gated models](#auth-gated-models): naming a catalog model whose `authModes`
excludes the current login (for example `gpt-5.1-codex-max` under a ChatGPT login)
throws `AgentMeshError` before spawning, instead of letting the CLI fail opaquely.
A model id outside the catalog entirely is not blocked — the adapter passes it
through to `--model` and attaches a note to the `RunResult` recording that it fell
outside the known catalog.

`resume()` also rejects a `conversationId` that starts with `-` before spawning —
that shape reads as a CLI flag rather than a session id, so the adapter refuses to
forward it to `codex exec resume`.

## Auth-gated models

`availableModels()` is auth-mode aware. `authStatus()` only resolves `mode:
'chatgpt'` when `<CODEX_HOME>/auth.json` carries real OAuth tokens — a parseable
but token-less file (e.g. after a logout) resolves `loggedIn: false` rather than a
false-positive login. `mode: 'api-key'` comes from an `OPENAI_API_KEY` environment
variable, or from that same key embedded inside `auth.json`.

### The CLI's own list

`availableModels(account)` asks the CLI. It opens one `codex app-server` session
with that account's `CODEX_HOME` — JSON-RPC lines on stdio: `initialize` →
`initialized` → `model/list`, following `nextCursor` for at most 10 pages — and
maps each entry to a `ModelInfo`: `id`, `label` (the display name, when it
differs), `default` (the CLI's `isDefault`), and `efforts` (its
`supportedReasoningEfforts`). It then ends the session by closing the app-server's
stdin; the listing counts only when the app-server exits by itself. If it does not
answer, or does not exit, within `modelsTimeoutMs` (default 15s), its process group
is killed. The child env is the adapter's env minus every `ANTHROPIC_*` /
`CLAUDE_*` / `CLAUDECODE` variable. A successful listing is memoized per
`CODEX_HOME`; a failed one is retried after `modelsCacheMs`.

On any failure — `codex` not installed, a JSON-RPC error, a malformed line, an
early or non-zero exit, the deadline — the static catalog below is returned
instead. `availableModels()` never throws and never hangs. `fetchLiveModels()` is
the same listing on its own, returning `[]` on any failure, so a caller can tell a
live answer from the fallback:

```ts
import { fetchLiveModels } from '@toragonite/agent-mesh-codex'
const live = await fetchLiveModels({ codexHome: '/path/to/codex-home' }) // [] on any failure
```

The listing is the one process `exec` does not start, so it has its own seam
(since 0.1.4): `spawn` on the adapter options and on `fetchLiveModels()`'s
options, typed `SpawnFn` — the shape of `child_process.spawn`, which is the
default. It is called once as `spawn(binary, ['app-server'], options)` and must
return a child with `stdin`/`stdout`/`stderr` pipes (`SpawnedChild`). A host's
hermetic tests can answer the protocol from an in-memory fake; an injected
child is killed with `child.kill('SIGKILL')` on a failure or at the deadline,
never by process group.

Both lists are gated the same way. Under a ChatGPT login only the universal models
are selectable; `gpt-5.1-codex-max` and `gpt-5.2` require an API key. When logged
out, the full annotated list is returned so callers can still introspect what each
login would unlock. When a task names no model, the adapter omits `--model` and the
CLI applies its own default. The pre-spawn check in `run()`/`resume()` uses the
static catalog and never starts the app-server.

### The static catalog

`STATIC_MODELS` — what `codex app-server` listed on 2026-10-14, plus the
API-key-only variants:

| Model | Latency¹ | Available under |
|---|---|---|
| `gpt-6.1-sol` | fast | ChatGPT login, API key (the default) |
| `gpt-6-astra` | fast | ChatGPT login, API key |
| `gpt-6-sol` | fast | ChatGPT login, API key |
| `gpt-6-luna` | fast | ChatGPT login, API key |
| `gpt-5.6-sol` | fast | ChatGPT login, API key |
| `gpt-5.6-terra` | fast | ChatGPT login, API key |
| `gpt-5.6-luna` | fast | ChatGPT login, API key |
| `gpt-5.1-codex-max` | slow | API key only |
| `gpt-5.2` | slow | API key only |

¹ Latency class is a provisional (unverified) estimate, not a measured value. A live
entry the catalog does not know is classed `fast`.

## Quota

`quota()` runs **only in your own runtime**, authenticated with your local CLI
login — it is never proxied through a server. It reads the bearer token from
`<CODEX_HOME>/auth.json` and calls the vendor's usage endpoint. Any failure (no
login, no token, network/parse error) resolves `null` rather than throwing; the
token itself is never logged, returned, or included in the snapshot.

`QuotaSnapshot.capturedAt` is not stamped by this adapter — stamp it yourself at
the call site if you need capture-time bookkeeping.

## `allowedTools` is not supported

Codex has no tool allow-list flag. If `RunTask.allowedTools` is set, the adapter
ignores it and attaches a note explaining that (`RunResult.note`) instead of
failing the run.

## Accounts

Isolate logins with `CODEX_HOME`: pass an `Account` with a `configDir`, and the
adapter sets `CODEX_HOME` for the CLI process and reads auth state from that dir.
Omit it to use the ambient CLI login.
