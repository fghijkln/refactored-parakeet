#!/usr/bin/env python3
"""Parakeet single-language tree preparation (called by tooling/parakeet-locale.sh).

  parakeet_locale.py <repo-root> <zh|en>

1. app/lib/l10n/app_<lang>.arb: values of removed features are blanked so their
   text is not in the APK even where Dart's tree shaker keeps a getter. For en the
   template's @metadata (placeholders) is copied in, since app_en.arb becomes the
   template of the en-only tree.
2. Android res: for zh, every values-zh/*.xml entry replaces the same-named entry in
   values/*.xml and values-zh is dropped; for en, values-zh is dropped. The APK
   carries one language (localeFilters in build.gradle.kts as well).
"""
import json
import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET

ET.register_namespace("tools", "http://schemas.android.com/tools")
ET.register_namespace("android", "http://schemas.android.com/apk/res/android")
ET.register_namespace("xliff", "urn:oasis:names:tc:xliff:document:1.2")


# Keys of features Parakeet removed (DeepSeek account sign-in, feedback, anonymous
# usage statistics, forum / community / QQ group, app update checks, star prompt).
BLANK = re.compile(r"^(?:"
                   r"usage(?:Stats|Notice|Upgrade)\w*|update\w*|star\w*|forum\w*|remoteForum\w*|stateForum\w*"
                   r"|botsForum|catalogForum\w*|catalogCommunity\w*|community\w*|hubSettingsCommunity"
                   r"|searchKw(?:Community|UsageStats|Update|Star)|chatCommandFeedback\w*|stateFeedback\w*"
                   r"|stateCommandFeedback\w*|engineAccount(?!Title\b)\w*|hubSettingsAccount\w*|hubSettingsSignInAccount"
                   r"|hubSettingsSigningIn|shellConnectDeepSeek\w*|shellSignInDeepSeek|shellAccountSignIn\w*"
                   r"|stateDeepSeekAccount|hubAboutNewVersion|pluginsNamespaceAccountModel|engineTranslationAccountPaid"
                   r")$")


def blank_arb(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    # The template (app_zh.arb) alone carries the @key metadata (placeholders); the en
    # file becomes the template of an en-only tree, so it takes that metadata along.
    template = os.path.join(os.path.dirname(path), "app_zh.arb")
    if LANG != "zh" and os.path.isfile(template):
        with open(template, encoding="utf-8") as f:
            zh = json.load(f)
        copied = 0
        for key, meta in zh.items():
            if key.startswith("@") and not key.startswith("@@") and key[1:] in data and key not in data:
                data[key] = meta
                copied += 1
        print("copied %d @metadata entries from the zh template" % copied)
    n = 0
    for key in list(data):
        if key.startswith("@") or not isinstance(data[key], str) or not BLANK.match(key):
            continue
        meta = data.get("@" + key) or {}
        names = list((meta.get("placeholders") or {}).keys())
        data[key] = " ".join("{%s}" % p for p in names)
        n += 1
    # The APK is Parakeet: user-visible text names it so (keys and placeholders untouched).
    renamed = 0
    for key in list(data):
        if not key.startswith("@") and isinstance(data[key], str) and "DSH Go" in data[key]:
            data[key] = data[key].replace("DSH Go", "Parakeet")
            renamed += 1
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("blanked %d removed-feature strings, renamed DSH Go in %d in %s" % (n, renamed, os.path.relpath(path, ROOT)))


def merge_android(res):
    zh = os.path.join(res, "values-zh")
    if LANG == "zh" and os.path.isdir(zh):
        for name in sorted(os.listdir(zh)):
            src = os.path.join(zh, name)
            dst = os.path.join(res, "values", name)
            if not os.path.isfile(dst):
                shutil.copyfile(src, dst)
                continue
            base = ET.parse(dst)
            over = ET.parse(src)
            index = {(e.tag, e.get("name")): e for e in base.getroot()}
            for e in over.getroot():
                k = (e.tag, e.get("name"))
                if k in index:
                    parent = base.getroot()
                    i = list(parent).index(index[k])
                    parent.remove(index[k])
                    parent.insert(i, e)
                else:
                    base.getroot().append(e)
            base.write(dst, encoding="utf-8", xml_declaration=True)
            print("merged values-zh/%s into values/" % name)
    values = os.path.join(res, "values")
    for name in sorted(os.listdir(values)):
        path = os.path.join(values, name)
        if name.endswith(".xml"):
            text = open(path, encoding="utf-8").read()
            if "DSH Go" in text:
                open(path, "w", encoding="utf-8").write(text.replace("DSH Go", "Parakeet"))
                print("renamed DSH Go in res/values/%s" % name)
    for name in os.listdir(res):
        if re.match(r"^values(-night)?(-v\d+)?-zh", name) or name.startswith("values-zh"):
            shutil.rmtree(os.path.join(res, name))
            print("dropped res/%s" % name)


if __name__ == "__main__":
    ROOT, LANG = sys.argv[1], sys.argv[2]
    assert LANG in ("zh", "en")
    blank_arb(os.path.join(ROOT, "app/lib/l10n/app_%s.arb" % LANG))
    merge_android(os.path.join(ROOT, "app/android/app/src/main/res"))
