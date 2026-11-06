#!/usr/bin/env bash
# Parakeet host-engine smoke test on an x86_64 Linux host (CI).
#
# Unpacks the x86_64 host runtime archive exactly as RuntimeInstaller would, lays
# out opt/dsh-app/direct the way HostLaunch.kt does (config.json + bin wrappers),
# and starts `dsh web` with the host's own Node 24 through
# runtime/direct/host-preload.mjs: no PRoot, no Ubuntu, no container. The Termux
# Bionic node itself only runs on Android (see runtime/tests/emulator-smoke.sh).
#
# Checks: token line, auth exchange, dsh-go-bridge inventory, the Parakeet
# root-shell plugin loaded, the disabled rows (feedback / DeepSeek account /
# telemetry) are not served, guest paths map into the runtime tree, graceful
# SIGTERM through the pid file.
#
#   runtime/tests/host-smoke.sh [out-dir] [port]     # default runtime/out-en
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$HERE/out-en}"
PORT="${2:-38123}"
ABI=x86_64
ASSETS="$OUT/$ABI/assets/runtime"
MANIFEST="$ASSETS/manifest.json"
T="$(mktemp -d)"
ROOT="$T/runtime/rootfs"
LOG="$T/dsh.log"
FAILED=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }
cleanup() { [[ -n "${PID:-}" ]] && kill -9 "$PID" 2>/dev/null || true; }
trap cleanup EXIT

python3 -I -c 'import json,sys; m=json.load(open(sys.argv[1])); assert m["engine"]=="host", m.get("engine"); print("manifest:", m["runtimeVersion"], "engine", m["engine"])' "$MANIFEST"
archive="$ASSETS/$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["rootfs"])' "$MANIFEST")"
mkdir -p "$ROOT"
tar -xf "$archive" -C "$ROOT"
echo "unpacked: $(du -sh "$ROOT" | cut -f1)  ($(find "$ROOT" -type f | wc -l) files)"
[[ ! -e "$ROOT/usr/bin/apt-get" && ! -e "$ROOT/opt/node/bin/node" && ! -e "$ROOT/usr/lib/x86_64-linux-gnu" ]] && pass "no Ubuntu userland and no glibc Node in the runtime" || fail "Ubuntu/glibc pieces present"

