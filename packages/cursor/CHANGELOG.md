# Changelog

## 0.1.4

No changes in this package. All five packages move in lockstep; this release carries a Claude MCP
status surface, a Codex spawn seam and an Antigravity usage-read fix (see their changelogs).

## 0.1.3

The turn lane. Measured on cursor-agent 2026.10.14.

- **`resumeId` → `--resume <id>`** on `run()` and `stream()`. For a first turn, mint the id with
  `createChat()` and pass it as `resumeId` — `sessionId` is not a cursor-agent flag and is ignored
  with a note. `--sandbox` is passed on every turn, as before. `createChat()` takes `cwd` and
  `env` options, so the chat can be minted where (and as) its turns will run.
- **`mcp` → `--approve-mcps`**; the caller writes `<cwd>/.cursor/mcp.json`. **`elevated: true` →
  `--force`**, the only way this adapter ever passes it.
- **`session` event** from the CLI's `session_id`, once (again only if it changes). For a
  well-formed but unknown chat id cursor-agent SILENTLY starts a new chat: the `session` id then
  differs from `resumeId`. With no id reported, the result falls back to `resumeId`, as `resume()`
  does.
- **One terminal event:** lines after `result` are drained but emit nothing; no `error` after `done`.
- **`RunOptions`:** `lineStream` is the only seam the run spawns through; `env` is the child's whole
  environment, used verbatim.
- `appendSystemPromptFile`: no cursor-agent flag — the content is prefixed to the prompt, with a note.
  `disallowedTools`, `settingSources` and `mcp.projectConfigFile` are ignored with a note;
  `unattended` needs nothing. Invalid turn-lane fields throw before anything is spawned.
- `interactiveResume()` returns `undefined` (no interactive take-over in this release).
- **Process seam:** `ExecRequest.onSpawn` / `SpawnedProcess`, `interruptLadder()` and
  `execOverLineStream()`, exported from the entry.

All five packages move in lockstep (0.1.2 was never published to npm); this package now depends on
`@toragonite/agent-mesh@^0.1.3`.

## 0.1.2

`quota()` now reports Cursor plan usage (it was a stub returning `null`), and
`capabilities.quota` is `true`.

