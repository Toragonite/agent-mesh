# Adapters

Each adapter drives one vendor's **own official CLI**, under your own login, and
maps it onto the [Adapter contract](/guide/architecture). Install only the ones you
use.

## Status

| Adapter | Package | CLI it drives | Status |
|---|---|---|---|
| Claude Code | [`@toragonite/agent-mesh-claude`](https://www.npmjs.com/package/@toragonite/agent-mesh-claude) | `claude` | ✅ published |
| Codex | [`@toragonite/agent-mesh-codex`](https://www.npmjs.com/package/@toragonite/agent-mesh-codex) | `codex` | ✅ published |
| Antigravity | [`@toragonite/agent-mesh-gemini`](https://www.npmjs.com/package/@toragonite/agent-mesh-gemini) | `agy` | ✅ published |
| Cursor | [`@toragonite/agent-mesh-cursor`](https://www.npmjs.com/package/@toragonite/agent-mesh-cursor) | `cursor-agent` | ✅ published |

All four adapters are implemented and verified against their vendor's CLI, and
all publish together with core on the same release. Antigravity and Cursor are
the newest of the four, so their per-model latency classes are still provisional.

## Capabilities

All adapters support one-shot `run()`, `resume()` by conversation id, and token
usage (the mandatory surface). The rest is declared per adapter via
`capabilities`:

| Adapter | resume | steer | peerMesh | quota | stream |
|---|---|---|---|---|---|
| Claude Code | ✅ | `mid-run` | ✅ | ✅ | ✅ |
| Codex | ✅ | `turn` | — | ✅ | — |
| Antigravity | ✅ | `turn` | — | ✅ | ✅ |
| Cursor | ✅ | `turn` | — | ✅ | ✅ |

Antigravity reports `quota: true` — `quota()` runs `agy -p /usage`, which the CLI
answers with its own login and no agent turn, and returns the four usage windows
(`gemini-weekly`, `gemini-5h`, `3p-weekly`, `3p-5h`), or `null` on any failure
(see its Quota section).

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
resume-by-conversation-id. `quota()` reads the account's plan usage through `agy -p /usage`. See the
[Antigravity adapter page](/adapters/gemini).

## Cursor

Cursor's CLI, driving a live-and-memoized catalog of Cursor-native and resold
models (Composer, Grok, and more). Headless runs default to `trust: true` so a
workspace-trust prompt never stalls a run. `quota()` reads the current billing
period's usage (Total / Auto / API) with the CLI's login token. See the
[Cursor adapter page](/adapters/cursor).

::: warning Unofficial
agent-mesh is not affiliated with Anthropic, OpenAI, Google, or Cursor. Each
adapter uses that vendor's official CLI under your own account; you remain subject
to that vendor's terms.
:::
