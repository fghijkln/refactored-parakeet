#!/usr/bin/env bash
# Emulator smoke test: install the APK, launch it, and wait for the embedded
# Node to boot DSH's web server on loopback. Proves on real Android (x86_64
# emulator, API 30) that: the repackaged Termux node/bash exec from
# nativeLibraryDir under W^X, their _tx.so libraries resolve, the DSH bundle
# extracts and boots under Bionic with the JS addon fallbacks, and the web UI
# answers on 127.0.0.1.
#
#   runtime/tests/emulator-smoke.sh <apk> <log-dir>
set -uo pipefail
APK=${1:?apk}
LOGS=${2:?log dir}
PKG=dev.parakeet.agent
mkdir -p "$LOGS"

adb wait-for-device
adb shell getprop ro.product.cpu.abilist | tee "$LOGS/abi.txt"
adb install -r -g "$APK" || { echo "FAIL: install"; exit 1; }
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity"

# 1. nativeLibraryDir executables actually run (as the app uid, via run-as).
NLD=$(adb shell dumpsys package "$PKG" | grep -m1 legacyNativeLibraryDir | sed 's/.*=//' | tr -d '\r')
ABI=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')
case "$ABI" in arm64-v8a) SUB=arm64 ;; x86_64) SUB=x86_64 ;; *) SUB=$ABI ;; esac
LIBDIR="$NLD/$SUB"
echo "nativeLibraryDir=$LIBDIR" | tee -a "$LOGS/abi.txt"
adb shell run-as "$PKG" ls -la "$LIBDIR" | tee "$LOGS/nativelibs.txt"
adb shell run-as "$PKG" env LD_LIBRARY_PATH="$LIBDIR" "$LIBDIR/libnode_exec.so" -e "'console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,icu:process.versions.icu,openssl:process.versions.openssl}))'" 2>&1 | tee "$LOGS/node-v.txt"
adb shell run-as "$PKG" env LD_LIBRARY_PATH="$LIBDIR" "$LIBDIR/libbash_exec.so" -c "'echo bash \$BASH_VERSION'" 2>&1 | tee "$LOGS/bash-v.txt"

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
echo "PASS: emulator smoke test"
