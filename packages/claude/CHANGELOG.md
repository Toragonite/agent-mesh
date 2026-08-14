# Changelog

All notable changes to **@toragonite/agent-mesh-claude** are documented here. This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1]

No runtime changes in this package — the published tarball is identical to 0.1.0 apart from
the version number. This release exists so the documentation site can build and deploy: the
workspace root has no `"type": "module"`, so the VitePress config was loaded through the
CommonJS path and the ESM-only VitePress build failed. Renaming the config to
`docs/.vitepress/config.mts` fixes it. All five packages move in lockstep, so this package
is bumped to 0.1.1 with the rest.

## [0.1.0]

Absorbed **claude-mesh** and added the agent-mesh `Adapter` implementation.

### Added
- **`ClaudeAdapter`** — the agent-mesh `Adapter` for the official `claude` CLI: `run`
  (`claude -p` one-shot JSON), `resume` (`claude --resume`), `stream`
  (`--output-format stream-json`), `quota` (via the absorbed live-usage probe), `authStatus`,
  `availableModels`, and `steer` (peer wake through a `MeshGateway`). Every side-effecting
  seam (process exec, line streaming, file reads, usage probe, gateway) is injectable.
- **`exec` seams** — `nodeExec` / `nodeLineStream` (`shell:false` spawn wrappers) with the
  `ExecFn` / `LineStreamFn` types adapters share.
- **Absorbed claude-mesh** — background-agent lifecycle (`spawnAgent`, `listAgents`,
  `stopAgent`, `agentLogs`, `attachCommand`), session discovery (`listSessions`,
  `findSession`, `isSessionAlive`, `preseedProjectMcpTrust`), the messaging gateway
  (`MeshGateway`), the cross-account bridge (`MeshBridge`), and the protocol helpers —
  behavior preserved, package identity updated.
