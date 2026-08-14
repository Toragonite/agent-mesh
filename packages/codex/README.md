# @toragonite/agent-mesh-codex

The **Codex (OpenAI)** adapter for [agent-mesh](https://www.npmjs.com/package/@toragonite/agent-mesh).
It drives the official `codex` CLI headlessly behind the vendor-neutral `Adapter`
contract: one-shot runs, resume-by-conversation-id, auth-gated model
introspection, and a quota read.

> **Unofficial.** Not affiliated with or endorsed by OpenAI. It drives the
> vendor's own official CLI under your own login — no credential sharing, no
> rate-limit circumvention.

## Install

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-codex
```

Requires the `codex` CLI installed and logged in (ChatGPT login or
`OPENAI_API_KEY`). Node.js ≥ 18.17.

## Usage

```ts
import { Fleet } from '@toragonite/agent-mesh';
import { CodexAdapter } from '@toragonite/agent-mesh-codex';

const fleet = new Fleet().register(new CodexAdapter());

const result = await fleet.run({ prompt: 'Summarize this repo in one line.' });
console.log(result.text, result.conversationId);

// Continue the same conversation:
const more = await fleet.resume('codex', result.conversationId, 'Now list the risks.');
console.log(more.text);
```

`new CodexAdapter(opts?)` accepts injectable seams (`exec`, `binary`,
`defaultAccount`, `readTextFile`, `fetchFn`, `env`), each with a real default,
plus `quotaTimeoutMs` (default `10000`) bounding the quota fetch.

### Resuming in a working directory

`ResumeOptions` has no `cwd` field, so `resume()` reads a string `extra.cwd` and
runs the CLI there; omit it to inherit the current process directory:

```ts
await fleet.resume('codex', id, 'continue', { extra: { cwd: '/path/to/repo' } });
```

### Models and extra args

An empty or whitespace-only `model` is treated as "not requested" — the adapter
omits `--model` and the CLI applies its own default. A non-empty `model` is
trimmed before it is validated and passed. Non-string entries in `extra.args` are
dropped and reported via `RunResult.note`.

## Auth modes

`authStatus()` reports by value, not by file presence:

- an ambient `OPENAI_API_KEY`, or an `OPENAI_API_KEY` embedded in `auth.json`
  → `mode: 'api-key'`;
- an `auth.json` carrying a real ChatGPT bearer (`tokens.access_token` /
  `id_token`) → `mode: 'chatgpt'` (email surfaced as `detail`, never a token);
- anything else — a missing, empty, or token-less file (`{}`, `{tokens:null}`)
  → `{ loggedIn: false }`. A bare parseable file is not treated as proof of login.

## Auth-gated models

`availableModels()` is auth-mode aware. Under a ChatGPT login only the universal
models are selectable; the `-codex-max` variant and `gpt-5.2` require an API key.
When logged out, the full annotated catalog is returned for introspection.

`run()` and `resume()` validate `model` against the current login before spawning:
a model that the login cannot select (e.g. an api-key-only model under a ChatGPT
login) throws an `AgentMeshError`; an id that is not in the known catalog runs
anyway and is flagged via `RunResult.note`.

| Model               | Latency¹ | Available under        |
| ------------------- | -------- | ---------------------- |
| `gpt-5.6-sol`       | fast     | ChatGPT login, API key |
| `gpt-5.6-terra`     | fast     | ChatGPT login, API key |
| `gpt-5.6-luna`      | fast     | ChatGPT login, API key |
| `gpt-5.5`           | fast     | ChatGPT login, API key |
| `gpt-5.1-codex-max` | slow     | API key only           |
| `gpt-5.2`           | slow     | API key only           |

¹ Latency class is a provisional (unverified) estimate. No model is marked as
the default — when a task names no model, the CLI applies its own default.

## Quota

`quota()` runs **only in your own runtime**, authenticated with your local CLI
login — it is never proxied through a server. It reads the bearer token from
`<CODEX_HOME>/auth.json` and calls the backend usage endpoint. The request is
bounded by `quotaTimeoutMs` (default 10s) and aborts at that deadline so a hung
endpoint cannot stall routing. Any failure (no login, no token, network/parse
error, or the deadline) returns `null` rather than throwing. When the body omits
`allowed`, it is derived — a fully-consumed window (≥ 100%) means new work is
refused. The token is never logged, returned, or included in the snapshot.

## Accounts

Isolate logins with `CODEX_HOME`: pass an `Account` with a `configDir`, and the
adapter sets `CODEX_HOME` for the CLI process and reads auth state from that dir.
Omit it to use the ambient CLI login.

## License

MIT
