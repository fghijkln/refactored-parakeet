#!/usr/bin/env bash
# Emulator smoke test: install the APK, launch it, and wait for the embedded
# Node to boot DSH's web server on loopback. Proves on real Android (x86_64
# emulator, API 30) that: the repackaged Termux node/bash exec from
# nativeLibraryDir under W^X, their _tx.so libraries resolve, the DSH bundle
# extracts and boots under Bionic with the JS addon fallbacks, and the web UI
# answers on 127.0.0.1.
#
#   runtime/tests/emulator-smoke.sh <apk> <log-dir> [baseline-apk-url]
#
# With a baseline APK (the previous release), both builds are timed the same
# way on this emulator: launch -> "dsh web:" banner in logcat, first launch
# (includes runtime extraction) and a warm relaunch after force-stop.
set -uo pipefail
APK=${1:?apk}
LOGS=${2:?log dir}
BASELINE_URL=${3:-}
PKG=dev.parakeet.agent
mkdir -p "$LOGS"
TIMING="$LOGS/startup-timing.txt"
: > "$TIMING"

# ms from `am start` to the server banner (polling every 250 ms).
time_launch() {
  local label=$1 s n
  adb shell am force-stop "$PKG"; sleep 1
  adb logcat -c
  s=$(date +%s%N)
  adb shell am start -n "$PKG/.MainActivity" > /dev/null
  for n in $(seq 1 2400); do
    adb logcat -d -s parakeet:I | grep -q "dsh web: http://127.0.0.1" && break
    sleep 0.25
  done
  if adb logcat -d -s parakeet:I | grep -q "dsh web: http://127.0.0.1"; then
    echo "$label: $(( ($(date +%s%N) - s) / 1000000 )) ms  $(adb logcat -d -s parakeet:I | grep -o 'parakeet-timing:.*' | tr '\n' ' ')" | tee -a "$TIMING"
  else
    echo "$label: did not come up" | tee -a "$TIMING"
  fi
}

adb wait-for-device
adb shell getprop ro.product.cpu.abilist | tee "$LOGS/abi.txt"

if [ -n "$BASELINE_URL" ] && curl -fsSL -o "$LOGS/baseline.apk" "$BASELINE_URL"; then
  adb install -r -g "$LOGS/baseline.apk" > /dev/null && {
    time_launch "before (v0.1.0) first launch"
    time_launch "before (v0.1.0) warm relaunch"
    time_launch "before (v0.1.0) warm relaunch 2"
    adb logcat -d -s parakeet:V > "$LOGS/logcat-baseline.txt"
    adb uninstall "$PKG" > /dev/null
  }
  rm -f "$LOGS/baseline.apk"
fi

adb install -r -g "$APK" || { echo "FAIL: install"; exit 1; }
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity"

# 1. the same binaries under the shell uid in /data/local/tmp, where a crash
# produces a readable tombstone (the app's own crash is silent in logcat).
# The ELFs are unmodified Termux builds, so give them their sonames via
# symlinks exactly as the app does (filesDir/termux-lib).
ABI=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')
adb logcat -c -b crash 2>/dev/null || true
rm -rf "$LOGS/apk" && mkdir -p "$LOGS/apk"
unzip -o -q "$APK" "lib/$ABI/*" "assets/termux-manifest-$ABI.json" -d "$LOGS/apk"
adb shell rm -rf /data/local/tmp/pk; adb shell mkdir -p /data/local/tmp/pk/sl
adb push "$LOGS/apk/lib/$ABI/." /data/local/tmp/pk > /dev/null
adb shell chmod 755 /data/local/tmp/pk/'*.so'
python3 - "$LOGS/apk/assets/termux-manifest-$ABI.json" > "$LOGS/links.sh" <<'PY'
import json, sys
for so, flat in json.load(open(sys.argv[1]))["sonames"].items():
    print(f"ln -sf /data/local/tmp/pk/{flat} '/data/local/tmp/pk/sl/{so}'")
PY
adb shell "$(cat "$LOGS/links.sh")"
adb shell ls -la /data/local/tmp/pk/sl > "$LOGS/links-tmp.txt" 2>&1
TLD=/data/local/tmp/pk/sl:/data/local/tmp/pk
echo "--- node from /data/local/tmp (shell uid)" | tee "$LOGS/node-tmp.txt"
adb shell "cd /data/local/tmp/pk && LD_LIBRARY_PATH=$TLD ./libnode_exec.so -p 'process.version+\" \"+process.platform+\" \"+process.arch+\" icu=\"+process.versions.icu+\" openssl=\"+process.versions.openssl'; echo exit=\$?" 2>&1 | tee -a "$LOGS/node-tmp.txt"
adb shell "cd /data/local/tmp/pk && LD_LIBRARY_PATH=$TLD ./libbash_exec.so -c 'echo bash-ok \$BASH_VERSION'; echo exit=\$?" 2>&1 | tee -a "$LOGS/node-tmp.txt"
adb logcat -d -b crash > "$LOGS/tombstone.txt" 2>&1
adb logcat -d -s DEBUG:V linker:V > "$LOGS/linker.txt" 2>&1
sed -n 1,80p "$LOGS/tombstone.txt"
sed -n 1,40p "$LOGS/linker.txt"

