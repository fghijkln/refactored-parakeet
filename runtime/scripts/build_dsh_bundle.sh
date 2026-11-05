#!/usr/bin/env bash
# Build the DSH runtime tree that ships inside the APK as assets/dsh-bundle.zip.
#
#   runtime/scripts/build_dsh_bundle.sh <work-dir> <out-zip>
#
# The tree is a plain npm install of the published @deepseek-ai/dsh CLI (which
# pulls every bundle: base, web-app, headless, acp-app, sdk-app), pnpm for
# plugin installs, and the Parakeet root-shell plugin, then:
#   * every prebuilt *.node addon is removed (glibc/musl/darwin/win32 builds
#     cannot load under Android's Bionic libc) — see README "native addons";
#   * @deepseek-ai/node-addon-system's flock binding gets a pure-JS fallback,
#     because JSONL session persistence takes an flock on every session file;
#   * type declarations and source maps are dropped to save space.
# Requires node >= 24 and npm on PATH. Network access to registry.npmjs.org.
set -euo pipefail
WORK=${1:?work dir}
OUT=${2:?output zip}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DSH_VERSION=$(node -p "require('$ROOT/dsh/versions.json').dsh")
PNPM_VERSION=$(node -p "require('$ROOT/dsh/versions.json').pnpm")

rm -rf "$WORK"
mkdir -p "$WORK"
cp "$ROOT"/dsh/launcher/*.mjs "$WORK/"
cat > "$WORK/package.json" <<EOF
{
  "name": "parakeet-dsh-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "@deepseek-ai/dsh": "$DSH_VERSION",
    "pnpm": "$PNPM_VERSION"
  },
  "overrides": {
    "zod": "$(node -p "require('$ROOT/dsh/versions.json').zod")"
  }
}
EOF
cd "$WORK"
# --ignore-scripts: no native builds (they would target the CI host anyway).
npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
# The root-shell plugin's imports (@deepseek-ai/schemastery, dsh-tools) are
# already hoisted by the DSH install, so it is copied in rather than installed.
mkdir -p node_modules/@parakeet
cp -r "$ROOT/dsh/plugin-root-shell" node_modules/@parakeet/dsh-plugin-root-shell
rm -rf node_modules/@parakeet/dsh-plugin-root-shell/test

# ---- prune host-only native code ---------------------------------------
find node_modules -name '*.node' -type f -print -delete | sed 's/^/pruned addon: /' | sort | uniq | head -50
# LibreOffice WASM (OOXML->PDF preview, ~150 MB, published for os=linux only):
# not shipped; office-document preview/conversion is unavailable on Android.
for d in node_modules/@deepseek-ai/libreoffice-kit-wasm/assets node_modules/@deepseek-ai/libreoffice-kit-wasm/sources \
         node_modules/@img node_modules/sherpa-onnx-* node_modules/@koromix node_modules/node-pty/prebuilds \
         node_modules/@deepseek-ai/node-addon-system-* node_modules/node-addon-require-builtin-*; do
  [ -e "$d" ] && echo "pruned dir: $d" && rm -rf "$d"
done
find node_modules \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' -o -name '*.tsbuildinfo' \) -type f -delete
# .bin holds symlinks only; nothing on Android execs them (there is no exec
# from the data dir), and the zip should carry no symlinks.
find node_modules -type d -name .bin -prune -exec rm -rf {} +

# ---- flock fallback -------------------------------------------------------
node "$ROOT/runtime/scripts/patch_runtime.mjs" "$WORK"

# ---- version stamp + zip --------------------------------------------------
node -e "
const fs=require('fs');
const v={dsh:require('./node_modules/@deepseek-ai/dsh/package.json').version,pnpm:require('./node_modules/pnpm/package.json').version,builtAt:new Date().toISOString(),git:process.env.GITHUB_SHA||'local'};
fs.writeFileSync('bundle-version.json',JSON.stringify(v,null,2));console.log(v)"
du -sh node_modules
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
if [ -n "${SKIP_ZIP:-}" ]; then echo "SKIP_ZIP set"; exit 0; fi
zip -qr -9 "$OUT" .
ls -la "$OUT"
