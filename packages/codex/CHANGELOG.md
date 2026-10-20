# Changelog

## 0.1.4

- **Injectable spawner for the model listing:** the `codex app-server` session behind
  `availableModels()` used to start its process with `child_process.spawn` directly — the one
  process this adapter started outside a seam, so a host could not stub (or track) it. New
  optional `spawn` on `CodexAdapterOptions` and on `fetchLiveModels()` options, typed `SpawnFn`
  (the shape of `child_process.spawn`, which is the default) and returning a `SpawnedChild` (the
  part of a `ChildProcess` the listing uses). It is called once as
  `spawn(<binary>, ['app-server'], { env, shell: false, detached: true, stdio: 'pipe'×3 })`. With
  the default, a failure or the deadline still kills the app-server's whole process group; with
  an injected spawner, only the child it returned is killed (`child.kill('SIGKILL')`). A spawner
  that throws, or returns a child without its pipes, yields the static list like any other failure.
- Tests: the timeout tests of the live model listing use multi-second budgets, so a loaded
  machine no longer flakes them.

## 0.1.3

`stream()` and the turn lane. Measured on codex-cli 0.162.1.

- **`stream()`** over `codex exec --json`; `capabilities.stream` is now `true`. Events: `session`
  (the `thread.started` id — the CLI's own report, never `resumeId` echoed back), one `tool` per
  tool-ish item (`command_execution`, `file_change`, an MCP call as `mcp__<server>__<tool>`, …;
  reasoning items emit nothing), `text` per completed agent message, then `usage` and exactly one
  `done` carrying the same `RunResult` `run()` maps from the same output — or one `error` where
  `run()` would throw (a spawn failure; a non-zero exit with nothing parsed, with its stderr
  tail). New `lineStream` constructor seam (default: the real line streamer). Internally the JSONL
  parser now reads one line at a time; `run()`'s mapping is unchanged.
- **Resumed turns:** `resumeId` → `codex exec resume <id> --json --model <m> … -- <prompt>`. A
  resume REQUIRES a model — without one, `codex exec resume` runs the model named in
  `config.toml`, which may no longer exist — so `resumeId` without `model` throws
  `Codex resume needs a model (-m): …` before anything is spawned. `exec resume` takes no
  `--sandbox`: `permissionMode` becomes `-c sandbox_mode="<mode>"` (the thread's sandbox carries
  over). With no thread id in the output the result falls back to `resumeId`, as `resume()`
  always has. `resume()` itself is unchanged.
- **MCP:** `mcp` → `-c mcp_servers.<name>.command="…"`, `-c mcp_servers.<name>.args=[…]` and
  `-c mcp_servers.<name>.default_tools_approval_mode="approve"`, spelled as TOML strings
  (backslashes and quotes escaped; control characters refused). Without the approval mode every MCP
  call is refused under the exec approval policy. No `env` table: a codex MCP child gets a filtered
  environment, so the server's identity travels in `args`.
- **`RunOptions`:** `lineStream` is the only seam the run spawns through; `env` is the child's whole
  environment, used verbatim (no `CODEX_HOME` of the adapter's own), and the model gate then reads
  the login of that environment's `CODEX_HOME` / `OPENAI_API_KEY`; `skipAuthCheck` skips the login
  read (only the off-catalog note remains).
- `appendSystemPromptFile`: codex has no system-prompt flag — the file's content is prefixed to the
  prompt, with a note (an unreadable file, or one over 256 KiB, is refused). `sessionId`,
  `disallowedTools`, `settingSources`, `elevated` and `mcp.projectConfigFile` are ignored with a
  note; `unattended` needs nothing.
- New constructor option `skipGitRepoCheck` (default `false`): `--skip-git-repo-check` on every
  run that starts a thread, never on a resume.
- `interactiveResume()` returns `undefined` (no interactive take-over in this release).
- **Process seam:** `ExecRequest.onSpawn` / `SpawnedProcess`, `interruptLadder()` (SIGINT to the CLI
  process only — a group SIGINT does not stop a codex turn — then SIGTERM and SIGKILL to the group)
  and `execOverLineStream()`, exported from the entry.

All five packages move in lockstep (0.1.2 was never published to npm); this package now depends on
`@toragonite/agent-mesh@^0.1.3`.

## 0.1.2

`quota()` reads the live usage body again. It had returned `null` for every account.

- **Nested `rate_limit` shape:** the `wham/usage` body nests the rate-limit fields
  under `rate_limit` — `rate_limit.primary_window` / `rate_limit.secondary_window`,
  each with `used_percent`, `limit_window_seconds`, `reset_after_seconds`, and
  `reset_at` (epoch seconds), beside `rate_limit.allowed` / `rate_limit.limit_reached`
  and a top-level `plan_type` / `credits`. The adapter looked for the windows at the
  top level only, so it never recognized a reading. They are now read from
  `rate_limit`; the older top-level shape is still read as a fallback when the body
  carries no recognized `rate_limit`. Windows keep the labels `primary` / `secondary`,
  and `raw` keeps the whole body.
- **`resetAt`:** from `reset_at` (epoch seconds, or milliseconds when ≥ 1e12), else
  the capture time plus `reset_after_seconds` when that is a finite non-negative
  number, else absent. An epoch of 0 or below is an unset field, no longer a 1970 reset.
- **`allowed`:** `rate_limit.allowed` when it is a boolean, else the inverse of
  `rate_limit.limit_reached` when that is, else derived (no window at 100%).
- **Body read bounded:** the response body is now raced against the same
  `quotaTimeoutMs` deadline as the request, so a response whose body never ends
  resolves `null` in time instead of stalling `Fleet.route()`.

`availableModels()` now lists the models the CLI itself offers the account.

- **Live listing:** one `codex app-server` session with the account's `CODEX_HOME`
  (`initialize` → `initialized` → `model/list`, following `nextCursor` for at most 10
  pages), ended by closing the app-server's stdin; it counts only when the app-server
  then exits by itself. Each entry becomes a `ModelInfo` with `id`, `label` (the
  display name, when it differs), `default` (`isDefault`), and the new `efforts`
  (`supportedReasoningEfforts[].reasoningEffort`). The child env drops every
  `ANTHROPIC_*` / `CLAUDE_*` / `CLAUDECODE` variable.
- **Never a throw, never a hang:** a spawn error, a JSON-RPC error, a malformed line,
  an early or non-zero exit, or the new `modelsTimeoutMs` deadline (default 15s — the
  app-server's process group is killed at it) falls back to the static catalog. A
  successful listing is memoized per `CODEX_HOME`; a failed one is retried after the
  new `modelsCacheMs` (default 60s), so routing never spawns per call.
- **`fetchLiveModels()`** (new export, like the Antigravity adapter's): the same
  listing on its own, `[]` on any failure. `STATIC_MODELS` is exported too.
- **Static catalog updated** to what `codex app-server` listed on 2026-10-14:
  `gpt-6.1-sol` (now marked the default), `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`,
  `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, plus the unchanged API-key-only
  `gpt-5.1-codex-max` and `gpt-5.2`. `gpt-5.5` is no longer listed; naming it still
  runs, with the usual "not in known catalog" note. Auth-mode gating is unchanged.

All five packages move in lockstep, so the others are bumped to 0.1.2 with this one.

## 0.1.1

No runtime changes in this package — the published tarball is identical to 0.1.0 apart from
the version number. This release exists so the documentation site can build and deploy: the
workspace root has no `"type": "module"`, so the VitePress config was loaded through the
CommonJS path and the ESM-only VitePress build failed. Renaming the config to
`docs/.vitepress/config.mts` fixes it. All five packages move in lockstep, so this package
is bumped to 0.1.1 with the rest.

## 0.1.0

Initial release.

- `CodexAdapter` implementing the agent-mesh `Adapter` contract against the
  official `codex` CLI.
- `run()` / `resume()` via `codex exec --json`, with tolerant JSONL parsing of
  conversation id, final agent text, token usage, and model.
- Auth-mode-aware `availableModels()` (ChatGPT-login vs API-key gating).
- `authStatus()` for API-key and ChatGPT-login modes (email surfaced as detail,
  never a token).
- `quota()` reading the backend usage endpoint in the user's own runtime;
  returns `null` on any failure and never emits the bearer token.
- Injectable `exec` / `readTextFile` / `fetchFn` / `env` seams; fully hermetic
  test suite (no real CLI, network, or home directory).

### Fixes from adversarial review

- **quota account header:** `quota()` sends `chatgpt-account-id` (the plain
  workspace UUID from `tokens.account_id`) alongside the bearer — a live read
  on a real login returned null without it (bearer-only requests are rejected
  for multi-workspace accounts).
- **auth by value, not file presence:** `authStatus()` now reports `chatgpt` only
  when `auth.json` carries a real bearer (`tokens.access_token`/`id_token`),
  reports `api-key` for an `OPENAI_API_KEY` embedded in `auth.json`, and reports
  logged out for a token-less/key-less file (e.g. `{}`, `{tokens:null}`).
- **argv flag injection closed:** `run()`/`resume()` fence the prompt/message
  positional with `--`, and `resume()` rejects a flag-shaped `conversationId`
  (leading `-`, e.g. `--last`) before spawning.
- **model validation:** `run()`/`resume()` gate `task.model` against the login —
  an api-key-only model under a ChatGPT login throws before spawn; an off-catalog
  id runs anyway and adds a `RunResult.note`.
- **error precedence:** a vendor error event now resolves `status:'error'` (with
  the message in `note`) even when the CLI also exits non-zero, matching the
  claude adapter; the hard `AdapterExecError` throw is reserved for a non-zero
  exit with no parsed signal.
- **usage merge:** token usage is merged field-wise so a later partial usage no
  longer clobbers a complete `turn.completed` usage; the bare-event usage probe
  is gated to events carrying ≥2 recognized keys.
- **env seam consistency:** the child env is composed from the injected `env`
  seam (not raw `process.env`); an explicitly passed account with no `configDir`
  resolves the ambient login rather than the default account's dir.
- **quota null-safety:** `quota()` returns `null` for a 200 body with no
  recognized field instead of fabricating an allowed-with-no-windows snapshot.
- **stream/stdin robustness:** stdout/stderr are decoded as UTF-8 streams
  (multi-byte characters survive chunk boundaries); stdin is always ended and its
  errors are swallowed so a stdin-waiting or fast-exiting child cannot hang/crash.
- **timeout process-group kill:** the child is spawned `detached` and a timeout
  now signals the whole process group (`SIGTERM`, then `SIGKILL`), so a CLI that
  spawned pipe-inheriting grandchildren is reaped together; the child's stdout/
  stderr are destroyed on `exit` when timed out so `close` fires promptly instead
  of stalling on a lingering grandchild holding the pipes open.
- **defensive reads:** JSON arrays are no longer treated as records in the JSONL
  parser and auth/quota readers.
- **packaging:** per-condition `types` in `exports` (correct CJS/ESM type
  resolution), `prepublishOnly` build guard, `repository`/`homepage`/`bugs`/
  `publishConfig` metadata, and an MIT `LICENSE` file.

### Fixes from the second adversarial review

- **refusal no longer masked as success (A1):** an explicit vendor error event now
  always resolves `status:'error'` — the partial assistant text is preserved in
  `text` and the vendor's message is carried in `note`. Previously a partial
  answer alongside an error event was reported as a clean `status:'ok'` with the
  error text discarded. `AdapterExecError` stays reserved for a non-zero exit with
  nothing parseable.
- **exhausted-window quota (A2):** when a usage body omits `allowed`, it is now
  derived (`false` if any window reports ≥ 100% used, else `true`) instead of
  defaulting to `true`. An explicit `allowed` is still trusted verbatim.
- **quota fetch deadline (A3):** new `quotaTimeoutMs` constructor option (default
  10000) bounds the quota request via an `AbortSignal`; the request aborts at the
  deadline and resolves `null`, so a hung endpoint can no longer stall
  `Fleet.route()`.
- **conversation-id value semantics (U1):** `resume()` trims the `conversationId`
  first, then validates the trimmed value (empty and leading-`-` both rejected),
  and passes the trimmed id to the CLI rather than the raw string with surrounding
  whitespace.
- **empty model is absent (U2):** a provided-but-empty (whitespace-only) `model`
  is treated as "not requested" — no `--model`, no note, no auth-gate. A non-empty
  `model` is trimmed before it is gated and passed.
- **token total rule (U3):** `usage.totalTokens` uses a vendor-supplied
  `total_tokens` verbatim; otherwise it derives from `input+output` when both are
  present; otherwise it is omitted.
- **malformed account is absent (U4):** a `null` or otherwise non-object `account`
  now falls back to the default account instead of resolving ambient (or throwing).
  An account object with no `configDir` still means ambient. Applies to `run`,
  `resume`, `quota`, `authStatus`, and `availableModels`.
- **extra.args reporting (U5):** dropped non-string `extra.args` entries are now
  reported via `RunResult.note` (`extra.args contained N non-string entr(y|ies);
  dropped`).
- **resume working directory (U6):** `resume()` honours a string `extra.cwd` as
  the child's working directory (`ResumeOptions` has no `cwd` field).
- **packaging (U8):** `files` is now exactly `["dist"]`; `nodeLineStream` is
  exported from the package entry for seam parity with the streaming adapters.
