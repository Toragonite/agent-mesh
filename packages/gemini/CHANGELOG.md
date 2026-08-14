# Changelog

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