- **The read:** `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
  (Connect-RPC over JSON: body `{}`, `Connect-Protocol-Version: 1`), authenticated with
  the access token from the `cursor-agent` login file. The first file that exists is
  the login: where the current CLI keeps its file store — `~/.cursor/auth.json` on
  macOS, `$XDG_CONFIG_HOME/cursor/auth.json` (else `~/.config/…`) on Linux and other
  Unixes, `%APPDATA%\Cursor\auth.json` on Windows — then the older `cursor-agent`
  location (`$XDG_CONFIG_HOME/cursor-agent/auth.json`, else `~/.config/…`;
  `%APPDATA%\Cursor-agent\auth.json` on Windows). `AGENT_CLI_CREDENTIAL_STORE=memory`
  means the CLI keeps no file, so nothing is read and the result is `null`. Runs only
  in your own runtime; the token is never logged, returned, or placed in `raw`. A JWT
  whose `exp` has passed resolves `null` before any request — the CLI refreshes its
  token when it runs, and this library never refreshes a credential.
- **The snapshot:** windows `total` / `auto` / `api` from `planUsage.totalPercentUsed` /
  `autoPercentUsed` / `apiPercentUsed` — the three bars Cursor's dashboard draws. They
  are already percentages (0..100), read verbatim and clamped; a missing or non-numeric
  one is left out, never reported as 0. Each window's `resetAt` is `billingCycleEnd`
  (epoch milliseconds, as a number or digit string, or an ISO string). `allowed` is
  derived (no window at 100%). `raw` keeps the whole body.
- **macOS keychain:** on macOS, under the CLI's default credential store (i.e. not
  `AGENT_CLI_CREDENTIAL_STORE=file` / `memory`), the `cursor-agent` CLI keeps the token
  in the login keychain rather than in a file — so the adapter reads it there FIRST,
  then falls back to the files. It reads it the way the CLI does: by spawning
  `/usr/bin/security find-generic-password -a cursor-user -s cursor-access-token -w`
  (no shell, a minimal `PATH`/`HOME`/`USER`/`LANG` environment, a 10s timeout that kills
  it), and uses the token for one thing only — the usage request's `Authorization`
  header. If macOS blocks or the user denies the access prompt (`security` exits 51/36,
  or says interaction is not allowed / the user canceled), the adapter stops reading the
  keychain for 6 hours (in memory, per instance) so a denied prompt is not re-raised on
  every quota poll, and uses the files meanwhile.
- **Failures:** no credential, unreadable or malformed data, no token, an expired
  token, a network error, a non-2xx, the deadline, or a body of another shape all
  resolve `null`; `quota()` never throws.
- **New options:** `readTextFile`, `readKeychain`, `platform`, `fetchFn`, and
  `quotaTimeoutMs` (default `10000`, aborting the request at the deadline) — so tests
  never touch the real home directory, the real `security`, or the network.

## 0.1.1

No runtime changes in this package — the published tarball is identical to 0.1.0 apart from
the version number. This release exists so the documentation site can build and deploy: the
workspace root has no `"type": "module"`, so the VitePress config was loaded through the
CommonJS path and the ESM-only VitePress build failed. Renaming the config to
`docs/.vitepress/config.mts` fixes it. All five packages move in lockstep, so this package
is bumped to 0.1.1 with the rest.

## 0.1.0

Initial release.

- `CursorAdapter` implementing the agent-mesh `Adapter` contract against the
  official `cursor-agent` CLI.
- `run()` / `resume()` via `cursor-agent -p --output-format json`, with a
  tolerant last-JSON-object parser and a single result mapper (conversation id,
  final text, camelCase token usage with a derived total, status semantics).
- `stream()` via `-p --output-format stream-json --stream-partial-output`,
  suppressing the CLI's final full-answer repeat (belt-and-braces: no
  `timestamp_ms`, or text equal to the accumulated answer) so incremental deltas
  never double the answer.
- `availableModels()` read LIVE from `cursor-agent models` and memoized, with a
  provisional latency heuristic, native-vs-resold classification (resold entries
  carry a quota warning), and a four-entry curated fallback so it never throws.
- `authStatus()` shelling out to `cursor-agent status` (identifier surfaced as
  detail, never a token).
- `quota()` returns `null` by design — Cursor exposes no verified usage endpoint.
- `createChat()` helper to pre-allocate a conversation id via
  `cursor-agent create-chat`.
- `trust` option (default `true`, emits `--trust`); `--force`/`--yolo` is never
  passed. A trust refusal is detected and surfaced with remediation.
- Injectable `exec` / `lineStream` / `env` / `models` seams; fully hermetic test
  suite (no real CLI, network, or home directory).

Fixes from an adversarial review (cursor-specific defects and cross-adapter
uniform rules):

- **Stream duplicate-suppression** now keys on the vendor's own discriminator
  **only** — the final full-answer repeat is the one `assistant` event with no
  `timestamp_ms`. The previous text-equality guard was removed: it swallowed a
  legitimate repeated delta (e.g. an answer of `abcabc` streamed as `abc` +
  `abc`), truncating the live stream while `done` stayed correct.
- **`run()` / `resume()` / `stream()` never spawn `cursor-agent models`.** The
  unknown-model note is now best-effort — attached only when a catalog is already
  resolved (the `models` option or a memoized **successful** read) — so a routing
  decision can no longer block on an out-of-band subprocess outside `timeoutMs`.
- **Failed model probes are cached** for a new `modelsCacheMs` window (default
  `60000`), so a transient failure recovers later but cannot re-spawn the probe on
  every route.
- **`stream()` trust-refusal detection** now scans the combined stdout output and
  the stderr tail (the refusal banner is printed on stdout), emitting the same
  remediation message `run()` produces.
- **`stream()`'s `done` result now carries every note `run()` would attach** — the
  unknown-model, ignored-`allowedTools`, ignored-`account.configDir`, and dropped
  `extra.args` notes.
- **Off-vocabulary `permissionMode` now gets a `RunResult.note`** (U9). Cursor's
  `--sandbox` accepts only `enabled` / `disabled`; any other value (e.g. a sibling
  adapter's `workspace-write` or `acceptEdits`) is still passed through to
  `--sandbox` unchanged and rejected by the CLI itself, but the adapter now warns
  up front with `permissionMode '<value>' is not a cursor sandbox mode (expected
  'enabled' or 'disabled'); passed through`. The note composes with the other notes
  and reaches `stream()`'s `done` result. No CLI flag is added, suppressed, or
  remapped onto `--force` / `--yolo`.
- **Conversation ids are trimmed before validation and use** (U1): an empty or
  `-`-leading id throws before any spawn, and the CLI only ever sees the trimmed
  value.
- **Model values are trimmed** (U2): a blank/whitespace-only `model` is treated as
  absent (no flag, no note, no error); a real value is passed verbatim.
- **`usage.totalTokens`** uses a vendor-supplied total verbatim when present,
  otherwise derives it from input+output (U3).
- **A `null` or malformed `account`** is treated as absent (falls back to
  `defaultAccount`) instead of raising a `TypeError` (U4).
- **Dropped non-string `extra.args`** entries are now reported with a note (U5);
  the README warns that `extra.args` must not end with a value-expecting flag.
- **`resume()` honours a working directory** via `opts.extra.cwd` (U6).
- **`package.json` `files`** is now exactly `["dist"]` (U8).
