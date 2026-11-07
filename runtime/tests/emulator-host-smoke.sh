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
# 3. The app's OWN engine start (DshService START + install_first, sent as root since the
#    service is not exported) unpacks the runtime, reaches ready and answers HTTP; children
#    launched through the app's wrappers with a cleared environment as the app's uid get
#    TLS (system CA bundle), a here-document, a shell and a c-ares channel.
#
# 0. First, like a phone that also has Termux: /data/data/com.termux/files/usr/... exists
#    but is unreadable (0700, another uid; openssl.cnf 000), so every path Termux compiled
#    into its ELFs is EACCES, not ENOENT (v0.2.0 died on a real phone this way while this
#    test passed). App data isolation is turned off so the app process sees that tree too.
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

# ---- 0. an installed-but-unreadable Termux ----------------------------------
TX=/data/data/com.termux/files
adb root > /dev/null 2>&1; sleep 3; adb wait-for-device
adb shell "id -u" | tr -d '\r' | tee "$LOGS/root.txt"
# Android 11+ hides other apps' data dirs from app processes (ENOENT); a phone where the
# user saw EACCES does not. Read once by system_server at boot: restart the framework.
old_ss=$(adb shell pidof system_server | tr -d '\r')
adb shell "setprop persist.zygote.app_data_isolation false; setprop sys.boot_completed 0; stop; start"
for _ in $(seq 1 120); do
  ss=$(adb shell pidof system_server 2>/dev/null | tr -d '\r')
  [ -n "$ss" ] && [ "$ss" != "$old_ss" ] && [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ] && break
  sleep 2
done
echo "system_server $old_ss -> ${ss:-none}, boot_completed=$(adb shell getprop sys.boot_completed | tr -d '\r')" | tee -a "$LOGS/root.txt"
# After the framework restart: at boot the package manager deletes data dirs of packages
# that are not installed, which took the first version of this tree with it.
adb shell "mkdir -p $TX/usr/etc/tls/certs $TX/usr/lib/ossl-modules $TX/usr/lib/engines-3 $TX/usr/tmp $TX/usr/bin $TX/usr/share/terminfo $TX/home \
  && printf 'openssl_conf = termux_conf\n[termux_conf]\n' > $TX/usr/etc/tls/openssl.cnf \
  && echo 'nameserver 8.8.8.8' > $TX/usr/etc/resolv.conf && echo '127.0.0.1 localhost' > $TX/usr/etc/hosts \
  && echo 'echo TERMUX_PROFILE_READ' > $TX/usr/etc/profile && echo 'echo TERMUX_BASHRC_READ' > $TX/usr/etc/bash.bashrc \
  && : > $TX/usr/etc/inputrc && : > $TX/usr/etc/tls/cert.pem \
  && chown -R 10999:10999 /data/data/com.termux && chmod -R 700 /data/data/com.termux && chmod 000 $TX/usr/etc/tls/openssl.cnf" \
  || fail "fake Termux tree"
adb shell "ls -ldZ /data/data/com.termux $TX/usr/etc/tls/openssl.cnf" >> "$LOGS/root.txt" 2>&1
adb unroot > /dev/null 2>&1; sleep 3; adb wait-for-device
adb shell "id -u; cat $TX/usr/etc/tls/openssl.cnf" > "$LOGS/termux-eacces.txt" 2>&1
grep -q "Permission denied" "$LOGS/termux-eacces.txt" && pass "fake Termux tree is EACCES to the shell uid" \
  || { fail "fake Termux tree readable: $(tr -d '\r' < "$LOGS/termux-eacces.txt")"; }

