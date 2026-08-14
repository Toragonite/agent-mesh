# @toragonite/agent-mesh-gemini

The **Google Antigravity** adapter for [agent-mesh](https://toragonite.github.io/agent-mesh/).
It drives Antigravity's official **`agy`** CLI headlessly, under your own login, behind the
frozen agent-mesh `Adapter` contract — so a `Fleet` can route a task to Antigravity exactly the
way it routes to Claude Code or Codex.

> **Unofficial.** This project is not affiliated with or endorsed by Google. It shells out to
> the `agy` binary you already have installed and authenticated; it never impersonates the
> service, shares credentials, or circumvents rate limits.

## Install

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-gemini
```

You also need the `agy` CLI installed and logged in (Antigravity keeps its credentials in the
Electron app's data directory — there is no CLI `login`/`status` subcommand).

## Run and resume

```ts
import { Fleet } from '@toragonite/agent-mesh';
import { GeminiAdapter } from '@toragonite/agent-mesh-gemini';

const fleet = new Fleet().register(new GeminiAdapter());

// Antigravity answers a one-word prompt in ~12–15s; set timeoutMs accordingly (see Latency).
const res = await fleet.run(
  { prompt: 'Reply with exactly: MESH-OK', timeoutMs: 60_000 },
  { policy: { prefer: ['gemini'] } },
);
console.log(res.status, res.conversationId, res.text);

// Continue that conversation by id.
const more = await fleet.resume('gemini', res.conversationId, 'Now say it backwards.', {
  timeoutMs: 60_000,
});
console.log(more.text);
```

You can also use the adapter directly:

```ts
const agy = new GeminiAdapter({ binary: 'agy' /* default */ });
const res = await agy.run({ prompt: 'hello', model: 'gemini-3.6-flash-high' });
```

## Stream

```ts
const agy = new GeminiAdapter();
for await (const ev of agy.stream({ prompt: 'Write a haiku about routing.', timeoutMs: 60_000 })) {
  if (ev.type === 'text') process.stdout.write(ev.text);
  else if (ev.type === 'usage') console.error('usage', ev.usage);
  else if (ev.type === 'done') console.error('\ndone', ev.result.status, ev.result.conversationId);
  else if (ev.type === 'error') console.error('error', ev.message);
}
```

Streaming maps `agy --output-format stream-json` to agent-mesh `RunEvent`s:

- The stream's `init` event only records the conversation id.
- Only an `agent_response` step with a non-empty `text_delta` becomes a `text` event. Other
  step types (`user_input`, `checkpoint`, …) are **skipped** — the contract has no event for
  them, and their per-step `usage` is partial, not authoritative.
- A delta's **single trailing newline is held back** and re-emitted only when more text
  follows, then dropped at end of stream. This makes the concatenation of all `text` events
  exactly equal the newline-normalized `done.text` (interior newlines are content and are never
  touched). Earlier versions passed deltas through raw, so a consumer concatenating them ended
  up with one extra trailing newline versus `done.text`.
- The terminal payload emits a `usage` event (the authoritative total) followed by a `done`
  event carrying the same `RunResult` a non-streaming `run()` would produce. The terminal
  payload is recognized whether it arrives wrapped in a `result` event **or** as a bare object
  carrying `status`/`response` (the error path and older CLI generations emit the bare form as
  the last line) — both are mapped by the same mapper.
- The `done` event's `note` carries every note `run()` would produce for the same request
  (`allowedTools` ignored, unknown model, dropped `extra.args`, `AGY_HOME`, vendor error text).
- An empty prompt throws **synchronously** at the `stream()` call, before any process spawns.
- If the stream ends with no terminal payload: a **timeout** yields a `done` result with
  `status: 'incomplete'` and a timeout note (never an `error` event); a non-zero **exit** yields
  an `error` event whose message includes the exit code and the child's stderr tail.

## Models

`availableModels()` returns a **static** catalog and spawns nothing, because `Fleet.route()`
calls it on the routing hot path. There is no auth-mode gating — every entry is selectable under
one Google login.

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

The `latency` classes are a **provisional** pin — a best guess at interactive-vs-deep-reasoning
behaviour, not measured. No entry is marked as the adapter default: when a task names no model,
`run()` omits `--model` and the CLI applies its own default, so claiming a default here would be
false. The model is **trimmed** before it is used, and a model that is only whitespace is treated
as **absent** (no `--model`, no note). A non-empty model id that is not in this catalog still runs
(with the trimmed value), carrying a `model <id> not in known catalog` note on the result.

**Resold-model warning.** The three resold entries are reachable through `agy`, but each one
bills the *other* vendor's quota. Routing another vendor's quota through the Gemini adapter
defeats the point of a multi-vendor fleet — prefer registering that vendor's own adapter.

### Static vs live

- **Static** (`availableModels()`) — fast, hermetic, no subprocess. Use it for routing.
- **Live** (`fetchLiveModels()`) — the authoritative but slow path. It runs `agy models`, skips
  the `Fetching available models...` chatter line, parses each TAB-separated `id\tlabel` row, and
  applies the same latency heuristic. Any failure (spawn error, non-zero exit, timeout,
  unparseable output) resolves to `[]`; it never throws.

```ts
import { fetchLiveModels } from '@toragonite/agent-mesh-gemini';
const live = await fetchLiveModels(); // ModelInfo[] — or [] on any failure
```

## Auth

`authStatus()` runs `agy models` (the only auth probe Antigravity exposes — there is no readable
local credential file and no `status`/`login` subcommand). Exit 0 with at least one parseable
model line reports `{ loggedIn: true, mode: 'google' }`; anything else — non-zero exit, missing
binary, timeout, unparseable output — reports `{ loggedIn: false }`. It never throws and never
returns a `detail` (the CLI exposes no account identifier).

**This costs a network round-trip** and is therefore deliberately **not** on the routing path.

## Quota

`quota()` returns `null` unconditionally, and `capabilities.quota` is `false`. Antigravity
exposes no usage endpoint that has been verified. This is a deliberate **"unknown headroom"**
signal: the Fleet treats `null` as "headroom unconfirmed" and still considers the adapter, rather
than being told an exhausted account has full headroom. It is not a stub to be filled in casually.

## Behaviour notes

- **Trailing-newline normalization.** `agy` terminates its printed answer with a newline the
  other agent-mesh vendors do not emit. For cross-vendor comparability, `run()`/`resume()` and the
  stream's `done` result strip **exactly one** trailing newline (`\r\n` or `\n`) from the final
  text. Interior newlines are preserved, and a second trailing newline is kept. Streaming `text`
  deltas hold a single trailing newline back (see Stream) so their concatenation equals the
  normalized `done.text`.
- **`resume()` conversation id.** The id is **trimmed** before validation and before it reaches
  the CLI (a blank or flag-shaped id still throws before any spawn). If the vendor echoes an
  **empty** `conversation_id`, `resume()` falls back to the trimmed id you passed, since that
  conversation is still resumable. `run()` does **not** do this — there an empty id genuinely
  means the vendor returned none.
- **`resume()` working directory.** `ResumeOptions` has no `cwd` field (core is frozen), so
  `resume()` reads a **string** `opts.extra.cwd` and passes it as the child process's working
  directory. A missing or non-string value inherits the parent working directory as before.
- **`usage.totalTokens`.** The vendor-supplied `total_tokens` is used verbatim when present.
  When it is absent but both `inputTokens` and `outputTokens` are numbers, `totalTokens` is their
  sum; otherwise it is omitted.
- **`extra.args` filtering.** Only string entries are forwarded to the CLI. When one or more
  non-string entries are dropped, the result carries an
  `extra.args contained N non-string entr(y|ies); dropped` note rather than dropping them silently.
- **`allowedTools` is ignored.** `agy` has no equivalent flag, so `task.allowedTools` is dropped
  and the result carries an `allowedTools not supported by agy; ignored` note.
- **`account.configDir` → `AGY_HOME`.** There is no documented config-dir env var for `agy`.
  When you pass `account.configDir`, the adapter sets `AGY_HOME` to it and adds a note that
  Antigravity account isolation via this variable is **unverified**. An explicitly passed
  `account` with no `configDir` means the ambient login and does **not** inherit a default
  account's directory. A `null` or otherwise non-object `account` is treated as **absent** — it
  falls back to the default account (never a raw error).
- **Latency.** A one-word answer is observed at **12–15 seconds** (versus ~5s for Claude
  Code/Codex); `agy`'s own `--print-timeout` defaults to `5m0s`. Set `timeoutMs` generously — a
  timeout resolves `status: 'incomplete'` (it never throws), so too tight a cap silently
  truncates real answers.
- **No secrets.** No token or credential value appears in any result, note, detail, error, or
  `raw`. There are no tokens on this path, but the rule holds regardless.

## License

MIT © Toragonite
