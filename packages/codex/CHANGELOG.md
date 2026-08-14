# Changelog

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
