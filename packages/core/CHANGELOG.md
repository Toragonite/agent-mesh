# Changelog

All notable changes to **@toragonite/agent-mesh** are documented here. This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.4

One additive type change; no runtime changes.

- **`McpServerStatus`** — `{ name: string; status: string }`: one MCP server's connection state
  as the vendor's own stream reported it at the start of a run. `status` is the vendor's word
  (Claude Code: `connected`, `failed`, `needs-auth`, `pending`, …); treat an unknown one as "not
  known to be connected".
- **`RunEvent` `session` gains `mcpServers?: ReadonlyArray<McpServerStatus>`**, and
  **`RunResult` gains `mcpServers?`** (on a streamed run's `done` result). Both optional: absent
  means "not reported", and adapters that never set them are unaffected. The Claude adapter fills
  them from Claude Code's `system/init` line.

This release also carries a Codex spawn seam for the model listing and an Antigravity usage-read
fix (`@toragonite/agent-mesh-codex`, `@toragonite/agent-mesh-gemini`). All five packages move in
lockstep, so this package is bumped to 0.1.4 with the rest.

## 0.1.3

Additive: what a host needs to drive a coding agent as a series of headless **turns** that
resume one conversation, on all four vendors. Every addition is optional; an adapter written
against 0.1.2 still satisfies `Adapter`.

- **`RunTask` turn-lane fields:** `resumeId` (continue a conversation — honoured by `run()` and
  `stream()`), `sessionId` (start one under a chosen id where the CLI can; exclusive with
  `resumeId`), `appendSystemPromptFile`, `unattended`, `mcp`, `disallowedTools`,
  `settingSources`, `elevated`. Each adapter maps them to its CLI's own flags and notes the ones
  its CLI has no equivalent for; an invalid value throws before anything is spawned.
- **`McpAttachment`** — `{ name, command, args, configFile, projectConfigFile? }`: one stdio MCP
  server attached to a single run.
- **`RunOptions`** — the optional second argument of `run()` and `stream()`: `lineStream` (the
  spawn seam every process of the run goes through), `env` (the complete child environment, used
  as is; the adapter adds no account variable), `skipAuthCheck`.
- **`SpawnRequest`, `StreamEndMeta`, `LineStreamFn`** — the line-seam types `RunOptions.lineStream`
  uses; structurally the same as each adapter package's own `ExecRequest` / `StreamEndMeta` /
  `LineStreamFn`.
- **`RunEvent` `{ type: 'session', conversationId }`** — the conversation id as the vendor's own
  stream reported it, never synthesized from `sessionId` / `resumeId`. A stream ends with exactly
  one `done` or `error`. Note for consumers: an exhaustive `switch` over `RunEvent` sees one more
  member, and a test that pins an exact event sequence now sees a `session` event wherever the CLI
  reports an id.
- **`Adapter.interactiveResume?(conversationId, account?)`** → `InteractiveResumeSpec | undefined`
  (`{ command, args, env, unsetEnv?, verified }`): the command line that opens the vendor's
  interactive terminal on a conversation. Nothing is spawned.
- `Adapter.run()` and `Adapter.stream()` take the optional `opts?: RunOptions`.

0.1.2 was never published to npm; its changes (below) ship in this release. All five packages
move in lockstep, and the adapters now depend on `@toragonite/agent-mesh@^0.1.3`, because their
type declarations use these types.

## 0.1.2

One additive type change; no runtime changes.

- **`ModelInfo.efforts?: string[]`** — the reasoning-effort levels the vendor's own model
  list says a model accepts (e.g. `'low'`, `'medium'`, `'high'`), in the vendor's order.
  Optional: an absent field means "not reported", and adapters that never set it are
  unaffected. The Codex adapter fills it from `codex app-server`'s `model/list`.

This release also carries the Codex and Cursor quota fixes and the Codex live model list
(`@toragonite/agent-mesh-codex`, `@toragonite/agent-mesh-cursor`). All five packages move
in lockstep, so this package is bumped to 0.1.2 with the rest.

## 0.1.1

No runtime changes in this package — the published tarball is identical to 0.1.0 apart from
the version number. This release exists so the documentation site can build and deploy: the
workspace root has no `"type": "module"`, so the VitePress config was loaded through the
CommonJS path and the ESM-only VitePress build failed. Renaming the config to
`docs/.vitepress/config.mts` fixes it. All five packages move in lockstep, so this package
is bumped to 0.1.1 with the rest.

## 0.1.0

Initial release. The vendor-neutral core of agent-mesh: the frozen `Adapter` contract every
vendor package implements, the shared data contract and error hierarchy, and the `Fleet`
router. The core holds no vendor knowledge — it drives adapters only through the contract.

- **The frozen `Adapter` contract** — one interface every vendor adapter implements. Mandatory
  surface: `authStatus()`, `availableModels()`, `quota()`, `run()`, and `resume()`; optional
  surface advertised through `capabilities`: `stream()`, `steer()`, and `stop()`. Each adapter
  carries a `vendor` id and an `AdapterCapabilities` record. `canSteer()` / `canStream()` type
  guards (and the `SteerableAdapter` / `StreamingAdapter` types) narrow an adapter to its
  optional surface.
- **The data contract** — `RunTask`, `RunResult`, `ResumeOptions`, `RunEvent`, `Account`,
  `AuthStatus`, `ModelInfo`, `QuotaWindow`, `QuotaSnapshot`, `TokenUsage`, and the
  `Vendor` / `LatencyClass` / `SteerMode` / `RunStatus` / `AdapterCapabilities` types. `Vendor`
  is an open union — the four vendor names autocomplete, but a third-party adapter can register
  any id without a core release. `quota()` returns `null` for genuinely-unknown headroom (never
  throws for "unknown"), and `QuotaSnapshot.allowed` is the rate-limit gate.
- **The error hierarchy** — `AgentMeshError` is the base every error extends (carrying the
  `vendor` when known); `AuthError`, `QuotaExceededError`, `AdapterExecError` (with `exitCode`
  and `stderr`), and `NoRouteError` derive from it.
- **The `Fleet` router** — registers adapters by vendor and routes a `RunTask` across them
  through `route()` (choose without running) and `run()` (route, unless the task pins an
  account, then run), plus `resume()`, `quotas()`, and the `register` / `get` / `list`
  accessors. Three strategies:
  - `prefer-order` (default) — walk `policy.prefer` order; the first candidate past the gates
    wins.
  - `most-quota` — pick the candidate with the most remaining headroom (lowest worst-window
    usage; unknown headroom sorts last).
  - `lowest-latency` — prefer candidates offering a `fast` model (or `policy.latency`'s class),
    then prefer-order.
- **Quota gating** — `quotaCeiling` (default 100) skips a candidate whose worst quota window
  exceeds the ceiling. An explicit `allowed: false` snapshot is a HARD rate-limit gate that
  disqualifies a candidate independent of the ceiling; a `null` snapshot (unknown headroom)
  passes. When every candidate is gated, the router falls back best-effort to one and surfaces
  a `note` rather than throwing.
- **Latency filtering** — `RoutePolicy.latency` restricts routing to adapters offering a model
  of that class and applies to EVERY strategy (the `lowest-latency` strategy defaults it to
  `fast`). It is soft: when no candidate qualifies, the preference is ignored rather than
  emptying the pool. `NoRouteError` is raised only when no adapter matches the policy at all.