- **Absorbed live claude.ai plan-usage reader** — `getLiveUsage`, `getLiveUsageForAccounts`,
  `parseLiveUsage`, `mergeStaleWindows`, and helpers (was `claude-plan-usage`'s `live.ts`).

### Fixed (adversarial-review pass)
- **Ambient-login introspection (H1)** — `authStatus()` and `quota()` now resolve the config
  correctly for the most common setup: a fully ambient login (no account, no `CLAUDE_CONFIG_DIR`)
  reads `~/.claude.json` at the home root, not `~/.claude/.claude.json`, and the quota probe no
  longer forces `CLAUDE_CONFIG_DIR` onto the spawned CLI in the ambient case — it inherits the
  ambient env. This required a minimal, comment-marked divergence in the absorbed `usage.ts`
  (`probe()` only sets `CLAUDE_CONFIG_DIR` for an explicit `configDir`).
- **Argv flag injection (H3)** — the prompt/message positional is now fenced behind a `--`
  terminator in `run()`, `resume()`, and `stream()`, so a flag-shaped prompt (`--help`, `-p`)
  is treated as text; and `resume()` rejects a `conversationId` beginning with `-` before spawn,
  so a hostile id such as `--last` can no longer redirect the run to another session.
- **UTF-8 chunk-boundary corruption (M1)** — `nodeExec`, `nodeLineStream`, and the usage probe
  now `setEncoding('utf8')`, so a multi-byte character split across a pipe chunk is no longer
  decoded as two replacement characters.
- **Stream failure fidelity (M2)** — `nodeLineStream` reports end-of-stream metadata (timeout
  flag, exit code, stderr tail ≤ 4 KiB); `stream()` now mirrors `run()` on a timeout (a `done`
  event with `status:'incomplete'` and a timeout note, carrying partial text) and includes the
  exit code and stderr tail in the error event on a non-zero exit — stderr is never dropped.
- **`quota()` honors `binary` (M5)** — the live-usage probe is spawned with the adapter's own
  `binary` (`claudePath`), not a bare `claude` from `PATH`.
- **`--allowedTools` variadic hazard (M6)** — emitted as one comma-joined value
  (`--allowedTools Read,Edit`), so a following `extra.args` token can never be swallowed into
  the tool grant.
- **Env seam & account precedence (M7/L8)** — a new `env` option (default `process.env`) backs
  every env read; a passed `account` is authoritative, so `{ vendor:'claude' }` with no
  `configDir` means the ambient login even when a `defaultAccount` has one.
- **Child-env isolation (parity with codex)** — the exported `nodeExec` / `nodeLineStream` seam
  now treats `ExecRequest.env`, when provided, as the COMPLETE child env rather than a layer
  merged over `process.env` (keys with an `undefined` value are dropped; an omitted `env` still
  inherits the parent env via spawn's default). The adapter composes the fully-resolved child env
  — the injected `env` seam (default `process.env`) with `CLAUDE_CONFIG_DIR` overlaid only for an
  explicit config dir — and hands it to the seam. This is a deliberate, documented behavior change
  to the exported seam, matching the codex package's `buildEnv` rule: an injected `env` now
  genuinely isolates the spawned CLI, so a machine with an ambient `ANTHROPIC_API_KEY` can no
  longer have introspection report a subscription login while the child runs under API-key auth.
  Real-world behavior is unchanged for callers who never inject `env` (the base defaults to
  `process.env`).
- **Unknown-model annotation (M12)** — a `model` outside the static catalog (dated suffixes
  allowed) still runs but adds a `RunResult.note`; notes compose with `'; '`.
- **CLI self-identification (L4)** — help and error output now name `agent-mesh-claude`, the
  installed bin, instead of `claude-mesh`.
- **Eager stream validation (N1)** — the empty-prompt guard in `stream()` throws at call time
  rather than on the first `next()`.
- **Packaging (M8/L7/M10)** — per-condition `exports` types (`.d.cts` for `require`), a
  `prepublishOnly` build guard, `repository`/`homepage`/`bugs`/`publishConfig` metadata, and a
  bundled MIT `LICENSE`.
- **Timeout process-group reaping** — a timed-out run now signals the child's whole POSIX
  process group (`nodeExec`, `nodeLineStream`, and the `usage.ts` probe are spawned
  `detached:true` and killed via `-pid`), so grandchildren the CLI spawns — which inherit the
  stdout/stderr pipes — are reaped with it instead of holding the pipes open and delaying the
  `'close'` event by up to ~30s. As a belt-and-braces, once a timeout has tripped the child's
  read ends are destroyed on `'exit'` so `'close'` fires promptly even if an inherited FD
  survives. Normal (non-timeout) runs still resolve on `'close'` with output fully drained.

### Fixed (adversarial-review pass 2)
- **UTF-8 chunk-boundary corruption in the absorbed mesh modules (A1)** — the gateway's stdout /
  stderr readers (`MeshGateway`) and the background-agent process runner (`runProcess` in
  `agents.ts`) now `setEncoding('utf8')` on the child streams, so a multi-byte character (CJK,
  emoji) split across a pipe chunk is held over the boundary by the `StringDecoder` instead of each
  half decoding to a U+FFFD replacement character. Korean/CJK relay text now survives intact.
- **Background-agent timeout reaping across a process tree (A2)** — `runProcess` now spawns
  `detached:true` and, on timeout, signals the whole POSIX process group (`process.kill(-pid, sig)`
  with a direct-`kill` fallback and an undefined-pid guard), and destroys the child's read ends on
  `'exit'` once a timeout tripped. A `claude` invocation that spawned pipe-inheriting grandchildren
  no longer leaves the call pending for ~30s after the kill; it settles promptly at the timeout.
- **Gateway stdin backpressure is no longer reported as `gateway_down` (A3)** — `MeshGateway.send()`
  now treats a `write()` return of `false` as backpressure: the relay frame is already queued and
  will flush on `'drain'`, so the parked relay resolves normally when its `RELAY_RESULT` returns.
  `gateway_down` is reserved for a genuinely unusable pipe (missing / not writable / destroyed, or a
  write that throws). A large or rapid relay is no longer misreported as a dead gateway.
- **No advertised default model the adapter cannot honor (A4)** — the static catalog no longer marks
  `claude-sonnet-5` (or any model) `default: true`. `run()` omits `--model` when a task names none,
  so the CLI picks its own default; the catalog now reflects that instead of claiming a default the
  adapter never selects.
- **Conversation-id value semantics (U1)** — `resume()` now trims the `conversationId` FIRST, then
  validates the trimmed value (empty → `AgentMeshError`; leading `-` → `AgentMeshError`), and passes
  the TRIMMED id to the CLI. `'  -c  '` is rejected as flag-shaped and `'  abc-123  '` reaches argv
  as `'abc-123'` — surrounding spaces are never forwarded.
- **Model value semantics — absent is not invalid (U2)** — a provided-but-blank `model` (e.g. `'   '`)
  is treated as ABSENT across `run()`, `resume()`, and `stream()`: the flag is omitted, no note is
  added, nothing is thrown. A non-empty model is passed to the CLI TRIMMED, and an unknown-catalog
  note uses the trimmed value.
- **`usage.totalTokens` populated (U3)** — a vendor-supplied `total_tokens` is used verbatim;
  otherwise, when both input and output token counts are numbers, the total is their sum; otherwise
  the field is omitted. Fleet-wide token accounting no longer undercounts this vendor.
- **Null / malformed account is ABSENT, not an error (U4)** — a `null` (or otherwise non-object)
  `account` now behaves exactly as if none was passed (falls back to `defaultAccount`) instead of
  raising a `TypeError`, across `run`, `resume`, `quota`, `authStatus`, and `availableModels`. A
  real account object whose `configDir` is undefined still means AMBIENT and does not inherit
  `defaultAccount.configDir`.
- **`extra.args` never drops input silently (U5)** — non-string entries are still filtered out, but
  when any are dropped a note `extra.args contained N non-string entr(y|ies); dropped` is added
  (and composed with any other notes).
- **`resume()` honours a working directory (U6)** — with no `cwd` on `ResumeOptions` and core frozen,
  `resume()` reads `opts.extra?.cwd` when it is a string and runs the child there; otherwise it
  inherits as before. A resume now runs in the conversation's workspace when asked.
- **Notes compose consistently across `run()` and `stream()` (U7)** — model and `extra.args` notes
  compose with `'; '` in a stable order, and every note `run()` would produce also appears on the
  `RunResult` delivered by the `stream()` `done` event.
- **Packaging uniformity (U8)** — `package.json` `files` is now exactly `["dist"]` (npm always ships
  `package.json`, `README.md`, and `LICENSE`); `CHANGELOG.md` is no longer published in the tarball.

### Notes
- Requires the Claude Code CLI on `PATH` (or a `binary` override); the mesh layers require
  CLI ≥ 2.1.224 on macOS or Linux. Unofficial; depends on Claude Code CLI behavior and some
  undocumented on-disk formats.
