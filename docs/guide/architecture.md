# Architecture

agent-mesh is a **thin core** plus **per-vendor adapters**. The core knows nothing
vendor-specific; each adapter teaches the core how to drive one vendor's official
CLI.

## The five common surfaces

Every headless coding agent worth orchestrating exposes the same shape. That shape
— not any single vendor — is what the `Adapter` interface freezes:

| Surface | Method |
|---|---|
| One-shot run → final text + conversation id | `run(task)` |
| Continue / revise an existing conversation | `resume(id, message)` |
| Token usage per run | `RunResult.usage` |
| How much quota is left | `quota(account)` |
| Which models the current login may select | `availableModels(account)` |

Two capabilities are optional and declared per adapter: mid-run **steer** and
native **peer mesh**.

## The Adapter interface

```ts
interface Adapter {
  readonly vendor: Vendor
  readonly capabilities: AdapterCapabilities

  authStatus(account?: Account): Promise<AuthStatus>
  availableModels(account?: Account): Promise<ModelInfo[]>
  quota(account?: Account): Promise<QuotaSnapshot | null>

  run(task: RunTask): Promise<RunResult>
  resume(conversationId: string, message: string, opts?: ResumeOptions): Promise<RunResult>

  stream?(task: RunTask): AsyncIterable<RunEvent>
  steer?(conversationId: string, message: string): Promise<void>
  stop?(conversationId: string): Promise<void>
}
```

`quota()` returns `null` when a value is genuinely unknown (not logged in, endpoint
unavailable) — it never throws for "unknown". That keeps routing decisions simple:
no snapshot means "can't confirm headroom", not "crash".

## Capabilities describe what an adapter can do — the caller checks them

```ts
interface AdapterCapabilities {
  resume: boolean
  steer: 'mid-run' | 'turn' | 'none'
  peerMesh: boolean
  quota: boolean
  stream: boolean
}
```

The Fleet itself never reads `capabilities` — routing is driven only by quota
headroom, `policy.prefer` order, and `policy.latency` (see
[Routing](/guide/routing)). Whether the chosen adapter can actually steer mid-run
or stream is the **caller's** concern: check `capabilities.steer === 'mid-run'` /
`capabilities.stream` yourself — or use the `canSteer`/`canStream` type guards
exported from `@toragonite/agent-mesh` — before calling `steer()` or `stream()`,
and fall back to `resume()` when an adapter can't do true mid-run steering.

## Accounts and isolation

An `Account` names a login, optionally with an isolated config dir (e.g.
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Omit it to use the ambient CLI login. One
vendor can have several accounts, each with its own quota — which is the point.
