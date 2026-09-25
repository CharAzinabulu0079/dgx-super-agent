#!/usr/bin/env bash
# Fetch the pinned DSH source (reference / debugging only; runtime comes from npm).
# Usage: scripts/fetch-dsh-source.sh [target-dir]   (default: upstream/deepseek-harness, gitignored)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-$here/upstream/deepseek-harness}"
commit="$(node -e 'console.log(require(process.argv[1]).commit)' "$here/upstream/dsh.lock.json")"
repo="$(node -e 'console.log(require(process.argv[1]).repository)' "$here/upstream/dsh.lock.json")"
if [ ! -d "$target/.git" ]; then git clone --filter=blob:none "$repo" "$target"; fi
git -C "$target" fetch --tags origin
git -C "$target" -c advice.detachedHead=false checkout "$commit"
actual="$(git -C "$target" rev-parse HEAD)"
[ "$actual" = "$commit" ] || { echo "pin mismatch: $actual != $commit" >&2; exit 1; }
echo "DSH source at $target pinned to $commit"
