# Cursor

The Cursor adapter drives Cursor's official `cursor-agent` CLI headlessly
behind the [Adapter contract](/guide/architecture): `cursor-agent -p
--output-format json` for one-shot runs, `--resume <id>` to revise a
conversation, and `-p --output-format stream-json --stream-partial-output` for
incremental events — all under your own Cursor login.

::: warning Unofficial
Not affiliated with, endorsed by, or supported by Cursor. This package shells
out to the vendor's own official `cursor-agent` CLI under your own login. No
credential sharing, no impersonation, no rate-limit circumvention.
:::

## Install

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-cursor
```

Requires Node ≥ 18.17 and a working `cursor-agent` on your `PATH`, logged in
(`cursor-agent status` should print `✓ Logged in as …`).

## Options

`new CursorAdapter(options?)` — every option defaults to the real
implementation and is overridable for testing:

| Option | Type | Default | Description |
|---|---|---|---|
| `exec` | `ExecFn` | `nodeExec` | Run-to-completion process seam. |
| `lineStream` | `LineStreamFn` | `nodeLineStream` | Streaming process seam backing `stream()`. |
| `binary` | `string` | `'cursor-agent'` | The cursor-agent executable path or command name. |
| `defaultAccount` | `Account` | — | Account used when a call passes none. |
| `env` | `Record<string, string \| undefined>` | `process.env` | Environment seam — the base of every child env, and where `quota()` resolves the login file from. |
| `readTextFile` | `(path) => Promise<string \| null>` | fs read | File-read seam used by `quota()` for the login file. |
| `readKeychain` | `() => Promise<KeychainReadResult>` | `/usr/bin/security` | macOS keychain-read seam used by `quota()`; injected in tests so the real `security` never runs. |
| `platform` | `NodeJS.Platform` | `process.platform` | Decides the login-file locations and whether the keychain is read; set in tests to drive macOS vs non-macOS. |
| `fetchFn` | `typeof fetch` | global `fetch` | Fetch seam for the quota endpoint. |
| `quotaTimeoutMs` | `number` | `10000` | Deadline for the quota read; the request is aborted at it. |
| `trust` | `boolean` | `true` | Whether to pass `--trust`. See [The trust option](#the-trust-option). |
| `models` | `ModelInfo[]` | — | Short-circuits the live `cursor-agent models` read (offline use, hermetic tests, or a fixed catalog). |
| `authTimeoutMs` | `number` | `20000` | Wall-clock cap for the `authStatus()` CLI probe. |
| `modelsTimeoutMs` | `number` | `20000` | Wall-clock cap for the `availableModels()` CLI probe. |

## Run and resume

```ts
import { Fleet } from '@toragonite/agent-mesh'
import { CursorAdapter } from '@toragonite/agent-mesh-cursor'

const fleet = new Fleet().register(new CursorAdapter())

// Cursor is the slowest vendor in the mesh (~30s for a one-word answer), so
// set timeoutMs generously — see Latency below.
const result = await fleet.run(
  { prompt: 'Summarize the changes in this repo.', cwd: process.cwd(), timeoutMs: 120_000 },
  { policy: { prefer: ['cursor'] } },
)
console.log(result.text, result.conversationId)

