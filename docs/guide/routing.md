# Routing

The `Fleet` picks which adapter (and account) runs a task. Routing is a policy over
three signals every adapter can report: **quota headroom**, **domain strength**,
and **latency class**.

```ts
const result = await fleet.run(
  { prompt: 'Refactor this module.' },
  { policy: { prefer: ['claude', 'codex'], quotaCeiling: 80 } },
)
```

## The signals

- **Quota headroom** — skip an account whose window is near its limit
  (`quotaCeiling`), so a long session doesn't exhaust one login while others sit
  idle. Reads come from each adapter's `quota()`.
- **Strength** — a preference order per domain. The default is a static
  `prefer` list; a task can override it.
- **Latency** — `fast` vs `slow` models, from `availableModels()`. Interactive
  work prefers `fast`; deep reasoning tolerates `slow`.

## Strategies

The router ships more than one strategy, chosen by policy:

- **`prefer-order`** (default) — walk the preference list; the first adapter that
  passes the quota gate wins.
- **`most-quota`** — pick the adapter with the most remaining headroom right now.
- **`lowest-latency`** — pick the fastest eligible model.

::: tip Design note
The default strategy is deliberately simple and predictable. Which strategy should
be the default — and the exact domain→vendor strength map — is a product decision
still being tuned. See the design notes in the repository.
:::

## When everything is gated

If every candidate is over its quota ceiling, the router falls back to the first
preference rather than failing — a best-effort run beats a hard stop mid-workflow.
The fallback is annotated only on `RouteDecision.note`, returned by `route()`;
`Fleet.run()` resolves straight to a `RunResult` and discards it. If you need to
know a run was a gated fallback, call `route()` yourself and run the chosen
adapter directly:

```ts
const decision = await fleet.route(task, { prefer: ['claude', 'codex'], quotaCeiling: 80 })
if (decision.note) {
  console.warn(decision.note) // e.g. all candidates gated, best-effort fallback
}
const result = await decision.adapter.run(task)
```

## `permissionMode` is vendor-specific

`RunTask.permissionMode` passes straight through to the underlying CLI, and each
vendor defines its own vocabulary — Claude Code expects values like
`'acceptEdits'`, Codex expects sandbox modes like `'workspace-write'`. A
Fleet-routed task that sets `permissionMode` is therefore not portable across
vendors: a value that succeeds on one adapter can error on another. Set it only
alongside a pinned `task.account` (a specific vendor), not on a task left open to
routing across more than one.