# ---- 1. host engine from /data/local/tmp ---------------------------------
W=/data/local/tmp/pk
T=$(mktemp -d)
unzip -q -o "$APK" 'lib/x86_64/*' -d "$T/apk"
ASSETS="$OUT/x86_64/assets/runtime"
ARCHIVE="$ASSETS/$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["rootfs"])' "$ASSETS/manifest.json")"
adb shell "rm -rf $W && mkdir -p $W/lib $W/links $W/rootfs"
adb push "$T/apk/lib/x86_64/." "$W/lib/" > /dev/null
# Android's toybox tar has no xz support: decompress on the host, push a plain tar.
xz -dc "$ARCHIVE" > "$T/rootfs.tar"
adb push "$T/rootfs.tar" "$W/rootfs.tar" > /dev/null
adb push "$ASSETS/termux-manifest.json" "$W/termux-manifest.json" > /dev/null
adb shell "cd $W/rootfs && tar -xf ../rootfs.tar && rm ../rootfs.tar" || fail "rootfs extract on device"
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
d = f"{R}/opt/dsh-app/direct"
tls = {"OPENSSL_CONF": f"{d}/tls/openssl.cnf", "OPENSSL_MODULES": f"{d}/ossl-modules", "OPENSSL_ENGINES": f"{d}/engines-3",
       "CTLOG_FILE": f"{d}/tls/ct_log_list.cnf", "SSL_CERT_DIR": f"{d}/tls/certs", "INPUTRC": f"{d}/inputrc", "SSL_CERT_FILE": f"{d}/tls/cert.pem"}
print(f"mkdir -p {b} {d}/tls/certs {d}/ossl-modules {d}/engines-3 && : > {d}/tls/ct_log_list.cnf && : > {d}/inputrc")
print(f"printf 'openssl_conf = openssl_init\\nnodejs_conf = openssl_init\\n[openssl_init]\\n' > {d}/tls/openssl.cnf")
print(f"for f in /system/etc/security/cacerts/*; do sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' \"$f\"; done > {d}/tls/cert.pem")
exports = " ".join(f"{k}={v}" for k, v in tls.items())
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
print(f"export {exports}")
print(f"export DSH_GO_RUNTIME_ROOT={R} DSH_GO_DIRECT_ROOTFS={R} DSH_GO_DIRECT_MAIN=1 DSH_TELEMETRY_DISABLED=1 DEEPSEEK_API_KEY=sk-parakeet-smoke")
print(f"exec {W}/lib/libnode_exec.so --expose-internals --import={R}/opt/dsh-go/direct/host-preload.mjs {R}/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js " + " ".join(web) + f" > {W}/dsh.log 2>&1")
print("EOF")
PY
adb push "$T/prepare.sh" "$W/prepare.sh" > /dev/null
adb shell "sh $W/prepare.sh"
adb shell "OPENSSL_CONF=$R/opt/dsh-app/direct/tls/openssl.cnf LD_LIBRARY_PATH=$W/links:$W/lib $W/lib/libnode_exec.so -v" | tee "$LOGS/node-version.txt"
adb shell "LD_LIBRARY_PATH=$W/links:$W/lib $W/lib/libbash_exec.so -c 'echo bash \$BASH_VERSION'" | tee -a "$LOGS/node-version.txt"
# Negative control: without our OPENSSL_CONF, Termux's node must hit the v0.2.0 failure here.
adb shell "LD_LIBRARY_PATH=$W/links:$W/lib $W/lib/libnode_exec.so -e 0; echo exit=\$?" > "$LOGS/negative-control.txt" 2>&1
grep -q "OpenSSL configuration error" "$LOGS/negative-control.txt" \
  && pass "reproduced: Termux node without OPENSSL_CONF dies on the unreadable Termux openssl.cnf" \
  || fail "did not reproduce the EACCES OpenSSL failure: $(tr -d '\r' < "$LOGS/negative-control.txt" | tail -3)"
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
  probe=$(adb shell "cd $R && OPENSSL_CONF=$R/opt/dsh-app/direct/tls/openssl.cnf PARAKEET_SU=$W/fakesu LD_LIBRARY_PATH=$W/links:$W/lib $W/lib/libnode_exec.so --input-type=module -e \"import {probeRoot, runAsRoot} from '$SUJS'; const p = probeRoot(); console.log(JSON.stringify(p));\"" 2>&1 | tr -d '\r')
  echo "$probe" | tee "$LOGS/root-probe.txt"
  echo "$probe" | grep -q '"available":true' && echo "$probe" | grep -q '"uid":0' \
    && pass "root-shell su.js probe sees uid 0 through a fake su on Android" || fail "root probe through fake su: $probe"

  # Root mode end to end on Android: root-exec-live.mjs (the runtime job's agent-turn
  # test) under the APK's Termux node with the runtime's own host-preload.mjs, its mock
  # model on 127.0.0.1 in the device, and PARAKEET_SU = a fake su whose backend is the
  # emulator's real /system/xbin/su (uid 0 from the kernel). The shell uid stands in for
  # the app here: the emulator's su only serves root and shell callers.
  adb shell "mkdir -p $W/tests/fixtures $W/live"
  adb push "$(dirname "$0")/root-exec-live.mjs" "$W/tests/" > /dev/null
  adb push "$(dirname "$0")/fixtures/parakeet-approve-all.mjs" "$W/tests/fixtures/" > /dev/null
  D=$R/opt/dsh-app/direct
  cat > "$T/live.sh" <<EOF
