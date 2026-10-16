# @toragonite/agent-mesh-claude

The **Claude Code adapter** for [agent-mesh](https://www.npmjs.com/package/@toragonite/agent-mesh).
It drives Anthropic's official `claude` CLI as a headless worker behind the vendor-neutral
`Adapter` contract — so a `Fleet` can spawn runs, revise conversations, stream events, read
quota, and route across vendors without knowing anything Claude-specific.

It also **absorbs [claude-mesh](https://www.npmjs.com/package/@toragonite/claude-mesh)**: the
background-agent lifecycle (`spawnAgent` / `listAgents` / `stopAgent`), session discovery, the
cross-session messaging **gateway** (`MeshGateway`), and the cross-account **bridge**
(`MeshBridge`) are all re-exported and still usable on their own. The live claude.ai
plan-usage reader (`getLiveUsage`) is bundled too and backs `quota()`.

> **Unofficial.** This package shells out to your local `claude` CLI and reads local files
> under your own login. It never reads, proxies, or logs your credentials, and makes no
> network calls of its own.

## Install

```sh
npm install @toragonite/agent-mesh @toragonite/agent-mesh-claude
```

Requires Node ≥ 18.17 and the Claude Code CLI on your `PATH` (or pass a `binary` path).

## Usage

```ts
import { Fleet } from '@toragonite/agent-mesh';
import { ClaudeAdapter } from '@toragonite/agent-mesh-claude';

const fleet = new Fleet().register(new ClaudeAdapter());

// One-shot run — routed to the only registered vendor here.
const res = await fleet.run({ prompt: 'Summarize the repo README in 3 bullets.' });
console.log(res.text, res.conversationId);

// Revise the same conversation.
const followUp = await fleet.resume('claude', res.conversationId, 'Now make it 1 bullet.');
console.log(followUp.text);
```

Every seam is injectable for hermetic tests: `new ClaudeAdapter({ exec, lineStream, binary,
defaultAccount, gateway, readTextFile, getUsage, env })`. The `env` seam (default `process.env`)
is the base of the spawned child's environment: when you inject it, it becomes the child's whole
environment (plus `CLAUDE_CONFIG_DIR` for an explicit account), so introspection and execution
always resolve the same account.

## Behavior notes

- **Model selection.** Omitting `task.model` lets the **CLI choose its own default** — the adapter
  passes no `--model`, so whatever model your `claude` install defaults to is what runs.
  `availableModels()` therefore advertises **no** `default` model: the adapter never injects one on
  your behalf. Pass `task.model` to pin a model; an id outside the known catalog still runs but adds
  a `RunResult.note`.
- **Resume working directory.** `ResumeOptions` has no `cwd` field, so `resume()` reads
  `opts.extra?.cwd` when it is a string and runs the child there; otherwise it inherits the process
  working directory. Pass `resume(id, message, { extra: { cwd: '/path/to/repo' } })` to run the
  revision in the conversation's workspace.

## Turns: start, resume, and hand over a conversation (since 0.1.3)

`run()` and `stream()` take the turn-lane fields of `RunTask` and an optional `RunOptions`
second argument. Flags as measured on Claude Code 2.1.299, in the order they are emitted:

| Task field | Flag |
| --- | --- |
| `resumeId` | `--resume <id>` (continue the conversation; exclusive with `sessionId`) |
| `sessionId` | `--session-id <uuid>` (start it under this id; must be a UUID) |
| `model` | `--model <m>` — passed on every turn you give it |
| `permissionMode` | `--permission-mode <mode>` — again on every turn, resumed or not |
| `unattended` | `--permission-prompts none` (nobody can answer a prompt: it is denied) |
| `settingSources` | `--setting-sources <v>` |
| `appendSystemPromptFile` | `--append-system-prompt-file <absolute path>` (obeyed on resumed turns too) |
| `mcp` | `--mcp-config [<projectConfigFile>] <configFile> --strict-mcp-config` |
| `allowedTools` / `disallowedTools` | `--allowedTools a,b` / `--disallowedTools a,b` (one comma-joined value each) |

then `extra.args`, then `-p --output-format stream-json --verbose -- <prompt>` (`json` for
`run()`). `elevated` has no Claude equivalent and is noted. An invalid field (a blank or
`-`-leading `resumeId`, a non-UUID `sessionId`, a relative path, an invalid `mcp`) throws
`AgentMeshError` before anything is spawned — at call time for `stream()`.

```ts
const turn = claude.stream(
  {
    prompt: 'Next step.',
    resumeId: sessionId,
    permissionMode: 'acceptEdits',
    unattended: true,
    appendSystemPromptFile: '/srv/team/brief.md',
    mcp: { name: 'team', command: process.execPath, args: ['/srv/team/server.js'], configFile: '/srv/team/mcp.json' },
    allowedTools: ['mcp__team__inbox'],
    disallowedTools: ['SendMessage'],
  },
  { lineStream: mySeam, env: childEnv },
);
```

- **`session` event.** `stream()` reports the CLI's own `session_id` (normally from
  `system/init`) as `{ type: 'session', conversationId }` — once, and again only if a later line
  reports a different id. It is never synthesized from `sessionId` or `resumeId`. The stream ends
  with exactly one `done` or `error`.
- **`RunOptions.lineStream`** is the only seam the run spawns through (`run()` drains it to
  completion). **`RunOptions.env`** is the child's whole environment, used verbatim: the adapter
  sets no `CLAUDE_CONFIG_DIR` of its own and does not fall back to the `env` seam's or the
  default account's directory — compose the account's binding yourself (for the default
  `~/.claude`, leave `CLAUDE_CONFIG_DIR` unset). An explicit `account.configDir` it displaces is
  noted.
- **`interactiveResume(conversationId, account?)`** returns the command that opens the
  interactive terminal on the conversation: `{ command: <binary>, args: ['--resume', id], env,
  unsetEnv, verified: false }`. `env` / `unsetEnv` carry the config-dir binding: the host's own
  `CLAUDE_CONFIG_DIR` string when it names the account's directory; the default `~/.claude` (or an
  ambient account) as an UNSET `CLAUDE_CONFIG_DIR` — exporting the default path explicitly makes
  the CLI look logged out; any other directory verbatim. Nothing is spawned. `verified` stays
  `false` until this take-over is verified against an interactive session.
- **Interrupting a turn.** `ExecRequest.onSpawn` hands you the started child as a
  `SpawnedProcess`; `interruptLadder(proc)` sends SIGINT to the CLI process ONLY, then — if it
  has not exited — SIGTERM and SIGKILL to its process group (10 s / 5 s by default, configurable).
  A SIGINT to the whole group is never sent. `execOverLineStream(lineStream, req)` runs a child
  to completion through any line seam.

  ```ts
  import { interruptLadder, nodeLineStream, type SpawnedProcess } from '@toragonite/agent-mesh-claude';

  let proc: SpawnedProcess | undefined;
  const events = claude.stream(task, {
    lineStream: (req, onEnd) => nodeLineStream({ ...req, onSpawn: (p) => (proc = p) }, onEnd),
  });
  // later — stop the turn; the stream still ends with its done/error event:
  if (proc) interruptLadder(proc, { termAfterMs: 10_000, killAfterMs: 5_000 });
  ```

## License

MIT © Toragonite
