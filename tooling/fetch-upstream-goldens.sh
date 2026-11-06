#!/usr/bin/env bash
# Parakeet keeps dsh-Go's widget tests but not their golden images (1,000+ PNGs,
# ~325 MB) in this repo. This fetches them from the upstream commit Parakeet was
# imported from and copies every golden that is not already in app/test (a
# golden Parakeet re-recorded for its own UI wins).
#
#   tooling/fetch-upstream-goldens.sh [cache-dir]     # default ~/.cache/parakeet-upstream-goldens
set -euo pipefail
UPSTREAM=https://github.com/ccch1mneyyy/dsh-Go.git
SHA=cf2f7c861e1098661a3a2039b3a4cb1633790102
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${1:-$HOME/.cache/parakeet-upstream-goldens}"

if [[ ! -f "$CACHE/.complete-$SHA" ]]; then
  rm -rf "$CACHE"; mkdir -p "$CACHE"
  git -C "$CACHE" init -q
  git -C "$CACHE" remote add up "$UPSTREAM"
  git -C "$CACHE" sparse-checkout set --no-cone '/app/test/**/goldens/*.png'
  git -C "$CACHE" fetch -q --depth 1 --filter=blob:none up "$SHA"
  git -C "$CACHE" checkout -q FETCH_HEAD
  touch "$CACHE/.complete-$SHA"
fi
n=0
while IFS= read -r -d '' f; do
  rel="${f#"$CACHE"/}"
  if [[ ! -e "$ROOT/$rel" ]]; then
    install -D -m644 "$f" "$ROOT/$rel"; n=$((n + 1))
  fi
done < <(find "$CACHE/app/test" -path '*/goldens/*.png' -print0)
echo "upstream goldens: copied $n into app/test (dsh-Go@${SHA:0:7})"
