# Changelog

## 0.1.4

- **Per-user usage working directory:** `quota()` ran `agy -p /usage` in
  `<os tmpdir>/agent-mesh-agy-usage`, one name for every local user. On Linux with `TMPDIR` unset
  that is the shared `/tmp`, so a directory another user had created there (by running their own
  reads, or deliberately) was — correctly — refused as not private, and this user's `quota()` was
  `null` for good. The directory is now per user: `agent-mesh-agy-usage-<uid>`, or, where the
  platform has no uid (Windows), `agent-mesh-agy-usage-<username>` (characters outside
  `[A-Za-z0-9._-]` replaced by `_`, at most 64; `user` when there is none). The privacy checks are
  unchanged: a real directory, not a symlink, owned by this user, mode `0700` — otherwise the read
  is `null` and nothing is spawned.

## 0.1.3

The turn lane. Measured on agy 1.3.6.

- **`resumeId` → `--conversation <id>`** on `run()` and `stream()`; `--mode` is passed again on
  every turn and the prompt always directly follows `-p`. No `--print-timeout` is passed (print
  mode waits for the turn by default).
- **`elevated: true` → `--dangerously-skip-permissions`**, never added otherwise. agy print mode
  calls MCP tools only under this flag (it also approves every shell command): the caller writes
  `<cwd>/.agents/mcp_config.json`, and an `mcp` attachment without `elevated` adds a note saying its
  tools will not be called.
- **`session` event** from `init`'s `conversation_id` (and from a step's or the terminal payload's
  when it differs). For an unknown id agy prints `warning: conversation "…" not found` and SILENTLY
  starts a new conversation: the `session` id then differs from `resumeId`. With no id reported,
  the result falls back to `resumeId`, as `resume()` does.
- **One terminal event:** lines after the terminal payload are drained but emit nothing; no `error`
  after `done`.
- **`RunOptions`:** `lineStream` is the only seam the run spawns through; `env` is the child's whole
  environment, used verbatim (no `AGY_HOME` of the adapter's own; an explicit `account.configDir`
  it displaces is noted).
- `appendSystemPromptFile`: no agy flag — the content is prefixed to the `-p` value, with a note,
  read through the new `readTextFile` constructor seam. `sessionId`, `disallowedTools`,
  `settingSources` and `mcp.projectConfigFile` are ignored with a note; `unattended` needs nothing.
  Invalid turn-lane fields throw before anything is spawned.
- `interactiveResume()` returns `undefined` (no interactive take-over in this release).
- **Process seam:** `ExecRequest.onSpawn` / `SpawnedProcess`, `interruptLadder()` and
  `execOverLineStream()`, exported from the entry.

All five packages move in lockstep (0.1.2 was never published to npm); this package now depends on
`@toragonite/agent-mesh@^0.1.3`.

## 0.1.2

`quota()` now reports Antigravity usage (it returned `null` by design), and
`capabilities.quota` is `true`.

- **Added: usage from `agy -p /usage`.** agy (≥ 1.1.11) answers its own `/usage`
  command in print mode — `agy -p /usage --output-format json` — with no agent turn and
  no quota spent, fetching the numbers with its own login; this library touches no
  token. One window per enabled bucket, groups then buckets in order (`gemini-weekly`,
  `gemini-5h`, `3p-weekly`, `3p-5h` on agy 1.3.5): `label` is the bucket id (else
  `<group name> <window>`), `usedPercent` is `(1 − remaining_fraction) × 100` rounded to
  one decimal and clamped to 0..100, `resetAt` is the RFC 3339 `reset_time` as ISO. A
  disabled bucket, a bucket with only `remaining_amount` (or neither — an amount of 0
  with no fraction is unknown, not exhausted), and a fraction above 1 are left out.
  `allowed` is derived (no window at 100%); `raw` is `command.data`. Any failure — not
  logged in, an API-key/ADC session, a non-zero exit, an `AGY_ERROR:` / `error:` line,
  a status other than `SUCCESS`, another shape, no usable bucket, more than 1 MiB of
  stdout, the timeout — resolves `null`. The child runs through the `exec` seam with
  `run()`'s account env, stdin on `/dev/null`, and a private cwd
  (`<os tmpdir>/agent-mesh-agy-usage`, 0700; refused when not private). New options:
  `quotaTimeoutMs` (default 90 s; the whole process group is killed at it) and
  `quotaCacheMs` (default 60 s; the outcome, snapshot or `null`, is reused per account).
  At most one read per account is in flight per adapter instance.
