# Changelog

All notable changes to **@toragonite/agent-mesh** are documented here. This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
