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

Under a ChatGPT login only the universal models are selectable; `gpt-5.1-codex-max`
and `gpt-5.2` require an API key. When logged out, the full annotated catalog is
returned so callers can still introspect what each login would unlock. No model is
marked `default` — when a task names no model, the adapter omits `--model` and the
CLI applies its own default.

| Model | Latency¹ | Available under |
|---|---|---|
| `gpt-5.6-sol` | fast | ChatGPT login, API key |
| `gpt-5.6-terra` | fast | ChatGPT login, API key |
| `gpt-5.6-luna` | fast | ChatGPT login, API key |
| `gpt-5.5` | fast | ChatGPT login, API key |
| `gpt-5.1-codex-max` | slow | API key only |
| `gpt-5.2` | slow | API key only |

¹ Latency class is a provisional (unverified) estimate, not a measured value.

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