// Continue the same conversation.
const followUp = await fleet.resume('cursor', result.conversationId, 'Now list the risks.')
console.log(followUp.text)
```

You can also drive the adapter directly:

```ts
const cursor = new CursorAdapter()
const r = await cursor.run({ prompt: 'hello', timeoutMs: 120_000 })
const r2 = await cursor.resume(r.conversationId, 'again')
```

`resume()` rejects a `conversationId` that starts with `-` before spawning
anything — that shape reads as a CLI flag rather than a session id.

## Stream

```ts
for await (const ev of cursor.stream({ prompt: 'Explain this file.', timeoutMs: 120_000 })) {
  switch (ev.type) {
    case 'text':  process.stdout.write(ev.text); break        // incremental answer deltas
    case 'usage': console.log('\n', ev.usage); break           // token usage
    case 'done':  console.log('\n', ev.result.status); break   // terminal RunResult
    case 'error': console.error(ev.message); break
  }
}
```

The CLI emits incremental `assistant` deltas and then one final `assistant`
event repeating the complete answer; the adapter suppresses that repeat (it
carries no `timestamp_ms`, and its text equals the answer accumulated so far),
so the concatenated `text` events are the answer exactly once — never doubled.
A timeout ends the stream with a `done` event of `status: 'incomplete'`
carrying the partial text (never an `error` event), mirroring `run()`; a
non-zero exit with no result, or a trust refusal, ends with an `error` event.

### Thinking events are dropped (known gap)

The stream includes `thinking` events. The core `RunEvent` type has no
thinking channel, and folding reasoning text into `text` would corrupt the
answer, so `thinking` events are **skipped**. This is a deliberate limitation
awaiting a core-contract revision, not an oversight.

## The `trust` option

`cursor-agent` gates work behind a **workspace-trust** check. In an untrusted
directory it does not hang — it **exits** after ~21 seconds with `⚠ Workspace
Trust Required`.

This adapter defaults `trust: true`, which passes `--trust`. Rationale: a
library driving a headless agent in a directory the **caller** chose must not
stall ~21s per task on an interactive trust prompt — **choosing to run a
coding agent in that `cwd` is itself the trust decision.**

```ts
new CursorAdapter()                  // trust: true  → passes --trust (default)
new CursorAdapter({ trust: false })  // passes no --trust; a refusal is surfaced
```

`--force`/`--yolo` is a **different and stronger** grant ("run everything").
This adapter **never** passes it and does not expose it as a default. When
`trust: false` and the CLI refuses, `run()` throws an `AdapterExecError`
naming the `cwd` and pointing you at `{ trust: true }` (or trusting the
directory in Cursor); `stream()` surfaces the same as an `error` event.

## Models: live and memoized

`cursor-agent models` lists ~193 `id - Display Name` entries — far too many,
and too volatile, to hardcode. So `availableModels()` reads the **live** list
through the CLI and **memoizes** it on the instance (repeated `Fleet.route()`
calls do not re-spawn). On any failure — spawn error, timeout, empty output —
it falls back to a small curated static list (`auto`, `composer-2.5`,
`cursor-grok-4.5-high`, `cursor-grok-4.5-high-fast`) so the method **never
throws** and routing still works offline.

This is deliberately different from the Gemini adapter, whose catalog is
static: 193 volatile Cursor entries versus a handful of stable Gemini ones.

To skip the subprocess entirely (offline use, or a fixed catalog), pass
`models`:

```ts
new CursorAdapter({ models: [{ id: 'auto', latencyClass: 'fast', default: true }] })
```

**Native vs resold.** `auto`, or an id starting with `composer` or `cursor-`,
is Cursor-native; every other id resells another vendor's model. Resold
entries carry a `label` warning that selecting one spends that vendor's quota
rather than Cursor's, which defeats the purpose of a multi-vendor fleet.
`auto` is marked as the default (the CLI reports it as the current default)
and its label notes the router may itself pick a resold frontier model.

**Latency** is a provisional heuristic (unmeasured): an id containing `xhigh`,
`high`, `thinking`, `max`, or `opus` is classed `slow`; everything else
`fast`.

**Parameterized model ids** are passed through verbatim, so the CLI's
parameterized form works as-is:

```ts
await cursor.run({ prompt: '…', model: 'claude-opus-4-8[context=1m,effort=high,fast=false]' })
```

A `model` that is not in the resolved catalog (including any parameterized
form, which never matches an id) still **runs** — it is annotated with a
`RunResult.note` of `model <id> not in known catalog`, never blocked.

## `createChat()`

`createChat()` runs `cursor-agent create-chat`, which prints a bare UUID, and
returns it (or `null` on any failure — never throws). Use it to mint a
conversation id **before** the first run:

```ts
import { createChat } from '@toragonite/agent-mesh-cursor'