cd $W/tests || exit 1
export PATH=$R/opt/dsh-app/direct/bin:/system/bin LD_LIBRARY_PATH=$W/links:$W/lib
export OPENSSL_CONF=$D/tls/openssl.cnf OPENSSL_MODULES=$D/ossl-modules OPENSSL_ENGINES=$D/engines-3 SSL_CERT_FILE=$D/tls/cert.pem SSL_CERT_DIR=$D/tls/certs INPUTRC=$D/inputrc
export DSH_GO_RUNTIME_ROOT=$R DSH_GO_DIRECT_ROOTFS=$R DSH_PREFIX=$R/opt/dsh TMPDIR=$W/live
export PARAKEET_LIVE_PRELOAD=$R/opt/dsh-go/direct/host-preload.mjs PARAKEET_LIVE_SH=/system/bin/sh PARAKEET_LIVE_TMP=$W/live
export PARAKEET_LIVE_SU_EXEC='/system/xbin/su 0 /system/bin/sh -c "\$2"'
export PARAKEET_LIVE_PASS_ENV=LD_LIBRARY_PATH,OPENSSL_CONF,OPENSSL_MODULES,OPENSSL_ENGINES,SSL_CERT_FILE,SSL_CERT_DIR,INPUTRC,DSH_GO_RUNTIME_ROOT,DSH_GO_DIRECT_ROOTFS
echo "runner uid \$(id -u); real su: \$(/system/xbin/su 0 /system/bin/sh -c 'id -u' 2>&1)"
exec $W/lib/libnode_exec.so --expose-internals root-exec-live.mjs
EOF
  adb push "$T/live.sh" "$W/live.sh" > /dev/null
  # The session store commits with link(2); SELinux gives the shell domain no `link` on
  # shell_data_file (/data/local/tmp), while the app's own domain has it in its data dir.
  # Permissive only for these agent turns; the denials are kept in the log.
  adb shell "/system/xbin/su 0 setenforce 0; getenforce" >> "$LOGS/root-exec-android.txt" 2>&1
  adb shell "sh $W/live.sh" >> "$LOGS/root-exec-android.txt" 2>&1
  # Phone MCP under the host engine (v0.2.3): a real agent turn whose `phone` MCP row names
  # guest paths (/opt/..., /var/... as v0.2.2 wrote them) and host paths (as the app writes
  # them now); the relay the APK writes must reach a fake bridge, DSH must list and call
  # mcp__phone__screen. The runtime tree is the real one extracted above.
  adb push "$(dirname "$0")/phone-mcp-host-live.mjs" "$W/tests/" > /dev/null
  adb push "$(dirname "$0")/../../app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/phone/PhoneGuest.kt" "$W/tests/PhoneGuest.kt" > /dev/null
  sed -e 's#root-exec-live.mjs#phone-mcp-host-live.mjs#' -e "s#^export PARAKEET_LIVE_PRELOAD=.*#export PARAKEET_LIVE_ROOTFS=$R PARAKEET_LIVE_PHONE_GUEST=$W/tests/PhoneGuest.kt PARAKEET_LIVE_TMP=$W/live#" \
    "$T/live.sh" > "$T/phone-live.sh"
  adb push "$T/phone-live.sh" "$W/phone-live.sh" > /dev/null
  adb shell "sh $W/phone-live.sh" > "$LOGS/phone-mcp-android.txt" 2>&1
  adb shell "/system/xbin/su 0 setenforce 1; getenforce" >> "$LOGS/root-exec-android.txt" 2>&1
  adb shell "/system/xbin/su 0 dmesg | grep 'avc:.*denied.*link' | tail -5" >> "$LOGS/root-exec-android.txt" 2>&1
  tr -d '\r' < "$LOGS/root-exec-android.txt" | tail -40
  rel() { grep "\"case\":\"$1\",\"status\":\"PASS\"" "$LOGS/root-exec-android.txt" | tr -d '\r'; }
  r=$(rel granted-uid0); echo "$r" | grep -q '"result":"0\\nPARAKEET_MARK' \
    && pass "Android agent turn, Root on: id -u = 0 through the real su" || fail "Android agent turn, Root on: no uid 0 ($r)"
  r=$(rel off-no-su); [ -n "$r" ] && ! echo "$r" | grep -q '"result":"0\\n' \
    && pass "Android agent turn, Root off: id -u is the engine's uid, su unused ($(echo "$r" | grep -o '"result":"[0-9]*'))" || fail "Android agent turn, Root off ($r)"
  [ -n "$(rel brick-asks)" ] && pass "Android agent turn, Root on: /dev/block dd stopped at the approval, never ran" || fail "Android agent turn: brick-risk dd not stopped"
  [ -n "$(rel brick-allowed)" ] && pass "Android agent turn, Root on: brick-risk command runs once approved" || fail "Android agent turn: approved brick-risk command"
  [ -n "$(rel ordinary-no-ask)" ] && pass "Android agent turn, Root on: ordinary root command needs no approval" || fail "Android agent turn: ordinary root command"
  tr -d '\r' < "$LOGS/phone-mcp-android.txt" | tail -20
  prel() { grep "\"case\":\"$1\",\"status\":\"PASS\"" "$LOGS/phone-mcp-android.txt" | tr -d '\r'; }
  r=$(prel guest-paths); [ -n "$r" ] \
    && pass "Android host engine: phone MCP row with GUEST paths connects (tools/list + tools/call through the relay; $(echo "$r" | grep -o '"config":"[^"]*"'))" \
    || fail "Android host engine: phone MCP with guest paths not connected ($(grep -o '"case":"guest-paths","status":"FAIL".\{0,400\}' "$LOGS/phone-mcp-android.txt" | head -1))"
  [ -n "$(prel host-paths)" ] && pass "Android host engine: phone MCP row with host paths (as the app writes it) connects" \
    || fail "Android host engine: phone MCP with host paths not connected"
  [ -n "$(prel relay-alone)" ] && pass "Android: the relay alone (no preload) resolves the guest bridge.json in its own tree" \
    || fail "Android: relay fallback"
else
  fail "host engine did not start on Android"; tail -60 "$LOGS/host-engine.log"
fi
adb shell "kill \$(cat $R/tmp/dsh-web.pid) 2>/dev/null"

# ---- 2. the APK itself ----------------------------------------------------
adb root > /dev/null 2>&1; sleep 3; adb wait-for-device
if adb install -r -g "$APK" > "$LOGS/install.txt" 2>&1; then pass "APK installs"; else fail "APK install"; cat "$LOGS/install.txt"; fi
adb logcat -c || true
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
sleep 25
APP_PID=$(adb shell pidof "$PKG" | tr -d '\r')
if [ -n "$APP_PID" ]; then pass "app process alive 25 s after launch"; else fail "app not running after launch"; fi
adb shell dumpsys package "$PKG" | grep -E "versionName|flags=" | head -3 | tee "$LOGS/package.txt"
if [ -n "$APP_PID" ]; then
  adb shell "grep -E ' /data/(data|user/0) ' /proc/$APP_PID/mountinfo" > "$LOGS/app-mounts.txt" 2>&1
  if grep -q tmpfs "$LOGS/app-mounts.txt"; then echo "NOTE app data isolation still on: the app process sees ENOENT for Termux" | tee -a "$LOGS/summary.txt"
  else echo "NOTE app data isolation off: the app process sees the EACCES Termux tree" | tee -a "$LOGS/summary.txt"; fi
fi

# ---- 3. the app's own engine ---------------------------------------------
FILES=/data/user/0/$PKG/files
APPLOG=$FILES/runtime/logs/dsh.log
# Phone control switched on (its SharedPreferences, written while the app is stopped), so the
# app's own launch mounts the `phone` MCP server; accessibility is not needed for that.
adb shell am force-stop "$PKG"
APP_UID0=$(adb shell dumpsys package "$PKG" | tr -d '\r' | sed -n 's/.*userId=\([0-9]*\).*/\1/p' | head -1)
adb shell "mkdir -p /data/user/0/$PKG/shared_prefs && printf '%s\n' \"<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\" '<map>' '    <boolean name=\"enabled\" value=\"true\" />' '</map>' > /data/user/0/$PKG/shared_prefs/dsh_phone.xml \
  && chown $APP_UID0:$APP_UID0 /data/user/0/$PKG/shared_prefs /data/user/0/$PKG/shared_prefs/dsh_phone.xml && chmod 660 /data/user/0/$PKG/shared_prefs/dsh_phone.xml \
  && restorecon -R /data/user/0/$PKG/shared_prefs" > "$LOGS/phone-prefs.txt" 2>&1 || fail "could not switch phone control on ($(cat "$LOGS/phone-prefs.txt"))"
adb shell am start-foreground-service -n "$PKG/io.github.ccch1mneyyy.dsh_app.runtime.DshService" \
  -a io.github.ccch1mneyyy.dsh_app.START --ez install_first true > "$LOGS/app-start.txt" 2>&1
start=$(date +%s); READY=""
for _ in $(seq 1 180); do
  adb shell "cat $APPLOG 2>/dev/null" | tr -d '\r' > "$LOGS/app-engine.log"
  grep -q '\[dsh-app\] startup:' "$LOGS/app-engine.log" && { READY=1; break; }
  grep -qE 'OpenSSL configuration error|launch failed|DSH exited with|\[dsh-app\] install failed' "$LOGS/app-engine.log" && break
  sleep 2
done
if [ -n "$READY" ]; then
  pass "app's own engine reached ready after $(( $(date +%s) - start ))s ($(grep -o '\[dsh-app\] startup:.*' "$LOGS/app-engine.log" | tail -1))"
  PORT=$(grep -oE '(listening at|dsh web:) http://127\.0\.0\.1:[0-9]+' "$LOGS/app-engine.log" | tail -1 | grep -oE '[0-9]+$')
  if [ -n "$PORT" ]; then
    adb forward tcp:38666 tcp:"$PORT" > /dev/null
    code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "http://127.0.0.1:38666/")
    [ "$code" != 000 ] && pass "app's engine answers HTTP on :$PORT ($code)" || fail "app's engine on :$PORT does not answer HTTP"
  else
    fail "app's engine: no 'dsh web:' port line in its log"
  fi
