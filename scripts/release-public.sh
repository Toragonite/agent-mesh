#!/usr/bin/env bash
#
# release-public.sh — publish a curated snapshot of HEAD to the PUBLIC GitHub repository.
#
# The private repository carries the full history, including `internal/` (research,
# decisions, handoff) and `.orchestrator/` — working material that must never leave.
# The public repository carries the product: one commit per release, tagged, with the
# excluded directories absent from the tree AND from the history — because a file
# removed in a later commit is still readable in an earlier one.
#
# That is why this script rebuilds the public tree from scratch each time rather than
# filtering the private history: there is no path by which an excluded file reaches the
# public remote, so there is nothing to get wrong twice.
#
#   Usage:
#     scripts/release-public.sh [VERSION] [--skip-tests] [--dry-run]
#
#     VERSION       e.g. 0.1.0 or v0.1.0. Defaults to the version in
#                   packages/core/package.json, which is the lockstep version for
#                   every published package.
#     --skip-tests  Do not run `npm test` first. For re-running a release whose tests
#                   you have already watched pass; never for a first attempt.
#     --dry-run     Do everything except the final push. Prints the commit and tag it
#                   would have pushed, and leaves the staging clone in place.
#
#   Remotes this script expects (dual-repo topology: private dev / public release):
#     origin   git@github.com:Toragonite/agent-mesh.git        (PUBLIC)
#     private  git@github.com:Toragonite/agent-mesh-dev.git     (PRIVATE, full history)

set -euo pipefail

# Paths that must never reach the public remote — private research/handoff trees plus
# the private-workspace tooling (project instructions, agent config, local MCP wiring)
# that only belongs in the dev repo. Entries may be directories or files. Add to this
# list, not to a .gitignore — the exclusion is enforced by refusal checks below, not
# trusted. A separate content grep (further down) then rejects any surviving file that
# merely *references* the private trees.
EXCLUDE_PATHS=(internal .orchestrator CLAUDE.md .claude .mcp.json)

VERSION=""
SKIP_TESTS=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    -h|--help)    sed -n '3,30p' "$0"; exit 0 ;;
    -*) echo "error: unknown option '$arg'" >&2; exit 2 ;;
    *)
      if [ -n "$VERSION" ]; then
        echo "error: version given more than once ('$VERSION' and '$arg')" >&2; exit 2
      fi
      VERSION="$arg" ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

# --- Refusals: states in which a release would be wrong, not merely inconvenient. ---

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty. A release must be a snapshot of a committed state." >&2
  git status --short >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "error: no remote named 'origin'. Expected the PUBLIC repository there." >&2
  echo "       git remote add origin git@github.com:Toragonite/agent-mesh.git" >&2
  exit 1
fi

if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('./packages/core/package.json').version")"
fi
VERSION="${VERSION#v}"

if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "error: '$VERSION' is not a semver version (expected e.g. 0.1.0 or 1.2.0-rc.1)." >&2
  exit 1
fi

TAG="v${VERSION}"

