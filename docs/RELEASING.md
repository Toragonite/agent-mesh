# Releasing

agent-mesh ships from one working repository to two GitHub remotes and one npm
scope, under a private-development / public-release topology.

| Where | What it holds |
| --- | --- |
| `private` — `Toragonite/agent-mesh-dev` | Full history, every branch, and the private development material. The working repository. |
| `origin` — `Toragonite/agent-mesh` | The public product. One commit per release, tagged `vX.Y.Z`. The private development material never reaches it, in any commit. |
| npm scope `@toragonite` | The published packages, all at the same version. |

## One-time setup

```sh
git remote add origin  git@github.com:Toragonite/agent-mesh.git
git remote add private git@github.com:Toragonite/agent-mesh-dev.git
chmod +x scripts/release-public.sh
```

On GitHub, the **public** repository needs one secret before the first release:

- **`NPM_TOKEN`** — an npm **Automation** token (bypasses 2FA for CI) for an account
  with publish rights on the `@toragonite` scope. Add it at
  Settings → Secrets and variables → Actions. `.github/workflows/release.yml`
  exposes it as `NODE_AUTH_TOKEN`, which is what npm reads.

Enable **GitHub Pages → Source: GitHub Actions** on the public repo so
`.github/workflows/docs.yml` can deploy the VitePress site.

## Cutting a release

**1. Bump every published package to the new version** (lockstep). Adapters depend on
core through a caret range (`"@toragonite/agent-mesh": "^0.1.0"`), not an exact pin. npm
resolves that range against the registry at install time, so core must already be on the
registry when an adapter is installed — which is exactly why `.github/workflows/release.yml`
publishes core before the adapters (an adapter installed ahead of its core would be briefly
uninstallable). Bump each package's `version` field together, and move the caret's lower
bound with them (`^0.2.0` for a 0.2.x line) so the range keeps naming the release it ships
alongside.

**2. Commit the bump; keep the tree clean.** `release-public.sh` refuses to run on
a dirty tree.

**3. Push the public snapshot and the tag.**

```sh
bash scripts/release-public.sh 0.1.0
```

The script runs the gates, exports the tracked files at `HEAD`, **removes the
private development directories and workspace tooling**, replays the result as a
single `release: v0.1.0` commit onto public `main`, tags it, and pushes. `--dry-run` shows what it would push
without pushing; `--skip-tests` skips the suite when you have already watched it pass.
With no version argument it uses `packages/core/package.json`.

**4. Watch the publish.** The `v*` tag triggers `.github/workflows/release.yml`,
which re-runs every gate, verifies the tag matches `packages/core/package.json`, and
publishes each package with `--provenance` in dependency order (core first).

**5. Mirror the private history.**

```sh
git push private --all
git push private --tags
```

(`--all` and `--tags` are mutually exclusive in one git invocation, so this is two
pushes.) The private remote takes the working repository exactly as it is —
private material included. Nothing is curated on the way there.

## What is published and what is not

Published (scope `@toragonite`): `agent-mesh` (core) and each
`agent-mesh-<vendor>` adapter. Each ships `dist/`, its `README.md`, and `LICENSE`,
and declares `publishConfig.access: "public"`.

Not published: the root workspace and every `apps/*` (all `"private": true`, so an
accidental `npm publish` fails rather than leaks). The private development material
is never even in the public repository.

## Why the public repository is rebuilt rather than filtered

The private development material must be absent from the public repository's
**history**, not merely its current tree — a file deleted in a later commit is still
readable earlier. Rather than filtering history and hoping nothing was missed,
`release-public.sh` builds each public commit from scratch out of `git archive HEAD`
minus the excluded paths. There is no path by which an excluded file reaches the public remote,
so the exclusion cannot silently regress. The cost — the public repository has no
development history, only releases — is the intended shape.