else
  fail "app's own engine did not reach ready"; tail -60 "$LOGS/app-engine.log"
fi
# The app's own engine with phone control on: the bridge must see DSH list the phone tools
# (PhoneControl logs it), not only listen; the relay's report names the host bridge.json.
if [ -n "$READY" ]; then
  MCP=""
  for _ in $(seq 1 30); do
    adb shell "cat $APPLOG 2>/dev/null" | tr -d '\r' > "$LOGS/app-engine.log"
    grep -q 'phone control: MCP server connected' "$LOGS/app-engine.log" && { MCP=1; break; }
    sleep 2
  done
  grep -E 'phone (bridge|control)|phone-relay' "$LOGS/app-engine.log" | tail -8 | tee "$LOGS/app-phone.txt"
  RELAY=$(adb shell "find $FILES -path '*/opt/dsh-app/phone/relay-status.json' -exec cat {} \\; 2>/dev/null" | tr -d '\r' | head -1)
  echo "relay-status: $RELAY" | tee -a "$LOGS/app-phone.txt"
  if [ -n "$MCP" ]; then pass "app's own engine: phone MCP server connected (DSH listed the phone tools over the bridge)"
  else fail "app's own engine: phone MCP server never connected ($(grep -E 'phone control' "$LOGS/app-engine.log" | tail -2 | tr '\n' ' '))"; fi
  case "$RELAY" in
    *'"ok":true'*'"config":"/data/'*) pass "relay read the host-path bridge.json ($(echo "$RELAY" | grep -o '"config":"[^"]*"'))" ;;
    *) fail "relay status: ${RELAY:-none}" ;;
  esac
