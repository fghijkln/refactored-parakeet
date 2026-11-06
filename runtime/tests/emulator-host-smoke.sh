#!/usr/bin/env bash
# Parakeet emulator smoke test (x86_64 emulator, CI).
#
#   runtime/tests/emulator-host-smoke.sh <x64-apk> <runtime-out-dir> <log-dir>
#
# 1. Host engine on real Android: the APK's own x86_64 Termux node/bash/libs (taken
#    out of the APK, byte-identical) plus the x86_64 runtime archive run `dsh web`
#    from /data/local/tmp through runtime/direct/host-preload.mjs: no PRoot, no
#    Ubuntu. Waits for the token line and the auth exchange.
# 2. The APK installs, launches and its process stays alive (no crash at startup).
set -uo pipefail
APK=${1:?apk}
OUT=${2:?runtime out dir}
LOGS=${3:?log dir}
PKG=dev.parakeet.dshgo
mkdir -p "$LOGS"
FAILED=0
pass() { echo "PASS $*" | tee -a "$LOGS/summary.txt"; }
fail() { echo "FAIL $*" | tee -a "$LOGS/summary.txt"; FAILED=1; }

adb wait-for-device
adb shell getprop ro.product.cpu.abilist | tee "$LOGS/abi.txt"
adb shell getprop ro.build.version.sdk | tee -a "$LOGS/abi.txt"

# ---- 1. host engine from /data/local/tmp ---------------------------------
W=/data/local/tmp/pk
T=$(mktemp -d)
unzip -q -o "$APK" 'lib/x86_64/*' -d "$T/apk"
ASSETS="$OUT/x86_64/assets/runtime"
ARCHIVE="$ASSETS/$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["rootfs"])' "$ASSETS/manifest.json")"
adb shell "rm -rf $W && mkdir -p $W/lib $W/links $W/rootfs"
adb push "$T/apk/lib/x86_64/." "$W/lib/" > /dev/null
adb push "$ARCHIVE" "$W/rootfs.tar.xz" > /dev/null
adb push "$ASSETS/termux-manifest.json" "$W/termux-manifest.json" > /dev/null
adb shell "cd $W/rootfs && tar -xJf ../rootfs.tar.xz" || adb shell "cd $W/rootfs && xz -dc ../rootfs.tar.xz | tar -xf -"
adb shell "chmod 755 $W/lib/*"
# soname links (TermuxLibs.kt)
python3 -I -c '
import json,sys
m=json.load(open(sys.argv[1]))
for so, flat in m["sonames"].items(): print(f"ln -sf {sys.argv[2]}/lib/{flat} {sys.argv[2]}/links/{so}")
' "$ASSETS/termux-manifest.json" "$W" > "$T/links.sh"
adb push "$T/links.sh" "$W/links.sh" > /dev/null
adb shell "sh $W/links.sh"
R=$W/rootfs
# config + wrappers the way HostLaunch.kt writes them
python3 -I - "$ASSETS/manifest.json" "$R" "$W" > "$T/prepare.sh" <<'PY'
import json, sys
m = json.load(open(sys.argv[1])); R, W = sys.argv[2], sys.argv[3]
argv = m["launch"]["argv"]; env_at = argv.index("/usr/bin/env")
mounts = []; it = iter(argv[1:env_at])
for a in it:
    if a == "-b":
        v = next(it); h, _, g = v.partition(":"); mounts.append({"host": h, "guest": g or h})
b = f"{R}/opt/dsh-app/direct/bin"
cfg = {"schema": 2, "engine": "host", "rootfs": R, "bin": b, "loader": "", "libraryPath": "", "node": f"{W}/lib/libnode_exec.so",
       "hostShell": "/system/bin/sh", "mounts": sorted(mounts, key=lambda x: -len(x["guest"]))}
print(f"mkdir -p {b}")
print(f"cat > {R}/opt/dsh-app/direct/config.json <<'EOF'\n{json.dumps(cfg)}\nEOF")
def w(n, body): print(f"cat > {b}/{n} <<'EOF'\n{body}EOF\nchmod 700 {b}/{n}")
w("guest", '#!/system/bin/sh\nf="$1"; shift\nif [ -f "$f" ] && [ -x "$f" ]; then exec "$f" "$@"; fi\nexec "${f##*/}" "$@"\n')
w("bash", f'#!/system/bin/sh\nexec {W}/lib/libbash_exec.so "$@"\n')
w("sh", f'#!/system/bin/sh\nexec {W}/lib/libbash_exec.so --posix "$@"\n')
w("node", f"#!/system/bin/sh\nexport DSH_GO_RUNTIME_ROOT={R} DSH_GO_DIRECT_ROOTFS={R}\nexec {W}/lib/libnode_exec.so --expose-internals --import={R}/opt/dsh-go/direct/host-preload.mjs \"$@\"\n")
web = argv[-1].split("exec /usr/local/bin/dsh ", 1)[1].replace("{PORT}", "38555").split()
for i, a in enumerate(web):
    if a == "--patch": web[i + 1] = R + web[i + 1]
