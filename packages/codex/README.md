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
plus `quotaTimeoutMs` (default `10000`) bounding the quota fetch, and
`modelsTimeoutMs` (default `15000`) / `modelsCacheMs` (default `60000`) for the
live model listing (see [Models](#auth-gated-models)).

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

`availableModels(account)` asks the CLI itself. It opens one `codex app-server`
session with that account's `CODEX_HOME` (JSON-RPC over stdio: `initialize` →
`initialized` → `model/list`, following `nextCursor` for at most 10 pages), maps
each entry to a `ModelInfo` — `id`, `label` (the display name, when it differs),
`default` (the CLI's `isDefault`), and `efforts` (the model's supported reasoning
efforts) — then ends the session by closing the app-server's stdin. The listing
counts only when the app-server then exits by itself; if it does not answer or
does not exit within `modelsTimeoutMs` (default 15s), its process group is killed.
The child env is yours minus every `ANTHROPIC_*` / `CLAUDE_*` / `CLAUDECODE`
variable. A successful listing is memoized per `CODEX_HOME` for the life of the
adapter; a failed one is retried after `modelsCacheMs` (default 60s).

On any failure — `codex` not installed, a JSON-RPC error, a malformed line, an
early or non-zero exit, the deadline — `availableModels()` returns the static
catalog below instead. It never throws and never hangs. `fetchLiveModels()` is the
same listing on its own: it returns `[]` on any failure, so you can tell a live
answer from the fallback.

```ts
import { fetchLiveModels } from '@toragonite/agent-mesh-codex';
const live = await fetchLiveModels({ codexHome: '/path/to/codex-home' }); // [] on any failure
```

Both lists are auth-mode gated the same way. Under a ChatGPT login only the
universal models are selectable; the `-codex-max` variant and `gpt-5.2` require an
API key. When logged out, the full annotated list is returned for introspection.

`run()` and `resume()` validate `model` against the current login before spawning:
a model that the login cannot select (e.g. an api-key-only model under a ChatGPT
login) throws an `AgentMeshError`; an id that is not in the static catalog runs
anyway and is flagged via `RunResult.note`. (This check never spawns the
app-server.)

The static catalog (`STATIC_MODELS`) — what `codex app-server` listed on
2026-10-14, plus the API-key-only variants:

| Model               | Latency¹ | Available under        |
| ------------------- | -------- | ---------------------- |
| `gpt-6.1-sol`       | fast     | ChatGPT login, API key (the default) |
| `gpt-6-astra`       | fast     | ChatGPT login, API key |
| `gpt-6-sol`         | fast     | ChatGPT login, API key |
| `gpt-6-luna`        | fast     | ChatGPT login, API key |
| `gpt-5.6-sol`       | fast     | ChatGPT login, API key |
| `gpt-5.6-terra`     | fast     | ChatGPT login, API key |
| `gpt-5.6-luna`      | fast     | ChatGPT login, API key |
| `gpt-5.1-codex-max` | slow     | API key only           |
| `gpt-5.2`           | slow     | API key only           |

¹ Latency class is a provisional (unverified) estimate; a live entry the catalog
does not know is classed `fast`. When a task names no model, the adapter omits
`--model` and the CLI applies its own default.

## Quota

`quota()` runs **only in your own runtime**, authenticated with your local CLI
login — it is never proxied through a server. It reads the bearer token from
`<CODEX_HOME>/auth.json` and calls the backend usage endpoint. The request is
bounded by `quotaTimeoutMs` (default 10s) and aborts at that deadline so a hung
endpoint cannot stall routing. Any failure (no login, no token, network/parse
error, or the deadline) returns `null` rather than throwing. The windows
(`primary`, `secondary`) are read from the body's `rate_limit` record (an older
body's top-level windows are still read). When it omits `allowed`, the inverse of
its `limit_reached` is used; when both are absent, it is derived — a
fully-consumed window (≥ 100%) means new work is refused. The token is never
logged, returned, or included in the snapshot.

## Accounts

Isolate logins with `CODEX_HOME`: pass an `Account` with a `configDir`, and the
adapter sets `CODEX_HOME` for the CLI process and reads auth state from that dir.
Omit it to use the ambient CLI login.

## License

MIT
