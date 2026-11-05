#!/usr/bin/env bash
# Linux smoke test of the exact DSH tree that ships in the APK.
#
#   runtime/tests/smoke-linux.sh <runtime-dir>
#
# The tree has every glibc/musl native addon removed (as on Android), so this
# also exercises the pure-JS flock and require-builtin fallbacks. Checks:
#   1. launcher self-test (node version, dsh version, bundled pnpm)
#   2. root-shell plugin unit tests
#   3. `dsh web` boots on loopback with the Parakeet overlay and serves the UI
#   4. a headless agent turn against a mock OpenAI-compatible server calls
#      root_shell through a fake `su` and gets its output back
#   5. with confirmation ON and no approval channel (headless), root_shell
#      refuses to run (fail closed)
set -euo pipefail
RT=$(cd "${1:?runtime dir}" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK"' EXIT
export DSH_HOME="$WORK/home" DSH_TELEMETRY_DISABLED=1 PARAKEET_API_KEY=sk-ci-not-a-real-key
mkdir -p "$DSH_HOME" "$WORK/ws" "$WORK/bin"
pass() { echo "PASS: $*"; }

echo "== 1. self-test"
node "$RT/launch.mjs" --parakeet-selftest | tee "$WORK/self.json"
grep -q '"dsh":"' "$WORK/self.json"
pass "launcher self-test"

echo "== 2. plugin unit tests"
P="$RT/node_modules/@parakeet/dsh-plugin-root-shell"
cp -r "$REPO/dsh/plugin-root-shell/test" "$P/test"
(cd "$P" && node --test test/*.test.mjs)
rm -rf "$P/test"
node --test "$HERE/parakeet-config.test.mjs"
pass "unit tests"

# fake su: honours -c, otherwise is an interactive sh (persistent mode)
cat > "$WORK/bin/su" <<'EOF'
#!/bin/sh
if [ "$1" = "-c" ]; then shift; exec /bin/sh -c "$*"; fi
exec /bin/sh
EOF
chmod +x "$WORK/bin/su"
export PARAKEET_SU="$WORK/bin/su"

PORT_FILE="$WORK/mock.port"
node "$HERE/mock-openai.mjs" 0 root_shell '{"description":"print the uid","command":"echo PARAKEET_ROOT_OK; id -u"}' > "$PORT_FILE" 2> "$WORK/mock.log" &
for _ in $(seq 50); do [ -s "$PORT_FILE" ] && break; sleep 0.1; done
MOCK_PORT=$(head -1 "$PORT_FILE")
cat > "$WORK/config.json" <<EOF
{"provider":{"kind":"openai-compatible","baseUrl":"http://127.0.0.1:$MOCK_PORT/v1","model":"mock-model","displayName":"CI mock"},"rootTool":true,"workspaceRoot":"$WORK/ws"}
EOF
export PARAKEET_CONFIG="$WORK/config.json" PARAKEET_SETTINGS="$WORK/settings.json"

echo "== 3. dsh web boots"
cd "$WORK/ws"
node "$RT/launch.mjs" web --no-open --host 127.0.0.1 --port 0 > "$WORK/web.log" 2>&1 &
WEB_PID=$!
URL=""
for _ in $(seq 120); do
  URL=$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\S*' "$WORK/web.log" | head -1 || true)
  [ -n "$URL" ] && break
  kill -0 $WEB_PID 2>/dev/null || break
  sleep 1
done
cat "$WORK/web.log"
[ -n "$URL" ] || { echo "FAIL: dsh web did not print its URL"; exit 1; }
if grep -q "did not activate" "$WORK/web.log"; then echo "FAIL: some DSH plugins did not activate"; exit 1; fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' -L -c "$WORK/cj" -b "$WORK/cj" "$URL")
echo "GET $URL -> $CODE"
[ "$CODE" = "200" ] || { echo "FAIL: web UI returned $CODE"; exit 1; }
kill $WEB_PID; wait $WEB_PID 2>/dev/null || true
pass "dsh web served the UI"

echo "== 4. headless agent turn uses root_shell"
echo '{"requireRootConfirm": false}' > "$PARAKEET_SETTINGS"
timeout 180 node "$RT/launch.mjs" headless "check whether we are root" > "$WORK/headless.out" 2> "$WORK/headless.err" || { cat "$WORK/headless.err"; cat "$WORK/mock.log"; exit 1; }
cat "$WORK/headless.out"; cat "$WORK/mock.log"
grep -q "TOOL_SAW: .*PARAKEET_ROOT_OK" "$WORK/headless.out" || { echo "FAIL: root_shell output did not reach the model"; cat "$WORK/headless.err"; exit 1; }
pass "agent called root_shell via su and saw its output"

echo "== 5. confirmation ON without an approval channel fails closed"
echo '{"requireRootConfirm": true}' > "$PARAKEET_SETTINGS"
timeout 180 node "$RT/launch.mjs" headless "check whether we are root" > "$WORK/headless2.out" 2> "$WORK/headless2.err" || true
cat "$WORK/headless2.out"
if grep -q "PARAKEET_ROOT_OK" "$WORK/headless2.out"; then echo "FAIL: root command ran without approval"; exit 1; fi
grep -qiE "approv|did not approve|reject|unavailable" "$WORK/headless2.out" || { echo "FAIL: expected an approval refusal"; cat "$WORK/headless2.err"; exit 1; }
pass "unapproved root command was refused"

echo "ALL SMOKE TESTS PASSED"
