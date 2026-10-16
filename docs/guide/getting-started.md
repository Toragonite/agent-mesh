# Getting Started

> **Status:** the core contract is frozen. All four adapters —
> `@toragonite/agent-mesh-claude`, `@toragonite/agent-mesh-codex`,
> `@toragonite/agent-mesh-gemini`, and `@toragonite/agent-mesh-cursor` — are
> published together with core. See [Adapters](/adapters/) for details and
> current versions.

## Install

Install the core plus the adapters you need:

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-claude @toragonite/agent-mesh-codex
```

Core has no vendor dependencies. Each adapter drives that vendor's **own official
CLI**, so the corresponding CLI must be installed and logged in on the machine.

## A first run

Register more than one adapter and let the `Fleet` route the task for you:

```ts
import { Fleet } from '@toragonite/agent-mesh'
import { ClaudeAdapter } from '@toragonite/agent-mesh-claude'
import { CodexAdapter } from '@toragonite/agent-mesh-codex'

const fleet = new Fleet()
  .register(new ClaudeAdapter())
  .register(new CodexAdapter())

const result = await fleet.run(
  { prompt: 'Write a haiku about quotas.' },
  { policy: { prefer: ['claude', 'codex'] } },
)

console.log(result.vendor)          // whichever adapter actually ran it
console.log(result.text)            // the final answer
console.log(result.conversationId)  // feed this to resume()
```

`policy.prefer` walks that order and picks the first adapter whose quota is under
the ceiling (`prefer-order`, the default strategy) — see [Routing](/guide/routing)
for the other strategies.

## Revise it

```ts
const revised = await fleet.resume(
  result.vendor,
  result.conversationId,
  'Make it about rate limits instead.',
)
```

## Read remaining quota

```ts
const snapshot = await fleet.get('claude')?.quota()
// { vendor: 'claude', allowed: true, windows: [{ label, usedPercent, resetAt }] }
```

Quota reads happen in **your** runtime under **your** login — nothing is proxied.

## Next

- [Adapters](/adapters/) — install steps and options for each adapter.
- [Architecture](/guide/architecture) — the Adapter contract and capabilities.
- [Routing](/guide/routing) — how the Fleet picks a vendor per task.
