#!/usr/bin/env python3
"""Parakeet release-APK checks (CI).

  parakeet_apk_check.py <apk> <zh|en> --arb-dir <dir with the ORIGINAL app_zh.arb/app_en.arb>
                        [--aapt2 PATH] [--version 0.2.2]

1. aapt2 badging: package dev.parakeet.dshgo, versionName, not debuggable, and
   only the build language among the packaged locales.
2. No upstream service hosts (dshtui.com, ghfast.top) in the app code
   (libapp.so, classes*.dex, resources.arsc, Flutter assets).
3. Strings of removed features (feedback, DeepSeek account sign-in, usage
   statistics, update checks, forum/community, star prompt; the keys
   tooling/parakeet_locale.py blanks) are not in the app code.
4. Locale purity: no UI string that exists only in the other language.
   Positive controls: strings of the build language ARE found, so a scan that
   cannot see the snapshot's strings fails instead of passing vacuously.
5. DSH runtime archive: only the build language's DSH locale files
   (+ en.json, DSH's anchor, in the zh build).
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PKG = "dev.parakeet.dshgo"
FORBIDDEN_HOSTS = ["dshtui.com", "ghfast.top"]
PLACEHOLDER = re.compile(r"\{[^{}]*\}")
CJK = re.compile(r"[\u4e00-\u9fff]")

failed = False
ENTRIES = {}   # APK entry name -> bytes (the scanned haystack, per entry)
REPORT = {}    # check -> {string: [entries]}  (written with --report)


# Narrow, documented exceptions: (build language, check, APK entry regex, exact strings or None
# for any, reason). A flagged string is excused only when EVERY entry it is in matches;
# excused strings are still printed (ALLOW lines), never silently dropped.
SKILLS = "assets/flutter_assets/assets/skills/"
ALLOW = [
    ("en", "foreign", re.compile(re.escape(SKILLS) + r"(dsh-go-(ui|plugin|support)/[^/]+|dsh-go-guide/SKILL\.md)$"), None,
     "agent-facing skill bundles (instructions and validator scripts) that upstream dsh-Go writes in Chinese only; "
     "the app installs them into the engine for the agent, which answers in the user's language; never shown as "
     "app UI. The user-facing guide pages are single-language (tooling/parakeet_locale.py scrub_assets)."),
    ("zh", "removed", re.compile(r"^assets/flutter_assets/assets/engine/auth/bridge\.mjs$"), {"正在准备登录", "正在完成登录"},
     "progress copy of the subscription (ChatGPT / Claude) sign-in bridge, a kept feature; the same words as the "
     "removed DeepSeek account sign-in's ARB strings."),
    ("zh", "foreign", re.compile(r"^lib/[^/]+/libapp\.so$"), {"Compaction cancelled", "Plan mode entry cancelled"},
     "DSH engine's own English command output, the keys of the table that translates it "
     "(app/lib/ui/chat/widgets/command_result_text.dart)."),
    ("zh", "foreign", re.compile(r"^lib/[^/]+/libapp\.so$"), {"Host is offline", "sign-in expired"},
     "DSH Remote protocol failure text (packages/dsh_remote); the app shows these failures by code through ARB "
     "strings (app/lib/remote/relay/dsh_remote_backend.dart)."),
    ("zh", "foreign", re.compile(r"^lib/[^/]+/libapp\.so$"), {"Unterminated string", "exceeds the limit of", "Invalid format"},
     "Dart SDK / package messages, not app text: dart:convert's JSON parser ('Unterminated string'), integer "
     "parsing ('Positive/Negative input exceeds the limit of integer'), a crypto package ('Invalid format')."),
    ("zh", "foreign", re.compile(r"^classes\d*\.dex$"), {"Failed to start", "Invalid format"},
     "AndroidX / library messages, not app text ('Failed to start capture request', 'Invalid format for r "
     "portion of Poly1305 key', ExifInterface)."),
    ("zh", "foreign", re.compile(r"^classes\d*\.dex$"), {"Developer options"},
     "a system Settings page title that phone control matches to protect it (phone/a11y/ProtectedPages.kt); "
     "never shown."),
    ("zh", "foreign", re.compile(r"^classes\d*\.dex$"), {"Permission denied"},
     "kernel error text the crash classifier matches in engine logs (runtime/CrashClassifier.kt); never shown."),
    # en build: Chinese that is not app UI. Every string is listed; anything new still fails.
    ("en", "foreign", re.compile(r"^classes\d*\.dex$"), {
        "不打扰模式", "不支持的", "全局补丁", "切回原生界面", "原生界面", "可视化回复", "启动后很快崩溃", "启动失败",
        "存储空间不足", "安全模式", "安装日志", "密码和验证码", "尚未就绪", "工作目录", "应用名单", "引擎日志", "引擎状态",
        "当前屏幕", "恢复正常模式", "或更高版本", "手机存储", "手机操控", "搜索对话", "无法读取", "无障碍服务", "暂不可用",
        "正常启动", "没有找到", "没有权限", "没有记录到失败时的输出", "直接启动", "省电策略", "稍后再试", "系统权限",
        "系统设置", "网页版设置", "被系统结束", "访问手机文件", "运行中崩溃", "运行环境", "还没有记录", "进入安全模式",
        "连接方式", "连续两次启动失败", "重启引擎", "重新打开", "需要联网", "默认工作目录"},
     "agent-facing text of the native layer, which upstream dsh-Go writes in Chinese only: the phone-control tool "
     "catalog and tool results (phone/*), the AGENTS.md section and safe-mode report the app writes for the agent "
     "(runtime/GuestSetup.kt, runtime/SafeMode.kt), and the /root/手机存储 workspace path; user-facing native text "
     "comes from res/values (AppStrings)."),
    ("en", "foreign", re.compile(r"^classes\d*\.dex$"), {"开发者选项", "退出登录"},
     "on-screen words of other apps and system Settings that phone control matches to protect pages and gate "
     "sensitive taps (phone/a11y/ProtectedPages.kt, phone/SensitiveWords.kt); the phone's own UI language is not the "
     "app's, so both languages stay; never shown."),
    ("en", "foreign", re.compile(r"^lib/[^/]+/libapp\.so$"), {
        "可视化回复", "完成后收起过程", "失败前后的日志", "引擎日志", "手机存储", "对话字号", "安全模式", "本机引擎", "手机操控"},
     "labels of the diagnostics snapshot the app writes for the agent (app/lib/diagnostics/diagnostics_markdown.dart; "
     "read by the dsh-go-support skill)."),
    ("en", "foreign", re.compile(r"^lib/[^/]+/libapp\.so$"), {"存储空间不足", "存储空间不足：需要约", "MB，当前可用"},
     "a pattern that matches the native layer's agent-facing storage message (app/lib/ui/engine/engine_status.dart)."),
    ("en", "foreign", re.compile(r"^lib/[^/]+/libapp\.so$"), {"生成图像", "生成视频"},
     "the media-generation request header the app writes into a message and parses back "
     "(app/lib/ui/chat/media/generate_header.dart, docs/design/media-generation.md)."),
    ("en", "foreign", re.compile(r"^lib/[^/]+/libapp\.so$"), {"语音输入"},
     "names DSH Web and plugins show, matched to find their entries (app/lib/ui/features/feature_catalog.dart "
     "DshWebTarget); never shown."),
    ("en", "foreign", re.compile(r"^lib/[^/]+/libapp\.so$"), {"提交插件"},
     "anchor of the upstream plugin market URL (app/lib/ui/plugins/market_tab.dart marketSubmitUrl)."),
]
LANG = None


def allowed(check, string, entries):
    """The reason(s) that excuse [string] in every one of its [entries], or None."""
    reasons = []
    for n in entries:
        r = next((reason for lang, chk, rx, strings, reason in ALLOW
                  if lang == LANG and chk == check and rx.search(n) and (strings is None or string in strings)), None)
        if r is None:
            return None
        if r not in reasons:
            reasons.append(r)
    return " + ".join(reasons) if reasons else None


def where(s):
    """APK entries that carry [s] (UTF-8 or UTF-16LE)."""
    return [n for n, b in ENTRIES.items() if present(b, s)]


def flag(check, strings, limit=8):
    """Print each flagged string with the APK entries it is in; keep all for --report.
    Returns the strings that are not excused by ALLOW."""
    found = {f: where(f) for f in strings}
    REPORT[check] = found
    left, excused = [], {}
    for f, ns in found.items():
        r = allowed(check, f, ns)
        if r:
            excused.setdefault(r, []).append(f)
        else:
            left.append(f)
    by_entry = {}
    for f in left:
        for n in found[f]:
            by_entry.setdefault(n, []).append(f)
    for n, fs in sorted(by_entry.items(), key=lambda x: -len(x[1])):
        print("      %4d in %s, e.g. %s" % (len(fs), n, fs[:limit]))
    for r, fs in excused.items():
        print("  ALLOW %d %s strings (%s), e.g. %s" % (len(fs), check, r[:90] + "…", fs[:4]))
    return left


def ok(msg):
    print("  PASS " + msg)


def bad(msg):
    global failed
    failed = True
    print("  FAIL " + msg)


def blank_regex():
    from parakeet_locale import BLANK
    return BLANK


def fragments(value):
    """Literal pieces of an ARB message (ICU placeholders/plural/select bodies removed)."""
    if not isinstance(value, str):
        return []
    out = []
    for part in PLACEHOLDER.split(value):
        part = part.strip()
        if "{" in part or "}" in part:
            continue
        out.append(part)
    return out


def good_fragment(f, lang):
    if lang == "zh":
        return len(CJK.findall(f)) >= 4
    return len(f) >= 14 and f.isascii() and " " in f


def encodings(s):
    yield s.encode("utf-8")
    try:
        yield s.encode("utf-16-le")
    except UnicodeEncodeError:
        pass


WORDCH = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")


def _standing(hay, needle, step, lead):
    """Some occurrence of [needle] has no letter/digit right before (when [lead]) or after it
    ([step] = 1 for UTF-8, 2 for UTF-16LE, whose high byte must be 0)."""
    i = hay.find(needle)
    while i >= 0:
        j = i + len(needle)
        after = j + step <= len(hay) and hay[j] in WORDCH and (step == 1 or hay[j + 1] == 0)
        before = lead and i - step >= 0 and hay[i - step] in WORDCH and (step == 1 or hay[i - 1] == 0)
        if not after and not before:
            return True
        i = hay.find(needle, i + 1)
    return False


def present(hay, s):
    """[s] is in [hay] (UTF-8 or UTF-16LE). An ASCII string must stand as words of its
    own: "Connection time" is not found inside "Connection timed out"."""
    if not s.isascii():
        return any(e in hay for e in encodings(s))
    lead = s[:1].isalnum()
    return _standing(hay, s.encode("ascii"), 1, lead) or _standing(hay, s.encode("utf-16-le"), 2, lead)


def load_arb(d, lang):
    with open(os.path.join(d, "app_%s.arb" % lang), encoding="utf-8") as f:
        return {k: v for k, v in json.load(f).items() if not k.startswith("@")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("apk")
    ap.add_argument("lang", choices=("zh", "en"))
    ap.add_argument("--arb-dir", required=True)
    ap.add_argument("--aapt2", default=os.environ.get("AAPT2", "aapt2"))
    ap.add_argument("--version", default="0.2.2")
    ap.add_argument("--report", help="write every flagged string with its APK entries to this JSON file")
    a = ap.parse_args()
    other = "en" if a.lang == "zh" else "zh"
    global LANG
    LANG = a.lang
    print("== %s (%s)" % (os.path.basename(a.apk), a.lang))

    # 1. badging
    badging = subprocess.run([a.aapt2, "dump", "badging", a.apk], capture_output=True, text=True, check=True).stdout
    pkg = re.search(r"^package: name='([^']+)'.*versionName='([^']*)'", badging, re.M)
    if pkg and pkg.group(1) == PKG and pkg.group(2) == a.version:
        ok("package %s versionName %s" % pkg.groups())
    else:
        bad("package/version line: %s" % (pkg.group(0) if pkg else "missing"))
    if "application-debuggable" in badging:
        bad("APK is debuggable")
    else:
        ok("not debuggable")
    loc = re.search(r"^locales:(.*)$", badging, re.M)
    locales = re.findall(r"'([^']*)'", loc.group(1)) if loc else []
    foreign = [l for l in locales if l != "--_--" and l.split("-")[0].split("_")[0] != a.lang]
    if foreign:
        bad("foreign Android resource locales: %s" % foreign)
    else:
        ok("Android resource locales: %s" % locales)

    # haystack: app code and resources (not the DSH runtime archive)
    hay = bytearray()
    runtime_archives = []
    with zipfile.ZipFile(a.apk) as z:
        for n in z.namelist():
            if (n.endswith("libapp.so") or re.match(r"classes\d*\.dex$", n) or n == "resources.arsc"
                    or (n.startswith("assets/flutter_assets/") and not n.endswith((".png", ".ttf", ".otf", ".webp", ".jpg")))):
                ENTRIES[n] = z.read(n)
                hay += ENTRIES[n]
            if re.match(r"assets/runtime/rootfs-[^/]+\.tar\.(xz|gz)$", n):
                runtime_archives.append(n)
        hay = bytes(hay)
        print("  scanned %.1f MB of app code/resources" % (len(hay) / 1e6))

        # 2. hosts
        hits = [h for h in FORBIDDEN_HOSTS if present(hay, h)]
        hits = flag("hosts", hits) if hits else hits
        if hits:
            bad("upstream hosts present: %s" % hits)
        else:
            ok("no upstream hosts (%s)" % ", ".join(FORBIDDEN_HOSTS))

        mine, theirs = load_arb(a.arb_dir, a.lang), load_arb(a.arb_dir, other)
        blank = blank_regex()
        kept_all = set()
        for arb in (mine, theirs):
            for k, v in arb.items():
                if not blank.match(k):
                    kept_all.update(fragments(v))
        kept_text = "\n".join(kept_all)

        # 3. removed-feature strings (both languages' versions)
        removed = set()
        for lang, arb in ((a.lang, mine), (other, theirs)):
            for k, v in arb.items():
                if blank.match(k):
                    removed.update(f for f in fragments(v) if good_fragment(f, lang) and f not in kept_text)
        leaked = sorted(f for f in removed if present(hay, f))
        leaked = flag("removed", leaked) if leaked else leaked
        if leaked:
            bad("%d removed-feature strings present, e.g. %s" % (len(leaked), leaked[:8]))
        else:
            ok("none of %d removed-feature strings present" % len(removed))

        # 4. locale purity + positive control
        mine_text = "\n".join(f for k, v in mine.items() for f in fragments(v))
        own = sorted({f for k, v in mine.items() if not blank.match(k) for f in fragments(v) if good_fragment(f, a.lang)})
        found = sum(1 for f in own if present(hay, f))
        ratio = found / max(1, len(own))
        if ratio >= 0.5:
            ok("positive control: %d/%d %s UI strings found in the app code" % (found, len(own), a.lang))
        else:
            bad("positive control: only %d/%d %s UI strings found; the scan cannot see the strings" % (found, len(own), a.lang))
        foreign_frags = sorted({f for k, v in theirs.items() for f in fragments(v)
                                if good_fragment(f, other) and f not in mine_text})
        leaked = [f for f in foreign_frags if present(hay, f)]
        leaked = flag("foreign", leaked) if leaked else leaked
        if leaked:
            bad("%d/%d %s-only UI strings present, e.g. %s" % (len(leaked), len(foreign_frags), other, leaked[:8]))
        else:
            ok("none of %d %s-only UI strings present" % (len(foreign_frags), other))

        # 5. DSH runtime locale files
        if not runtime_archives:
            bad("no runtime archive in assets/runtime")
        for n in runtime_archives:
            data = z.read(n)
            mode = "r:xz" if n.endswith(".xz") else "r:gz"
            with tarfile.open(fileobj=io.BytesIO(data), mode=mode) as t:
                names = [m.name for m in t.getmembers()]
            loc_files = [x for x in names if re.search(r"/locale/[^/]+\.json$", x)]
            langs = sorted({os.path.basename(x)[:-5] for x in loc_files})
            allowed = {"en"} | ({"zh", "zh-CN", "zh-cn", "zh_CN", "zh-Hans"} if a.lang == "zh" else set())
            extra = [l for l in langs if l not in allowed]
            if extra:
                bad("%s: DSH locale files of other languages: %s" % (n, extra))
            else:
                ok("%s: DSH locale files %s (%d files)" % (n, langs, len(loc_files)))
            if a.lang == "zh" and not any(l.startswith("zh") for l in langs):
                bad("%s: zh build has no zh DSH locale file" % n)

    if a.report:
        with open(a.report, "w", encoding="utf-8") as f:
            json.dump(REPORT, f, ensure_ascii=False, indent=1)
    print("RESULT %s %s" % (os.path.basename(a.apk), "FAIL" if failed else "PASS"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