const chatId = await createChat()
if (chatId) await cursor.resume(chatId, 'first message')
```

## Auth

`authStatus()` shells out to `cursor-agent status`
(`~/.cursor/cli-config.json` holds only UI/model preferences, no auth state,
so a file read cannot answer this). A successful `✓ Logged in as
someone@example.com` returns `{ loggedIn: true, mode: 'cursor', detail:
'someone@example.com' }`. A non-zero exit, a missing binary, or a timeout
returns `{ loggedIn: false }`. It never throws and never emits token
material.

## Quota

`quota()` runs **only in your own runtime**, authenticated with your own
`cursor-agent` login — it is never proxied through a server — and
`capabilities.quota` is `true`. It reads the access token from wherever the CLI
keeps it and calls Cursor's dashboard endpoint `GetCurrentPeriodUsage`.

**On macOS**, under the CLI's default credential store, the token is kept in the
**login keychain**, so the adapter reads it there **first** — the same way the CLI
does, by spawning `/usr/bin/security find-generic-password -a cursor-user -s
cursor-access-token -w` (no shell, a minimal `PATH`/`HOME`/`USER`/`LANG`
environment, a 10s timeout). It fetches the keychain item **`cursor-access-token`**
(account **`cursor-user`**) and uses it **only** as the `Authorization` header of
the one usage request. If macOS blocks or you deny the access prompt (`security`
exits 51/36, or reports interaction is not allowed / canceled), the adapter stops
reading the keychain for **6 hours** (in memory, per instance), so a denied prompt
is not re-raised on every quota poll, and falls back to the files meanwhile.
`AGENT_CLI_CREDENTIAL_STORE=file` or `=memory` skips the keychain.

**The login file** is read next (and is the only source off macOS). The first of
these that exists is the login:

| Platform | 1. the CLI's file store | 2. the older location |
|---|---|---|
| macOS | `~/.cursor/auth.json` | `$XDG_CONFIG_HOME/cursor-agent/auth.json` (else `~/.config/…`) |
| Linux and other Unixes | `$XDG_CONFIG_HOME/cursor/auth.json` (else `~/.config/…`) | `$XDG_CONFIG_HOME/cursor-agent/auth.json` (else `~/.config/…`) |
| Windows | `%APPDATA%\Cursor\auth.json` | `%APPDATA%\Cursor-agent\auth.json` |

An existing first file is authoritative — if it holds no usable token, the older
file is not consulted. Under `AGENT_CLI_CREDENTIAL_STORE=memory` the CLI keeps no
file, so nothing is read and `quota()` resolves `null`. The request is bounded by
`quotaTimeoutMs` (default 10s) and aborted at that deadline. A token that is an
expired JWT resolves `null` without a request: the CLI refreshes its token when
it runs, and this adapter never refreshes one.

```ts
const snapshot = await new CursorAdapter().quota()
// { vendor: 'cursor', allowed: true, windows: [
//     { label: 'total', usedPercent: 1.045,  resetAt: '2026-08-23T00:07:46.000Z' },
//     { label: 'auto',  usedPercent: 0.4525, resetAt: '2026-08-23T00:07:46.000Z' },
//     { label: 'api',   usedPercent: 5.35,   resetAt: '2026-08-23T00:07:46.000Z' } ], raw: … }
```

- **Windows** are the three bars Cursor's dashboard shows: `total`, `auto`
  (first-party models), and `api` (`planUsage.totalPercentUsed` /
  `autoPercentUsed` / `apiPercentUsed`). They are already percentages on a
  0..100 scale and are reported verbatim, clamped — their denominator is
  Cursor's own, so they are not `spend / limit`. A percentage the response
  omits is left out, never reported as 0.
- **`resetAt`** is the end of the billing cycle (`billingCycleEnd`) on every
  window.
- **`allowed`** is derived: `false` once any window reaches 100%.
- **`raw`** is the whole response body (spend figures there are in cents).

Any failure — no credential, unreadable or malformed data, no token, an expired
token, a network error, a non-2xx, the deadline, or a body of another shape —
resolves `null` rather than throwing; the token is never logged, returned, or
included in the snapshot — it reaches only the request header. `null` is the honest
"headroom unknown" signal — the Fleet treats it as "not disqualified", so the Cursor
adapter still routes.

`account.configDir` is not consulted (`cursor-agent` has no config-dir
isolation), so `quota()` always reads the same login `run()` uses.
`QuotaSnapshot.capturedAt` is not stamped by this adapter. `readKeychain`,
`readTextFile`, `fetchFn` and `platform` are injectable so the whole read is
testable without the real `security`, the real home directory, or the network.

::: info The keychain read, precisely
On macOS the adapter reads the `cursor-agent` CLI's own keychain item —
`cursor-access-token`, account `cursor-user` — through `/usr/bin/security`, solely
to request the account's own usage from Cursor. It never writes the keychain, and
the token goes nowhere but the one request's `Authorization` header.
:::

## Caveats

- **`allowedTools`** has no `cursor-agent` equivalent — it is ignored, with a
  `RunResult.note` of `allowedTools not supported by cursor-agent; ignored`.
- **`account.configDir`** is unsupported (`cursor-agent` exposes no
  config-dir env var) — it is ignored, with a note `account.configDir is not
  supported by cursor-agent; ignored`. Multiple notes are joined with `'; '`.
- **Latency.** A one-word answer takes **~30 seconds** — Cursor is the
  slowest vendor in this repo. Set `timeoutMs` accordingly (the examples
  above use 120s).
