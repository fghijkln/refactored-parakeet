#!/usr/bin/env python3
"""Parakeet release-APK checks (CI).

  parakeet_apk_check.py <apk> <zh|en> --arb-dir <dir with the ORIGINAL app_zh.arb/app_en.arb>
                        [--aapt2 PATH] [--version 0.2.0]

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


def where(s):
    """APK entries that carry [s] (UTF-8 or UTF-16LE)."""
    return [n for n, b in ENTRIES.items() if present(b, s)]


def flag(check, strings, limit=8):
    """Print each flagged string with the APK entries it is in; keep all for --report."""
    found = {f: where(f) for f in strings}
    REPORT[check] = found
    by_entry = {}
    for f, ns in found.items():
        for n in ns:
            by_entry.setdefault(n, []).append(f)
    for n, fs in sorted(by_entry.items(), key=lambda x: -len(x[1])):
        print("      %4d in %s, e.g. %s" % (len(fs), n, fs[:limit]))


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


def present(hay, s):
    return any(e in hay for e in encodings(s))


def load_arb(d, lang):
    with open(os.path.join(d, "app_%s.arb" % lang), encoding="utf-8") as f:
        return {k: v for k, v in json.load(f).items() if not k.startswith("@")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("apk")
    ap.add_argument("lang", choices=("zh", "en"))
    ap.add_argument("--arb-dir", required=True)
    ap.add_argument("--aapt2", default=os.environ.get("AAPT2", "aapt2"))
    ap.add_argument("--version", default="0.2.0")
    ap.add_argument("--report", help="write every flagged string with its APK entries to this JSON file")
    a = ap.parse_args()
    other = "en" if a.lang == "zh" else "zh"
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
        if hits:
            bad("upstream hosts present: %s" % hits)
            flag("hosts", hits)
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
        if leaked:
            bad("%d removed-feature strings present, e.g. %s" % (len(leaked), leaked[:8]))
            flag("removed", leaked)
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
        if leaked:
            bad("%d/%d %s-only UI strings present, e.g. %s" % (len(leaked), len(foreign_frags), other, leaked[:8]))
            flag("foreign", leaked)
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