print(f"cat > {W}/run.sh <<'EOF'")
print(f"cd {R}/root || exit 1")
print(f"export HOME={R}/root DSH_HOME={R}/root/.dsh TMPDIR={R}/tmp PATH={b}:/system/bin LD_LIBRARY_PATH={W}/links:{W}/lib")
print(f"export DSH_GO_RUNTIME_ROOT={R} DSH_GO_DIRECT_ROOTFS={R} DSH_GO_DIRECT_MAIN=1 DSH_TELEMETRY_DISABLED=1 DEEPSEEK_API_KEY=sk-parakeet-smoke")
print(f"exec {W}/lib/libnode_exec.so --expose-internals --import={R}/opt/dsh-go/direct/host-preload.mjs {R}/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js " + " ".join(web) + f" > {W}/dsh.log 2>&1")
print("EOF")
PY
adb push "$T/prepare.sh" "$W/prepare.sh" > /dev/null
adb shell "sh $W/prepare.sh"
adb shell "LD_LIBRARY_PATH=$W/links:$W/lib $W/lib/libnode_exec.so -v" | tee "$LOGS/node-version.txt"
adb shell "LD_LIBRARY_PATH=$W/links:$W/lib $W/lib/libbash_exec.so -c 'echo bash \$BASH_VERSION'" | tee -a "$LOGS/node-version.txt"
adb shell "nohup sh $W/run.sh > /dev/null 2>&1 &"
TOKEN=""
start=$(date +%s)
for _ in $(seq 1 300); do
  TOKEN=$(adb shell "cat $W/dsh.log 2>/dev/null" | tr -d '\r' | sed -n 's#^dsh web: http://127\.0\.0\.1:[0-9]*/?token=\([A-Za-z0-9_-]*\).*#\1#p' | head -1)
  [ -n "$TOKEN" ] && break
  sleep 2
done
adb shell "cat $W/dsh.log" > "$LOGS/host-engine.log" 2>&1
if [ -n "$TOKEN" ]; then
  pass "host engine (Termux node, no PRoot) printed its token line on Android after $(( $(date +%s) - start ))s"
  adb forward tcp:38555 tcp:38555 > /dev/null
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:38555/?token=$TOKEN")
  [ "$code" = 303 ] && pass "token exchange on Android -> 303" || fail "token exchange on Android -> $code"
  grep -q "\[parakeet-root-shell\] registered" "$LOGS/host-engine.log" && pass "root-shell plugin registered on Android" || fail "root-shell plugin not registered on Android"
  # Root probe through a fake su (PARAKEET_SU, the override CI and the app use): the
  # plugin's own su.js, run by the Termux node on Android, must see uid 0.
  printf '%s\n' '#!/system/bin/sh' '[ "$1" = -c ] && shift' 'if [ "$1" = id ]; then echo "uid=0(root) gid=0(root) context=u:r:su:s0"; exit 0; fi' 'exec /system/bin/sh -c "$1"' > "$T/fakesu"
  adb push "$T/fakesu" "$W/fakesu" > /dev/null
  adb shell "chmod 755 $W/fakesu"
  SUJS="$R/opt/dsh/node_modules/@parakeet/dsh-plugin-root-shell/lib/su.js"
  probe=$(adb shell "cd $R && PARAKEET_SU=$W/fakesu LD_LIBRARY_PATH=$W/links:$W/lib $W/lib/libnode_exec.so --input-type=module -e \"import {probeRoot, runAsRoot} from '$SUJS'; const p = probeRoot(); console.log(JSON.stringify(p));\"" 2>&1 | tr -d '\r')
  echo "$probe" | tee "$LOGS/root-probe.txt"
  echo "$probe" | grep -q '"available":true' && echo "$probe" | grep -q '"uid":0' \
    && pass "root-shell su.js probe sees uid 0 through a fake su on Android" || fail "root probe through fake su: $probe"
else
  fail "host engine did not start on Android"; tail -60 "$LOGS/host-engine.log"
fi
adb shell "kill \$(cat $R/tmp/dsh-web.pid) 2>/dev/null"

# ---- 2. the APK itself ----------------------------------------------------
if adb install -r -g "$APK" > "$LOGS/install.txt" 2>&1; then pass "APK installs"; else fail "APK install"; cat "$LOGS/install.txt"; fi
adb logcat -c || true
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
sleep 25
if adb shell pidof "$PKG" > /dev/null; then pass "app process alive 25 s after launch"; else fail "app not running after launch"; fi
adb shell dumpsys package "$PKG" | grep -E "versionName|flags=" | head -3 | tee "$LOGS/package.txt"
adb exec-out screencap -p > "$LOGS/screen.png" 2>/dev/null || true
adb logcat -d > "$LOGS/logcat.txt" 2>&1 || true
grep -E "FATAL EXCEPTION|AndroidRuntime: " "$LOGS/logcat.txt" | head -20 && fail "crash in logcat" || pass "no FATAL EXCEPTION in logcat"
exit $FAILED