# 2. the app boots DSH (first launch unzips the runtime; allow a few minutes).
OK=""
for i in $(seq 1 150); do
  if adb logcat -d -s parakeet:I | grep -q "dsh web: http://127.0.0.1"; then OK=1; break; fi
  if adb logcat -d -s parakeet:E | grep -q "Runtime exited\|Runtime failed\|No Node runtime"; then break; fi
  sleep 4
done
adb logcat -d -s parakeet:V > "$LOGS/logcat-parakeet.txt"
adb logcat -d > "$LOGS/logcat-full.txt"
adb shell run-as "$PKG" cat files/dsh.log > "$LOGS/dsh.log" 2>&1
adb shell run-as "$PKG" cat files/dsh-home/parakeet.patch.yml > "$LOGS/parakeet.patch.yml" 2>&1
adb exec-out screencap -p > "$LOGS/screen.png" 2>/dev/null

# 1b. nativeLibraryDir executables as the app uid (run-as), using the soname
# links the app created. sh -c, not env: the app path contains '=' segments,
# which env(1) would take for VAR=value assignments.
NLD=$(adb shell dumpsys package "$PKG" | grep -m1 legacyNativeLibraryDir | sed 's/^[^=]*=//' | tr -d '\r')
case "$ABI" in arm64-v8a) SUB=arm64 ;; *) SUB=$ABI ;; esac
LIBDIR="$NLD/$SUB"
APPLD="/data/data/$PKG/files/termux-lib:$LIBDIR"
echo "nativeLibraryDir=$LIBDIR" | tee -a "$LOGS/abi.txt"
adb shell run-as "$PKG" ls -la "$LIBDIR" files/termux-lib > "$LOGS/nativelibs.txt" 2>&1
adb shell "run-as $PKG sh -c 'LD_LIBRARY_PATH=$APPLD $LIBDIR/libnode_exec.so -e \"console.log(JSON.stringify({node:process.version,arch:process.arch}))\"'" 2>&1 | tee "$LOGS/node-v.txt"
adb shell "run-as $PKG sh -c 'LD_LIBRARY_PATH=$APPLD $LIBDIR/libbash_exec.so -c \"echo bash \\\$BASH_VERSION\"'" 2>&1 | tee "$LOGS/bash-v.txt"
tail -60 "$LOGS/logcat-parakeet.txt"

if grep -q '"node":"v24' "$LOGS/node-v.txt"; then echo "PASS: node runs from nativeLibraryDir via run-as: $(cat "$LOGS/node-v.txt")"
else echo "WARN: run-as exec of node failed (run-as context differs from the app's); relying on the in-app self-test"; fi
grep -q 'parakeet selftest: {"node":"v24' "$LOGS/logcat-parakeet.txt" || { echo "FAIL: in-app node self-test did not pass"; exit 1; }
echo "PASS: in-app node self-test: $(grep -m1 'parakeet selftest' "$LOGS/logcat-parakeet.txt")"
[ -n "$OK" ] || { echo "FAIL: DSH web server did not come up"; exit 1; }
echo "PASS: DSH web server is up inside the app"

# 3. the web UI answers on the device's loopback.
URL=$(grep -o "http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*" "$LOGS/logcat-parakeet.txt" | head -1)
PORT=$(echo "$URL" | sed -E 's#http://127.0.0.1:([0-9]+)/.*#\1#')
adb forward tcp:18080 tcp:"$PORT"
CODE=$(curl -s -o "$LOGS/index.html" -w '%{http_code}' -L -c "$LOGS/cj" -b "$LOGS/cj" "http://127.0.0.1:18080/?${URL#*\?}")
echo "GET web UI via adb forward -> $CODE"
[ "$CODE" = "200" ] || { echo "FAIL: web UI returned $CODE"; exit 1; }
grep -q "did not activate" "$LOGS/dsh.log" && { echo "WARN: some DSH plugins did not activate on Android:"; grep -A3 "did not activate" "$LOGS/dsh.log"; }
# 4. startup timing of this build, measured like the baseline.
FIRST=$(grep -o 'parakeet-timing:.*' "$LOGS/logcat-parakeet.txt" | tr '\n' ' ')
echo "after (this build) first launch: see logcat  $FIRST" | tee -a "$TIMING"
time_launch "after (this build) warm relaunch"
time_launch "after (this build) warm relaunch 2"
adb shell pm clear "$PKG" > /dev/null
time_launch "after (this build) first launch (after pm clear)"
adb logcat -d -s parakeet:V > "$LOGS/logcat-warm.txt"
echo "--- startup timing (ms, emulator API 30 x86_64, swiftshader)"; cat "$TIMING"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '### Startup timing on the CI emulator'; echo '```'; cat "$TIMING"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
echo "PASS: emulator smoke test"