- **Added: two optional process-seam fields.** `ExecRequest.ignoreStdin` (the child's
  stdin is the null device, not a pipe) and `ExecRequest.maxStdoutBytes` (`nodeExec`
  stops the child's process group past it and sets `ExecResult.stdoutOverflow`). Both
  are additive: a host's own `exec` that ignores them still works, and the adapter
  re-checks the stdout size itself.
- **Note: Antigravity account isolation — NOT provided by agy 1.3.5; all accounts share
  the default login.** The agy 1.3.5 binary contains no `AGY_HOME` string, so the
  `AGY_HOME` the adapter sets for `account.configDir` is not read: every account runs on
  — and `quota()` reports the usage of — agy's default login, whose keychain item is
  fixed. The note on results now says so (it said isolation was "unverified").

All five packages move in lockstep, so this package is bumped to 0.1.2 with the Codex
and Cursor quota fixes.

## 0.1.1

No runtime changes in this package — the published tarball is identical to 0.1.0 apart from
the version number. This release exists so the documentation site can build and deploy: the
workspace root has no `"type": "module"`, so the VitePress config was loaded through the
CommonJS path and the ESM-only VitePress build failed. Renaming the config to
`docs/.vitepress/config.mts` fixes it. All five packages move in lockstep, so this package
is bumped to 0.1.1 with the rest.

## 0.1.0

Initial release. The Google Antigravity adapter for agent-mesh, driving the official `agy` CLI
behind the frozen `Adapter` contract:

- `run()` — one-shot `agy --output-format json -p`, with tolerant last-JSON-object parsing.
- `resume()` — continue a conversation by id via `agy --conversation <id>`.
- `stream()` — incremental `RunEvent`s over `agy --output-format stream-json`.
- `authStatus()` — login check through the only probe Antigravity exposes, `agy models`.
- `availableModels()` — a fast, static 11-model catalog (no subprocess on the routing path).
- `fetchLiveModels()` — the authoritative-but-slow live model probe; `[]` on any failure.
- `quota()` — `null` by design (Antigravity exposes no verified usage endpoint).
- Single trailing-newline normalization for cross-vendor comparability; `allowedTools` ignored
  with a note; `account.configDir` passed as `AGY_HOME` (isolation unverified).

Fixes from an adversarial review. Several change caller-visible behaviour:

- `resume()` now falls back to the (trimmed) conversation id you passed when the vendor echoes an
  empty `conversation_id`, so a resumed conversation stays resumable. `run()` is unchanged — an
  empty id there still means the vendor genuinely returned none.
- Streamed `text` deltas hold a single trailing newline back and drop it at end of stream, so the
  concatenation of all `text` events now equals `done.text` exactly (previously it carried one
  extra trailing newline). Interior newlines are untouched.
- `stream()` now recognizes a terminal payload that arrives **unwrapped** — a bare object carrying
  `status`/`response`, as the error path and older CLI generations emit — and maps it to a `done`
  event through the same mapper `run()` uses, instead of ending with no `done` event.
- The `resume()` conversation id is trimmed before it reaches the CLI (no more leading/trailing
  spaces forwarded to the vendor).
- The model is trimmed before use; a whitespace-only model is treated as absent (no `--model`, no
  note). A non-empty model is matched against the catalog after trimming.
- `usage.totalTokens` falls back to `inputTokens + outputTokens` when the vendor omits
  `total_tokens` and both are present; otherwise it is omitted.
- A `null` or otherwise non-object `account` is treated as absent (falls back to the default
  account) instead of raising.
- Dropped non-string `extra.args` entries now add an `extra.args contained N non-string
  entr(y|ies); dropped` note instead of being filtered silently.
- `resume()` honours a string `opts.extra.cwd` as the child's working directory.
- `package.json` `files` is now exactly `["dist"]`.
