# Changelog

## Unreleased

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