# Lockstep gate. Every published package — packages/core plus the vendor adapters —
# shares ONE version; a release with a drifted adapter version is a broken release.
# This has to run HERE, before the tag exists: the tag IS the release decision, and
# once `git push origin ${TAG}` lands it is public and immutable (it triggers the npm
# publish), so a version mismatch caught after the push cannot be undone cheaply — only
# superseded by a new version. .github/workflows/release.yml re-verifies all five, but
# that runs AFTER the tag is pushed, which is exactly too late. So we gate before.
#
# Derive the package set from the workspace rather than hardcoding a second literal list
# that could rot out of sync with packages/ itself: check every packages/*/package.json
# that exists (a packages/* dir without one is skipped), and collect EVERY mismatch so a
# single run names everything to bump instead of failing one package at a time. The glob
# expands each path as one word, so package directories containing spaces are handled.
MISMATCH_COUNT=0
for pkg in packages/*/package.json; do
  [ -e "$pkg" ] || continue   # packages/* dir with no package.json; nothing in lockstep
  PKG_VERSION="$(node -p "require('./${pkg}').version")"
  if [ "$VERSION" != "$PKG_VERSION" ]; then
    if [ "$MISMATCH_COUNT" -eq 0 ]; then
      echo "error: asked to release ${VERSION}, but not every package agrees:" >&2
    fi
    echo "       ${pkg} says ${PKG_VERSION}" >&2
    MISMATCH_COUNT=$((MISMATCH_COUNT + 1))
  fi
done
if [ "$MISMATCH_COUNT" -gt 0 ]; then
  echo "       All public packages move in lockstep; bump them first." >&2
  exit 1
fi

ORIGIN_URL="$(git remote get-url origin)"

if [ -n "$(git ls-remote --tags origin "refs/tags/${TAG}" 2>/dev/null)" ]; then
  echo "error: tag ${TAG} already exists on origin (${ORIGIN_URL})." >&2
  echo "       A published release is immutable. Bump the version instead." >&2
  exit 1
fi

# Resolve the committer identity from THIS (source) repository, where a conditional
# `includeIf` for the project path — e.g. ~/.gitconfig-doraemon pulled in by a
# `gitdir:` match — actually applies. That identity does NOT follow the staging clone
# into $TMPDIR (the `gitdir:` condition matches this project's path, not a temp dir),
# so the clone would inherit no name/email at all and `git commit`/`git tag -a` would
# die with "Author identity unknown" — after minutes of tests and cloning. Resolve it
# here and refuse early. The plain lookups (no --global/--local) are what resolve an
# `includeIf`; under `set -euo pipefail` a lookup that finds nothing exits non-zero, so
# `|| true` keeps that from aborting before our own message prints.
SOURCE_USER_NAME="$(git config user.name || true)"
SOURCE_USER_EMAIL="$(git config user.email || true)"
if [ -z "$SOURCE_USER_NAME" ] || [ -z "$SOURCE_USER_EMAIL" ]; then
  echo "error: git user.name and user.email are not both set for this repository." >&2
  echo "       The staging clone lives under \$TMPDIR, so a conditional includeIf identity" >&2
  echo "       does not reach it; the release commit and tag would have no author." >&2
  echo "       Set both, globally or for this repository:" >&2
  echo "       git config --global user.name 'Your Name'" >&2
  echo "       git config --global user.email 'you@example.com'" >&2
  exit 1
fi

# --- Gates. ---

if [ "$SKIP_TESTS" -eq 1 ]; then
  echo "==> Skipping tests (--skip-tests)."
else
  echo "==> Running gates before releasing ${TAG}..."
  npm run typecheck
  npm test
fi

# --- Build the snapshot. ---

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/agent-mesh-release-XXXXXX")"
SNAPSHOT="${STAGING}/snapshot"
PUBLIC_CLONE="${STAGING}/public"
mkdir -p "$SNAPSHOT" "$PUBLIC_CLONE"

cleanup() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "==> Dry run: staging directory left at ${STAGING}"
  else
    rm -rf "$STAGING"
  fi
}
trap cleanup EXIT

# `git archive HEAD` emits exactly the TRACKED files at HEAD: no untracked scratch,
# no ignored build output, no .git directory.
echo "==> Exporting tracked files at HEAD..."
git archive HEAD | tar -x -C "$SNAPSHOT"

for d in "${EXCLUDE_PATHS[@]}"; do
  echo "==> Removing ${d} from the snapshot..."
  rm -rf "${SNAPSHOT:?}/${d}"
  if [ -e "${SNAPSHOT}/${d}" ]; then
    echo "error: ${d} still present in the snapshot after removal. Refusing to push." >&2
    exit 1
  fi
done

# --- Replay the snapshot onto the public remote's main branch. ---

echo "==> Preparing the public staging clone..."
git init -q -b main "$PUBLIC_CLONE"
git -C "$PUBLIC_CLONE" remote add origin "$ORIGIN_URL"

# Give the staging clone the identity we resolved from the source repo above. Without
# this the clone under $TMPDIR has no committer at all — a conditional includeIf
# identity does not follow it there — and the commit/tag steps below abort. Do NOT set
# anything globally or touch the source repo; scope it to this clone with `git -C`.
git -C "$PUBLIC_CLONE" config user.name "$SOURCE_USER_NAME"
git -C "$PUBLIC_CLONE" config user.email "$SOURCE_USER_EMAIL"

if git -C "$PUBLIC_CLONE" fetch -q origin main 2>/dev/null; then
  echo "    Found an existing origin/main; this release will be a child of it."
  git -C "$PUBLIC_CLONE" checkout -q -B main FETCH_HEAD
else
  echo "    No origin/main yet; this will be the first public commit."
fi

# Replace the tree wholesale. Deleting first (rather than copying over) means a file
# removed from the private repo is actually removed from the public one.
find "$PUBLIC_CLONE" -mindepth 1 -maxdepth 1 -not -name '.git' -exec rm -rf {} +
cp -R "${SNAPSHOT}/." "${PUBLIC_CLONE}/"

git -C "$PUBLIC_CLONE" add -A

# Last line of defence: assert every excluded path is absent from the staged commit —
# whether it was a directory (its files appear as `${d}/...`) or a single file (`${d}`).
for d in "${EXCLUDE_PATHS[@]}"; do
  if git -C "$PUBLIC_CLONE" diff --cached --name-only | grep -qE "^${d}(/|\$)"; then
    echo "error: ${d} paths are staged for the public commit. Refusing to push." >&2
    exit 1
  fi
done

# Content refusal: no staged file may even REFERENCE the private trees by path. The
# removals above guarantee the private files themselves are gone; this catches a public
# file (a doc link, a code import, a comment) that still POINTS at internal/ or
# .orchestrator/ — a dead link that also advertises the private layout, which project
# rule 2 forbids. `-I` skips binaries; `--cached` reads exactly the staged blobs. This
# very script necessarily names those paths (it strips them), so it is the one file
# exempted — the path-level refusal above still guards it and everything else.
SELF_PATH="scripts/release-public.sh"
echo "==> Scanning staged files for references to private material..."
if git -C "$PUBLIC_CLONE" grep --cached -I -n -E 'internal/|\.orchestrator' -- . ":(exclude)${SELF_PATH}" >/dev/null 2>&1; then
  echo "error: staged files reference private material (internal/ or .orchestrator). Refusing to push." >&2
  echo "       Genericize or remove these references before releasing:" >&2
  git -C "$PUBLIC_CLONE" grep --cached -I -n -E 'internal/|\.orchestrator' -- . ":(exclude)${SELF_PATH}" >&2
  exit 1
fi

if git -C "$PUBLIC_CLONE" diff --cached --quiet; then
  echo "warning: this snapshot is byte-identical to the previous public release."
  echo "         Creating an empty commit so ${TAG} still points at a release commit."
fi

git -C "$PUBLIC_CLONE" commit -q --allow-empty -m "release: ${TAG}"
git -C "$PUBLIC_CLONE" tag -a "$TAG" -m "release: ${TAG}"

FILE_COUNT="$(git -C "$PUBLIC_CLONE" ls-files | wc -l | tr -d ' ')"
echo "==> Staged release commit for ${TAG}: ${FILE_COUNT} tracked files."

if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> Dry run: NOT pushing. Would have run:"
  echo "      git push origin main"
  echo "      git push origin ${TAG}"
  exit 0
fi

echo "==> Pushing ${TAG} to ${ORIGIN_URL}..."
git -C "$PUBLIC_CLONE" push origin main
git -C "$PUBLIC_CLONE" push origin "$TAG"

echo
echo "Released ${TAG} to the public repository."
echo "The tag push triggers .github/workflows/release.yml, which publishes to npm."
echo
echo "Next, mirror the full private history:"
echo "    git push private --all && git push private --tags"
