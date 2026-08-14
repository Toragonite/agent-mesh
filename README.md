# agent-mesh

**Drive Claude Code, Codex, Antigravity (Gemini), and Cursor coding agents as
headless workers behind one interface.**

agent-mesh gives you a single, vendor-neutral contract for spawning, revising,
streaming, and quota-routing coding agents — each driven through the vendor's own
official CLI under your own login. Write to the `Adapter` interface once; let the
`Fleet` route each task to whichever vendor has strength and headroom.

> **Unofficial.** agent-mesh is not affiliated with, endorsed by, or supported by
> Anthropic, OpenAI, Google, or Cursor. Every adapter drives the vendor's official
> CLI under your own login — no socket impersonation, no credential sharing, no
> rate-limit circumvention.

## Packages

| Package | Vendor | Status |
| --- | --- | --- |
| [`@toragonite/agent-mesh`](https://www.npmjs.com/package/@toragonite/agent-mesh) | core — the `Adapter` contract + `Fleet` router | ✅ published |
| [`@toragonite/agent-mesh-claude`](https://www.npmjs.com/package/@toragonite/agent-mesh-claude) | Claude Code | ✅ published |
| [`@toragonite/agent-mesh-codex`](https://www.npmjs.com/package/@toragonite/agent-mesh-codex) | Codex (OpenAI) | ✅ published |
| [`@toragonite/agent-mesh-gemini`](https://www.npmjs.com/package/@toragonite/agent-mesh-gemini) | Antigravity (Gemini) | ✅ published |
| [`@toragonite/agent-mesh-cursor`](https://www.npmjs.com/package/@toragonite/agent-mesh-cursor) | Cursor | ✅ published |

## Quickstart

```sh
npm install @toragonite/agent-mesh \
            @toragonite/agent-mesh-claude \
            @toragonite/agent-mesh-codex
```

```ts
import { Fleet } from '@toragonite/agent-mesh';
import { ClaudeAdapter } from '@toragonite/agent-mesh-claude';
import { CodexAdapter } from '@toragonite/agent-mesh-codex';

const fleet = new Fleet()
  .register(new ClaudeAdapter())
  .register(new CodexAdapter());

const result = await fleet.run(
  { prompt: 'Summarize the README in one sentence.', cwd: process.cwd() },
  { policy: { prefer: ['claude', 'codex'], strategy: 'most-quota' } },
);

console.log(`[${result.vendor}] ${result.text}`);
```

Each adapter runs the vendor's official CLI, so the corresponding CLI must be
installed and logged in. Quota and model reads run in your own runtime and are
never proxied; tokens are never logged.

## Documentation

Full guide, adapter references, and routing docs:
**<https://toragonite.github.io/agent-mesh/>**

## License

[MIT](LICENSE) © 2026 Toragonite