NODE="$(command -v node)"
# HostLaunch.prepare, for a Linux host: same files, same argv shape.
mapfile -t LAUNCH < <(python3 -I - "$MANIFEST" "$ROOT" "$NODE" "$PORT" <<'PY'
import json, os, sys
m = json.load(open(sys.argv[1])); root, node, port = sys.argv[2:5]
argv = m["launch"]["argv"]; env_at = argv.index("/usr/bin/env")
mounts = []
it = iter(argv[1:env_at])
for a in it:
    if a == "-b":
        v = next(it); host, _, guest = v.partition(":"); guest = guest or host
        mounts.append({"host": host, "guest": guest})
owned = f"{root}/opt/dsh-app/direct"; b = f"{owned}/bin"
os.makedirs(b, exist_ok=True)
def w(name, text):
    p = f"{b}/{name}"; open(p, "w").write(text); os.chmod(p, 0o700)
w("guest", '#!/bin/sh\nf="$1"; shift\nif [ -f "$f" ] && [ -x "$f" ]; then exec "$f" "$@"; fi\n'
           f'case "$f" in \'{root}/\'*) n="${{f##*/}}"; [ -n "$n" ] && exec "$n" "$@";; esac\nexec "$f" "$@"\n')
w("bash", '#!/bin/sh\nexec /bin/bash "$@"\n')
w("sh", '#!/bin/sh\nexec /bin/bash --posix "$@"\n')
w("node", f"#!/bin/sh\nunset DSH_GO_DIRECT_MAIN\nexport DSH_GO_RUNTIME_ROOT='{root}' DSH_GO_DIRECT_ROOTFS='{root}'\n"
          f"exec '{node}' --expose-internals '--import={root}/opt/dsh-go/direct/host-preload.mjs' \"$@\"\n")
cfg = {"schema": 2, "engine": "host", "rootfs": root, "bin": b, "loader": "", "libraryPath": "", "node": node,
       "hostShell": "/bin/sh", "mounts": sorted(mounts, key=lambda x: -len(x["guest"]))}
rg = f"{root}/opt/dsh/node_modules/@vscode/ripgrep-linux-x64/bin/rg"
if os.path.isfile(rg): cfg["ripgrep"] = {"path": rg, "dynamic": False}
json.dump(cfg, open(f"{owned}/config.json", "w"))
cmd = argv[-1]
web = cmd.split("exec /usr/local/bin/dsh ", 1)[1].replace("{PORT}", port).split()
for i, a in enumerate(web):
    if a == "--patch": web[i + 1] = root + web[i + 1]
for a in [node, "--expose-internals", f"--import={root}/opt/dsh-go/direct/host-preload.mjs",
          f"{root}/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"] + web:
    print(a)
PY
)
echo "launch: ${LAUNCH[*]}"
(cd "$ROOT/root" && env -i HOME="$ROOT/root" DSH_HOME="$ROOT/root/.dsh" TMPDIR="$ROOT/tmp" \
  PATH="$ROOT/opt/dsh-app/direct/bin:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 \
  DSH_GO_RUNTIME_ROOT="$ROOT" DSH_GO_DIRECT_ROOTFS="$ROOT" DSH_GO_DIRECT_MAIN=1 \
  DSH_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 DEEPSEEK_API_KEY=sk-parakeet-smoke-not-a-real-key \
  "${LAUNCH[@]}" >"$LOG" 2>&1) &
PID=$!
TOKEN=""
for _ in $(seq 1 180); do
  TOKEN="$(sed -n 's#^dsh web: http://127\.0\.0\.1:[0-9]*/?token=\([A-Za-z0-9_-]*\).*#\1#p' "$LOG" | head -1)"
  [[ -n "$TOKEN" ]] && break
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if [[ -z "$TOKEN" ]]; then fail "no token line"; tail -80 "$LOG"; exit 1; fi
pass "dsh web printed its token line"

JAR="$T/cookies"
code="$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" "http://127.0.0.1:$PORT/?token=$TOKEN")"
[[ "$code" == 303 ]] && pass "token exchange -> 303" || fail "token exchange -> $code"
code="$(curl -s -o "$T/inv.json" -w '%{http_code}' -b "$JAR" "http://127.0.0.1:$PORT/dsh-go/v1/inventory")"
[[ "$code" == 200 ]] && pass "dsh-go-bridge inventory -> 200" || fail "dsh-go-bridge inventory -> $code"
if grep -q "\[parakeet-root-shell\] registered" "$LOG"; then
  pass "parakeet-root-shell plugin loaded"
else
  fail "parakeet-root-shell not loaded"; head -c 2000 "$T/inv.json"; echo
fi
for route in feedback account/state; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "http://127.0.0.1:$PORT/$route")"
  [[ "$code" == 404 || "$code" == 401 || "$code" == 405 ]] && pass "/$route not served ($code)" || fail "/$route served ($code)"
done
if grep -qi "otel\|deepseeksvc\|telemetry" "$LOG"; then fail "telemetry mentioned in the engine log"; grep -i "otel\|deepseeksvc\|telemetry" "$LOG" | head; else pass "no telemetry in the engine log"; fi
[[ -s "$ROOT/tmp/dsh-web.pid" ]] && pass "pid file written by the host preload" || fail "no pid file"
[[ -d "$ROOT/root/.dsh" ]] && pass "DSH home inside the runtime tree (guest /root/.dsh)" || fail "no DSH home"

kill -TERM "$(cat "$ROOT/tmp/dsh-web.pid")" 2>/dev/null || true
for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then fail "did not stop on SIGTERM"; else pass "graceful SIGTERM"; PID=""; fi
echo "--- engine log tail"; tail -25 "$LOG"
exit "$FAILED"
