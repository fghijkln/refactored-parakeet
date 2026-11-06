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
3. Bundled assets (scrub_assets): the guide skill keeps only the build language's
   pages and manifest entries (README keeps that language's section); markdown
   blocks that describe removed features are dropped; the plugin kit's message
   table gives the other language's keys the build language's text; upstream hosts
   (go.dshtui.com, dshtui.com) become parakeet.invalid (schema $id included, so
   the kit schemas stay self-consistent); the pet pack's `source` link is removed.
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


# Phrases naming removed features in guide markdown, besides the removed ARB strings.
REMOVED_MD = {
    "zh": ["用 DeepSeek 账号登录", "DeepSeek 账号", "检查更新", "更新窗口", "有新版本", "跳过这个版本", "立即更新",
           "使用统计", "论坛", "交流群", "社区", "App 会发送哪些数据", "App 发送的数据"],
    "en": ["Sign in with DeepSeek", "DeepSeek account", "Check for updates", "checking for updates",
           "Check automatically", "update window", "Update available", "Skip this version", "Update now",
           "usage stats", "forum", "Community", "What the app sends", "what the app sends"],
}
# Kept features worded together with a removed one: reworded before blocks are dropped.
REWORD_MD = [
    ("DeepSeek 账号与 API Key", "DeepSeek API Key"), ("DeepSeek 账号或 API Key", "DeepSeek API Key"),
    ("用账号登录或填写 API Key", "填写 API Key"),
    ("DeepSeek account and API key", "DeepSeek API key"), ("a DeepSeek account or API key", "a DeepSeek API key"),
    ("DeepSeek account or API key", "DeepSeek API key"), ("where you sign in or enter an API key", "where you enter an API key"),
]
HOSTS = re.compile(r"https?://(?:go\.)?dshtui\.com|(?:go\.)?dshtui\.com")
CJK = re.compile(r"[\u4e00-\u9fff]")
PH = re.compile(r"\{[^{}]*\}")


def removed_terms():
    """Literal pieces of the removed-feature ARB strings (both languages), as the APK check sees them."""
    arbs = {}
    for lang in ("zh", "en"):
        with open(os.path.join(ROOT, "app/lib/l10n/app_%s.arb" % lang), encoding="utf-8") as f:
            arbs[lang] = {k: v for k, v in json.load(f).items() if not k.startswith("@") and isinstance(v, str)}
    def frags(v):
        return [p.strip() for p in PH.split(v) if p.strip() and "{" not in p and "}" not in p]
    kept = "\n".join(f for a in arbs.values() for k, v in a.items() if not BLANK.match(k) for f in frags(v))
    out = set()
    for lang, a in arbs.items():
        for k, v in a.items():
            if BLANK.match(k):
                for f in frags(v):
                    good = len(CJK.findall(f)) >= 4 if lang == "zh" else (len(f) >= 14 and f.isascii() and " " in f)
                    if good and f not in kept:
                        out.add(f)
    return out


def md_blocks(text):
    """Split markdown into blocks: headings, fenced code, list items (with continuation), paragraphs."""
    blocks, cur, fence = [], [], False
    for line in text.split("\n"):
        if fence:
            cur.append(line)
            if line.lstrip().startswith("```"):
                blocks.append(cur); cur = []; fence = False
            continue
        if line.lstrip().startswith("```"):
            if cur: blocks.append(cur)
            cur = [line]; fence = True
            continue
        starts = (not line.strip() or line.startswith("#") or re.match(r"^(\s*)([-*+]|\d+\.)\s", line)
                  or line.startswith(">") or line.startswith("|"))
        if starts and cur and not (line.startswith("|") and cur[-1].startswith("|")):
            blocks.append(cur); cur = []
        cur.append(line)
    if cur: blocks.append(cur)
    return blocks


def scrub_markdown(text, terms):
    for old, new in REWORD_MD:
        text = text.replace(old, new)
    def hit(s):
        return any(t in s for t in terms)
    out, drop_level, dropped = [], None, 0
    blocks = md_blocks(text)
    for i, b in enumerate(blocks):
        if not b:
            continue
        head = b[0]
        m = re.match(r"^(#+)\s", head)
        if drop_level is not None:
            if m and len(m.group(1)) <= drop_level:
                drop_level = None
            else:
                dropped += 1
                continue
        if m:
            if hit(head):
                drop_level = len(m.group(1)); dropped += 1
                continue
            out.append(b); continue
        joined = "\n".join(b)
        if not hit(joined):
            out.append(b); continue
        # An index line "- [Page](x.md)：a、b、c": drop only the segments naming removed features.
        lm = re.match(r"^(\s*- \[[^\]]+\]\([^)]+\)\s*[:：]\s*)(.*)$", head)
        if len(b) == 1 and lm and not hit(lm.group(1)):
            sep = "、" if "、" in lm.group(2) else ", "
            segs = [x for x in lm.group(2).split(sep) if not hit(x)]
            out.append([lm.group(1) + sep.join(segs)]); dropped += 1
            continue
        # A nested list item takes its deeper children with it.
        dropped += 1
        ind = len(head) - len(head.lstrip())
        if re.match(r"^\s*([-*+]|\d+\.)\s", head):
            j = i + 1
            while j < len(blocks) and blocks[j][0].strip() and (len(blocks[j][0]) - len(blocks[j][0].lstrip())) > ind:
                blocks[j][:] = []; j += 1
    lines = []
    for b in out:
        lines.extend(b)
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text, dropped


# The subscription sign-in bridge (app/assets/engine/auth/bridge.mjs) words its states in
# Chinese only; the en tree gets these.
BRIDGE_EN = {
    "正在准备登录…": "Getting sign-in ready…",
    "在浏览器里完成登录": "Finish signing in in your browser",
    "在打开的网页里输入下面的代码": "Enter the code below on the page that opened",
    "在浏览器里登录后，把地址栏里的完整网址复制下来，粘贴到这里": "After signing in in your browser, copy the full address from the address bar and paste it here",
    "正在完成登录…": "Completing sign-in…",
    "登录已取消": "Sign-in cancelled",
    "登录超时了，再试一次": "Sign-in timed out. Try again",
    "授权被拒绝了，再试一次": "Authorization was denied. Try again",
    "网络连不上，检查网络后再试": "Can't reach the network. Check your connection and try again",
    "粘贴的内容不对，再试一次": "That isn't the right text. Try again",
    "引擎暂时不能登录，重启引擎后再试": "The engine can't sign in right now. Restart the engine and try again",
    "上一次登录还没结束，稍后再试": "The last sign-in hasn't finished yet. Try again shortly",
    "授权没有完成，再试一次": "Authorization didn't finish. Try again",
    "这次登录已失效，请重新开始": "This sign-in has expired. Start again",
    "退出登录没有完成，再试一次": "Signing out didn't finish. Try again",
    "现在不需要粘贴内容": "Nothing needs to be pasted now",
    "先粘贴授权信息": "Paste the authorization first",
    "不支持这个登录方式": "This sign-in method isn't supported",
    "Product copy shown by the app (Chinese, short).": "Product copy shown by the app (short).",
}


def scrub_code_assets(assets):
    """JS/CSS the app ships into the WebView and the engine (assets/web, assets/engine)."""
    cjk_comment = re.compile(r"(?m)^[ \t]*//[^\n]*[\u4e00-\u9fff][^\n]*\n")
    cjk_block = re.compile(r"/\*[\s\S]*?\*/")
    for sub in ("web", "engine"):
        for d, _, fs in os.walk(os.path.join(assets, sub)):
            for name in fs:
                if not name.endswith((".js", ".mjs", ".css")):
                    continue
                p = os.path.join(d, name)
                text = open(p, encoding="utf-8").read()
                new = text.replace("DeepSeek account platform", "DeepSeek platform")
                if LANG == "en":
                    for zh, en in BRIDGE_EN.items():
                        new = new.replace("'%s'" % zh, "'%s'" % en.replace("'", "\\'")).replace(zh, en)
                    # The DSH Web page of an en tree is English only (its runtime carries en.json alone):
                    # matchers for its Chinese labels go.
                    new = new.replace('button[aria-label^="查看 "], ', "").replace("'查看 ' + l, ", "")
                    new = re.sub(r"'[^'\n]*[\u4e00-\u9fff][^'\n]*',\s*", "", new)
                    new = cjk_comment.sub("", new)
                    new = cjk_block.sub(lambda m: "" if CJK.search(m.group(0)) else m.group(0), new)
                if new != text:
                    open(p, "w", encoding="utf-8").write(new)
                    print("code asset scrubbed: %s" % os.path.relpath(p, ROOT))


def scrub_assets():
    assets = os.path.join(ROOT, "app/assets")
    other = "en" if LANG == "zh" else "zh"
    terms = set(removed_terms())
    for lang in ("zh", "en"):
        terms.update(REMOVED_MD[lang])
    terms = sorted(terms, key=len, reverse=True)
    # Guide skill: one language.
    guide = os.path.join(assets, "skills/dsh-go-guide")
    if os.path.isdir(guide):
        mpath = os.path.join(guide, "manifest.json")
        with open(mpath, encoding="utf-8") as f:
            manifest = json.load(f)
        files = manifest["files"]
        for asset in list(files):
            if asset.startswith(other + "-"):
                del files[asset]
                p = os.path.join(guide, asset)
                if os.path.exists(p):
                    os.remove(p)
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
            f.write("\n")
        readme = os.path.join(guide, "README.md")
        if os.path.isfile(readme):
            text = open(readme, encoding="utf-8").read()
            mine_h, other_h = ("## 中文", "## English") if LANG == "zh" else ("## English", "## 中文")
            parts = re.split(r"(?m)^(?=## )", text)
            text = "".join(p for p in parts if not p.startswith(other_h))
            open(readme, "w", encoding="utf-8").write(text)
        total = 0
        for name in sorted(os.listdir(guide)):
            if name.endswith(".md") and name != "SKILL.md":
                p = os.path.join(guide, name)
                text, n = scrub_markdown(open(p, encoding="utf-8").read(), terms)
                open(p, "w", encoding="utf-8").write(text)
                total += n
        print("guide skill: %s pages only, %d removed-feature blocks dropped" % (LANG, total))
    # Plugin kit messages: the other language's entries are copies of this one's.
    msgs = os.path.join(assets, "skills/dsh-go-plugin/kit-lib-messages.json")
    if os.path.isfile(msgs):
        with open(msgs, encoding="utf-8") as f:
            data = json.load(f)
        if LANG in data and other in data:
            data[other] = dict(data[LANG])
            with open(msgs, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
                f.write("\n")
            print("plugin kit messages: %s entries now carry the %s text" % (other, LANG))
    scrub_code_assets(assets)
    # The community page is removed: its bundled feed keeps the shape and nothing else.
    feed = os.path.join(assets, "community/community.json")
    if os.path.isfile(feed):
        with open(feed, encoding="utf-8") as f:
            data = json.load(f)
        empty = {k: ([] if isinstance(v, list) else v) for k, v in data.items() if k in ("schema", "revision", "updatedAt") or isinstance(v, list)}
        with open(feed, "w", encoding="utf-8") as f:
            json.dump(empty, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print("community feed emptied (removed feature)")
    # Upstream hosts -> parakeet.invalid; pet pack source links removed.
    for d, _, fs in os.walk(assets):
        for name in fs:
            p = os.path.join(d, name)
            if name == "pack.json":
                with open(p, encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict) and "source" in data:
                    del data["source"]
                    with open(p, "w", encoding="utf-8") as f:
                        json.dump(data, f, ensure_ascii=False, indent=2)
                        f.write("\n")
                    print("removed source from %s" % os.path.relpath(p, ROOT))
            if name.endswith((".json", ".md", ".mjs", ".js", ".yml", ".yaml", ".txt", ".html", ".css")):
                text = open(p, encoding="utf-8").read()
                new = HOSTS.sub(lambda m: ("https://" if m.group(0).startswith("http") else "") + "parakeet.invalid", text)
                if new != text:
                    open(p, "w", encoding="utf-8").write(new)
                    print("upstream host -> parakeet.invalid in %s" % os.path.relpath(p, ROOT))


if __name__ == "__main__":
    ROOT, LANG = sys.argv[1], sys.argv[2]
    assert LANG in ("zh", "en")
    scrub_assets()  # before blank_arb: reads the unblanked ARB files
    blank_arb(os.path.join(ROOT, "app/lib/l10n/app_%s.arb" % LANG))
    merge_android(os.path.join(ROOT, "app/android/app/src/main/res"))
