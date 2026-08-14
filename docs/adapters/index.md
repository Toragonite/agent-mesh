# Adapters

Each adapter drives one vendor's **own official CLI**, under your own login, and
maps it onto the [Adapter contract](/guide/architecture). Install only the ones you
use.

## Status

| Adapter | Package | CLI it drives | Status |
|---|---|---|---|
| Claude Code | `@toragonite/agent-mesh-claude` | `claude` | ✅ v0.1.0 |
| Codex | `@toragonite/agent-mesh-codex` | `codex` | ✅ v0.1.0 |
| Antigravity | `@toragonite/agent-mesh-gemini` | `agy` | ✅ v0.1.0 |
| Cursor | `@toragonite/agent-mesh-cursor` | `cursor-agent` | ✅ v0.1.0 |

All four adapters are implemented and verified against their vendor's CLI, and
all publish together with core at v0.1.0. Antigravity and Cursor are the
newest of the four, so their per-model latency classes are still provisional.

## Capabilities

All adapters support one-shot `run()`, `resume()` by conversation id, and token
usage (the mandatory surface). The rest is declared per adapter via
`capabilities`:

| Adapter | resume | steer | peerMesh | quota | stream |
|---|---|---|---|---|---|
| Claude Code | ✅ | `mid-run` | ✅ | ✅ | ✅ |
| Codex | ✅ | `turn` | — | ✅ | — |
| Antigravity | ✅ | `turn` | — | — | ✅ |
| Cursor | ✅ | `turn` | — | — | ✅ |

Antigravity and Cursor both report `quota: false` — neither vendor exposes a
verified usage endpoint, so `quota()` returns `null` by design instead of
fabricating a snapshot (see each adapter's Quota section).

## Claude Code

Anthropic's CLI. The only adapter with native **peer mesh** — sessions can wake and
steer each other directly. Absorbs the earlier `@toragonite/claude-mesh` work. See
the [Claude Code adapter page](/adapters/claude-code).

## Codex

OpenAI's CLI. Turn-based steer via `resume()`. Model selection depends on auth
mode: a ChatGPT login and an API key expose different model sets, which
`availableModels()` reflects. See the [Codex adapter page](/adapters/codex).

## Antigravity

Google's consumer coding agent (`agy`). A static model catalog (three entries
resell other vendors' models), `stream()` support, and revision via
resume-by-conversation-id. `quota()` returns `null` by design. See the
[Antigravity adapter page](/adapters/gemini).

## Cursor

Cursor's CLI, driving a live-and-memoized catalog of Cursor-native and resold
models (Composer, Grok, and more). Headless runs default to `trust: true` so a
workspace-trust prompt never stalls a run. `quota()` returns `null` by design.
See the [Cursor adapter page](/adapters/cursor).

::: warning Unofficial
agent-mesh is not affiliated with Anthropic, OpenAI, Google, or Cursor. Each
adapter uses that vendor's official CLI under your own account; you remain subject
to that vendor's terms.
:::