fi
grep -nE 'OpenSSL configuration error|com\.termux.*(Permission denied|EACCES)|(Permission denied|EACCES).*com\.termux' "$LOGS/app-engine.log" \
  && fail "Termux path errors in the app's engine log" || pass "no Termux path errors in the app's engine log"

# Children through the app's own wrappers, as the app's uid, with a cleared environment:
# the wrappers' defaults must keep every Termux path away.
APP_UID=$(adb shell dumpsys package "$PKG" | tr -d '\r' | sed -n 's/.*userId=\([0-9]*\).*/\1/p' | head -1)
BIN=$(adb shell "find $FILES -path '*/opt/dsh-app/direct/bin/node' 2>/dev/null" | tr -d '\r' | head -1); BIN=${BIN%/node}
echo "app uid $APP_UID, bin $BIN" | tee -a "$LOGS/root.txt"
asapp() { adb shell "su $APP_UID /system/bin/sh -c \"cd /; env -i PATH=$BIN:/system/bin $*\"" 2>&1 | tr -d '\r'; }
if [ -n "$APP_UID" ] && [ -n "$BIN" ]; then
  cat > "$T/child.js" <<'JS'
const out = (k, v) => console.log(`${k}=${v}`);
out('tmpdir', require('os').tmpdir()); out('home', require('os').homedir());
try { new (require('dns').Resolver)(); out('cares', 'ok'); } catch (e) { out('cares', `ERR ${e.code ?? ''} ${e.message}`); }
out('shell', require('child_process').execSync('echo shell-ok', { encoding: 'utf8' }).trim());
require('https').get('https://registry.npmjs.org/', { timeout: 20000 }, (r) => { out('https', r.statusCode); process.exit(0); })
  .on('error', (e) => { out('https', `ERR ${e.code} ${e.message}`); process.exit(0); })
  .on('timeout', function () { this.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
JS
  adb push "$T/child.js" /data/local/tmp/parakeet-child.js > /dev/null; adb shell chmod 644 /data/local/tmp/parakeet-child.js
  r=$(asapp "node /data/local/tmp/parakeet-child.js"); echo "$r" | tee "$LOGS/app-children.txt"
  echo "$r" | grep -q '^tmpdir=.*com.termux' && fail "child node os.tmpdir() is Termux's" || pass "child node tmpdir/home are the app's ($(echo "$r" | grep -E '^(tmpdir|home)=' | tr '\n' ' '))"
  echo "$r" | grep -q '^shell=shell-ok' && pass "child node exec() shell works" || fail "child node exec(): $r"
  echo "$r" | grep -q '^cares=ok' && pass "c-ares channel initialises" || fail "c-ares channel: $(echo "$r" | grep '^cares=')"
  h=$(echo "$r" | grep '^https=')
  case "$h" in
    https=[0-9]*) pass "child node HTTPS with the system CA bundle ($h)" ;;
    *CERT*|*UNABLE_TO*|*SELF_SIGNED*|*certificate*) fail "child node TLS trust: $h" ;;
    *) echo "WARN child node HTTPS (network?): $h" | tee -a "$LOGS/summary.txt" ;;
  esac
  printf '%s\n' 'cat <<EOF' 'heredoc-ok' 'EOF' > "$T/heredoc.sh"
  adb push "$T/heredoc.sh" /data/local/tmp/parakeet-heredoc.sh > /dev/null; adb shell chmod 644 /data/local/tmp/parakeet-heredoc.sh
  hd=$(asapp "bash /data/local/tmp/parakeet-heredoc.sh"); echo "bash: $hd" >> "$LOGS/app-children.txt"
  li=$(asapp "bash -lic 'echo login-ok'"); echo "bash -li: $li" >> "$LOGS/app-children.txt"
  echo "$li" | grep -q 'TERMUX_\|com.termux' && fail "bash reads Termux's profile/bashrc: $li" || pass "interactive login bash reads no Termux profile/bashrc"
else
  fail "could not find the app's uid ($APP_UID) or wrappers ($BIN)"
fi

adb exec-out screencap -p > "$LOGS/screen.png" 2>/dev/null || true
adb logcat -d > "$LOGS/logcat.txt" 2>&1 || true
grep -E "FATAL EXCEPTION|AndroidRuntime: (FATAL|Process: dev\.parakeet)" "$LOGS/logcat.txt" | head -20 && fail "crash in logcat" || pass "no FATAL EXCEPTION in logcat"
cat "$LOGS/summary.txt"
exit $FAILED
