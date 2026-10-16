# @toragonite/agent-mesh-cursor

The **Cursor** adapter for [agent-mesh](https://toragonite.github.io/agent-mesh/) —
drive Cursor's official `cursor-agent` CLI headlessly behind the one frozen
`Adapter` contract, so a `Fleet` can route a task to Cursor alongside Claude
Code, Codex, and Antigravity.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported
> by Cursor. It shells out to the vendor's own official `cursor-agent` CLI under
> **your own login**. No credential sharing, no impersonation, no rate-limit
> circumvention.

## Install

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-cursor
```

Requires Node ≥ 18.17 and a working `cursor-agent` on your `PATH`, logged in
(`cursor-agent status` should print `✓ Logged in as …`).

## Run and resume

```ts
import { Fleet } from '@toragonite/agent-mesh';
import { CursorAdapter } from '@toragonite/agent-mesh-cursor';

const fleet = new Fleet().register(new CursorAdapter());

// One-shot run. Cursor is the slowest vendor in the mesh (~30s for a one-word
// answer), so set timeoutMs generously — see "Latency" below.
const result = await fleet.run(
  { prompt: 'Summarize the changes in this repo.', cwd: process.cwd(), timeoutMs: 120_000 },
  { policy: { prefer: ['cursor'] } },
);
console.log(result.text, result.conversationId);

// Continue the same conversation.
const followUp = await fleet.resume('cursor', result.conversationId, 'Now list the risks.');
console.log(followUp.text);
```

You can also drive the adapter directly:

```ts
const cursor = new CursorAdapter();
const r = await cursor.run({ prompt: 'hello', timeoutMs: 120_000 });
const r2 = await cursor.resume(r.conversationId, 'again');
```

The `conversationId` is **trimmed** before it is validated and sent: surrounding
whitespace is stripped, an empty (or all-whitespace) id throws, and a `-`-leading
id (which the CLI would parse as a flag) throws — all **before** any spawn.

**`resume()` and the working directory.** `ResumeOptions` has no `cwd` field, so a
resume otherwise binds to the **process's** directory rather than the
conversation's. To pin it, pass the directory through `extra.cwd`:

```ts
await cursor.resume(id, 'again', { extra: { cwd: '/path/to/project' } });
```

A non-string `extra.cwd` is ignored (the child inherits as before).

## Stream

`stream()` yields incremental events over
`cursor-agent -p --output-format stream-json --stream-partial-output`:

```ts
for await (const ev of cursor.stream({ prompt: 'Explain this file.', timeoutMs: 120_000 })) {
  switch (ev.type) {
    case 'text':  process.stdout.write(ev.text); break;   // incremental answer deltas
    case 'usage': console.log('\n', ev.usage); break;      // token usage
    case 'done':  console.log('\n', ev.result.status); break; // terminal RunResult
    case 'error': console.error(ev.message); break;
  }
}
```

Notes on the event stream:

- The CLI emits incremental `assistant` deltas and then **one final `assistant`
  event repeating the complete answer**. The adapter suppresses that repeat using
  the vendor's **own discriminator only**: the final repeat is the one `assistant`
  event that carries **no `timestamp_ms`**. Every timestamped `assistant` event is
  a real delta and is emitted — even when its text equals an earlier delta (e.g.
  an answer of `abcabc` arriving as `abc` + `abc`), which a text-equality guard
  would wrongly swallow. This means suppression **depends on the repeat staying
  timestamp-less**: a future `cursor-agent` that stamps the final repeat would
  reintroduce a doubled answer and this logic would need revisiting.
- A **timeout** ends the stream with a `done` event of `status: 'incomplete'`
  carrying the partial text (never an `error` event), mirroring `run()`.
- A non-zero exit with no result, or a trust refusal, ends with an `error` event.

### Thinking events are dropped (known gap)

The stream includes `thinking` events. The core `RunEvent` type has no thinking
channel, and folding reasoning text into `text` would corrupt the answer, so
`thinking` events are **skipped**. This is a deliberate limitation awaiting a
core-contract revision, not an oversight.

## The `trust` option

`cursor-agent` gates work behind a **workspace-trust** check. In an untrusted
directory it does not hang — it **exits** after ~21 seconds with
`⚠ Workspace Trust Required`.

This adapter defaults `trust: true`, which passes `--trust`. Rationale: a library
driving a headless agent in a directory the **caller** chose must not stall ~21s
per task on an interactive trust prompt — **choosing to run a coding agent in
that `cwd` is itself the trust decision.**

```ts
new CursorAdapter();                 // trust: true  → passes --trust (default)
new CursorAdapter({ trust: false }); // passes no --trust; a refusal is surfaced
```

`--force` / `--yolo` is a **different and stronger** grant ("force allow commands
unless explicitly denied"). This adapter passes it **only** for a task that sets
`elevated: true` (since 0.1.3) and never as a default. When
`trust: false` and the CLI refuses, `run()` throws an `AdapterExecError` naming
the `cwd` and pointing you at `{ trust: true }` (or trusting the directory in
Cursor); `stream()` surfaces the same as an `error` event.

## `permissionMode` → `--sandbox`

`RunTask.permissionMode` is a **vendor passthrough**: this adapter maps it
straight onto `cursor-agent --sandbox <value>`. Cursor's `--sandbox` option
accepts exactly **two** values:

| value      | meaning                       |
| ---------- | ----------------------------- |
| `enabled`  | run inside Cursor's sandbox   |
| `disabled` | run outside Cursor's sandbox  |

Any **other** value is still passed through to `--sandbox` unchanged — the vendor
stays the authority — but `cursor-agent` declares the option with a fixed choice
list, so it **rejects** the value itself, exiting non-zero with its own message
(`error: option '--sandbox <mode>' argument '<value>' is invalid. Allowed choices
are enabled, disabled.`). That arrives at the caller as an `AdapterExecError`
carrying the exit code and stderr — a loud, self-diagnosing failure, not a silent
one. To make the mismatch visible **before** the failure, the adapter also adds a
`RunResult.note`:

```
permissionMode '<value>' is not a cursor sandbox mode (expected 'enabled' or 'disabled'); passed through
```

A **blank or whitespace-only** `permissionMode` is treated as **absent** — no
`--sandbox` flag and no note (the same empty-value rule `model` follows).

**Permission-mode vocabularies differ per vendor.** `enabled`/`disabled` are
Cursor's; the sibling adapters accept their own (for example Codex's
`workspace-write`, Claude Code's `acceptEdits`). A task that carries a
vendor-specific `permissionMode` should therefore **pin its account** to that
vendor rather than be left open to `Fleet` routing, or the mode will reach an
adapter that cannot honour it.

This adapter **never** converts a `permissionMode` into `--force` / `--yolo`.
Remapping a permission mode onto those flags would **silently escalate**
privileges ("run everything"); the adapter deliberately leaves the value as a
`--sandbox` passthrough and lets the CLI adjudicate it.

## Models: live and memoized

`cursor-agent models` lists ~193 `id - Display Name` entries — far too many, and
too volatile, to hardcode. So `availableModels()` reads the **live** list through
the CLI and **memoizes** it on the instance (repeated `Fleet.route()` calls do
not re-spawn). On any failure — spawn error, timeout, empty output — it falls
back to a small curated static list (`auto`, `composer-2.5`,
`cursor-grok-4.5-high`, `cursor-grok-4.5-high-fast`) so the method **never
throws** and routing still works offline.

A **failed** probe caches that fallback for `modelsCacheMs` (default `60000`), so
a transient failure recovers on a later call yet **cannot spawn a subprocess on
every routing decision**. A successful read is memoized for the life of the
instance.

```ts
new CursorAdapter({ modelsCacheMs: 60_000 }); // failed-probe fallback TTL (default)
```

**`run()` / `resume()` / `stream()` never spawn the models probe.** They are on
`Fleet.route()`'s critical path and bounded by `task.timeoutMs`, so they must not
block on an out-of-band `cursor-agent models` subprocess. The unknown-model note
is therefore **best-effort**: it is attached only when a catalog is **already
resolved** — the `models` constructor option, or a previously memoized
**successful** `availableModels()` read — and is otherwise skipped. (The curated
failure fallback is a tiny list and deliberately does **not** drive the note.)

> This is deliberately different from the gemini adapter, whose catalog is
> static: 193 volatile Cursor entries versus a handful of stable Gemini ones.

To skip the subprocess entirely (offline use, or a fixed catalog), pass `models`:

```ts
new CursorAdapter({ models: [{ id: 'auto', latencyClass: 'fast', default: true }] });
```

**Native vs resold.** `auto`, or an id starting with `composer` or `cursor-`, is
Cursor-native; every other id **resells** another vendor's model. Resold entries
carry a `label` warning that **selecting one spends that vendor's quota rather
than Cursor's**, which defeats the purpose of a multi-vendor fleet. `auto` is
marked as the default (the CLI reports it as the current default) and its label
notes the router may itself pick a resold frontier model.

**Latency** is a **provisional** heuristic (unmeasured): an id containing
`xhigh`, `high`, `thinking`, `max`, or `opus` is classed `slow`; everything else
`fast`.

**Parameterized model ids** are passed through **verbatim**, so the CLI's
parameterized form works as-is:

```ts
await cursor.run({ prompt: '…', model: 'claude-opus-4-8[context=1m,effort=high,fast=false]' });
```

A `model` that is not in the resolved catalog (including any parameterized form,
which never matches an id) still **runs** — it is annotated with a
`RunResult.note` of `model <id> not in known catalog` (best-effort; see above),
never blocked. A `model` is **trimmed** before use, and a **blank or
whitespace-only** `model` is treated as **absent** — no `--model` flag, no note,
no error.

## Auth

`authStatus()` shells out to `cursor-agent status` (`~/.cursor/cli-config.json`
holds only UI/model preferences — no auth state, so a file read cannot answer
this). A successful `✓ Logged in as someone@example.com` returns
`{ loggedIn: true, mode: 'cursor', detail: 'someone@example.com' }`. A non-zero
exit, a missing binary, or a timeout returns `{ loggedIn: false }`. It never
throws and never emits token material.

## Quota

`quota()` runs **only in your own runtime**, authenticated with your own
`cursor-agent` login — it is never proxied through a server — and
`capabilities.quota` is `true`. It reads the access token from wherever the CLI
keeps it and calls Cursor's dashboard endpoint `GetCurrentPeriodUsage`.

**On macOS**, under the CLI's default credential store, the token lives in the
**login keychain**, so the adapter reads it there **first**. It reads it the same
way the CLI does — spawning `/usr/bin/security find-generic-password -a
cursor-user -s cursor-access-token -w` (no shell, a minimal
`PATH`/`HOME`/`USER`/`LANG` environment, a 10s timeout) — to fetch the keychain
item **`cursor-access-token`** (account **`cursor-user`**), and uses it **only** as
the `Authorization` header of the one usage request. If macOS blocks or you deny
the access prompt (`security` exits 51/36, or reports interaction is not allowed /
canceled), the adapter stops reading the keychain for **6 hours** (in memory, per
instance) so a denied prompt is not re-raised on every quota poll, and falls back
to the files. `AGENT_CLI_CREDENTIAL_STORE=file` or `=memory` skips the keychain.

**The login file** is read next (and is the only source off macOS). The first of
these that exists is the login:

| Platform | 1. the CLI's file store | 2. the older location |
| --- | --- | --- |
| macOS | `~/.cursor/auth.json` | `$XDG_CONFIG_HOME/cursor-agent/auth.json` (else `~/.config/…`) |
| Linux and other Unixes | `$XDG_CONFIG_HOME/cursor/auth.json` (else `~/.config/…`) | `$XDG_CONFIG_HOME/cursor-agent/auth.json` (else `~/.config/…`) |
| Windows | `%APPDATA%\Cursor\auth.json` | `%APPDATA%\Cursor-agent\auth.json` |

An existing first file is authoritative — if it holds no usable token, the older
file is not consulted. Under `AGENT_CLI_CREDENTIAL_STORE=memory` the CLI keeps no
file, so nothing is read and `quota()` returns `null`. The request is bounded by
`quotaTimeoutMs` (default 10s) and aborts at that deadline. A token that is an
expired JWT resolves `null` without a request — the CLI refreshes its token when
it runs; this adapter never refreshes one.

- **Windows:** `total`, `auto` (first-party models), and `api` — the three bars
  Cursor's dashboard shows (`planUsage.totalPercentUsed` / `autoPercentUsed` /
  `apiPercentUsed`). They are already **percentages on a 0..100 scale** (not
  fractions, and not `spend / limit` — the denominator is Cursor's own), reported
  verbatim and clamped. A percentage the response omits is **left out**, never
  reported as 0.
- **`resetAt`:** the end of the billing cycle (`billingCycleEnd`) on every window.
- **`allowed`:** derived — `false` once any window reaches 100%.
- **`raw`:** the whole response body (its spend figures are in cents).

Any failure — no credential, unreadable or malformed data, no token, an expired
token, a network error, a non-2xx, the deadline, or a body of another shape —
returns **`null`** rather than throwing, the honest **"headroom unknown"** signal;
the token is never logged, returned, or included in the snapshot (it reaches only
the request header). `account.configDir` is not consulted, so `quota()` reads the
same login `run()` uses. Inject `readTextFile`, `readKeychain`, `fetchFn`, `env`
and `platform` to test it hermetically.

## Pre-allocating a conversation id

`createChat()` runs `cursor-agent create-chat`, which prints a bare UUID, and
returns it (or `null` on any failure — never throws). Use it to mint a
conversation id **before** the first run:

```ts
import { createChat } from '@toragonite/agent-mesh-cursor';

const chatId = await createChat();
if (chatId) await cursor.resume(chatId, 'first message');
```

## Turns: resume, MCP, `--force` (since 0.1.3)

`run()` and `stream()` take the turn-lane fields of `RunTask` and an optional `RunOptions`
second argument. Measured on cursor-agent 2026.10.14, the argv is:

```
-p --output-format stream-json --stream-partial-output [--trust] [--approve-mcps]
   [--resume <id>] [--model <m>] [--sandbox <mode>] [--force] [extra.args] -- <prompt>
```

- **`resumeId`** → `--resume <id>`. For the FIRST turn, mint the id with `createChat()` and
  pass it as `resumeId` (`sessionId` is not a cursor-agent flag; it is ignored with a note).
  `createChat({ cwd, env })` mints it in the directory, and with the environment, its turns will
  use. `--sandbox` is passed again on every turn.
- **`mcp`** → `--approve-mcps`. The servers come from the `.cursor/mcp.json` YOU write in the
  run's `cwd` (Claude-style `{"mcpServers":{…}}`); the adapter writes no file.
- **`elevated: true`** → `--force`, the only way this adapter ever passes it.
- **`session` event.** `stream()` reports the CLI's own `session_id` once (again only if it
  changes). For a well-formed but **unknown** chat id, cursor-agent **silently starts a new
  chat** (a non-UUID id is an error instead): the `session` id then differs from `resumeId` —
  compare the two after every resumed turn. When the CLI reports no id at all, the result falls
  back to `resumeId`, as `resume()` does. The stream ends with exactly one `done` or `error`.
- **`appendSystemPromptFile`** — no cursor-agent flag: the file's content is prefixed to the
  prompt, with a note. `disallowedTools`, `settingSources` and `mcp.projectConfigFile` are
  ignored with a note; `unattended` needs nothing (print mode never waits for an answer).
- **`RunOptions`** — `lineStream` is the only seam the run spawns through; `env` is the child's
  whole environment, used verbatim.
- `interactiveResume()` returns `undefined`: no interactive take-over in this release.
- The process seam exports `interruptLadder(proc)` (SIGINT to the CLI process only, then
  SIGTERM and SIGKILL to its process group) for the `SpawnedProcess` that `ExecRequest.onSpawn`
  reports, and `execOverLineStream(lineStream, req)`.

## Caveats

- **`allowedTools`** has no `cursor-agent` equivalent — it is ignored, with a
  `RunResult.note` of `allowedTools not supported by cursor-agent; ignored`.
- **`account.configDir`** is unsupported (`cursor-agent` exposes no config-dir
  env var) — it is ignored, with a note
  `account.configDir is not supported by cursor-agent; ignored`. Multiple notes
  are joined with `'; '`. A `null` or otherwise non-object `account` is treated as
  **absent** (it falls back to `defaultAccount`), never a `TypeError`; an account
  object with **no** `configDir` means **ambient** and does not inherit
  `defaultAccount.configDir`.
- **`extra.args`** are forwarded to the CLI **verbatim**, but only string entries.
  If any non-string entries are present they are dropped and a note
  `extra.args contained N non-string entr(y|ies); dropped` is added. **`extra.args`
  must not end with a flag that expects a value** — it would consume the mandatory
  `--` fence that follows and swallow the prompt/message.
- **Latency.** A one-word answer takes **~30 seconds** — Cursor is the slowest
  vendor in this repo. Set `timeoutMs` accordingly (the examples use 120s).

## License

MIT © 2026 Toragonite
