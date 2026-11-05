#!/usr/bin/env python3
"""Repackage Termux's prebuilt (Bionic, android-arm64) Node.js + bash into
Android jniLibs so they can be exec'd from nativeLibraryDir (W^X safe).

What it does
  1. Downloads Termux's apt `Packages` index (aarch64) and resolves the
     requested packages plus their transitive runtime dependencies.
  2. Downloads each .deb, extracts data.tar.* in pure Python (no dpkg/xz needed).
  3. Copies executables as `lib<name>_exec.so` (e.g. libnode_exec.so) and every
     shared library they (transitively) need as `lib<stem>.so`.
  4. Rewrites DT_NEEDED / SONAME with patchelf so every name matches the flat
     `lib*.so` pattern Android's package manager extracts, and sets RUNPATH to
     `$ORIGIN` (the app also sets LD_LIBRARY_PATH=nativeLibraryDir).

Usage: fetch_termux.py <out_jnilibs_dir> [--packages nodejs-lts,bash]
Writes <out>/termux-manifest.json describing what was packaged.
Requires `patchelf` on PATH.
"""
import argparse, io, json, lzma, os, re, shutil, subprocess, sys, tarfile, tempfile, urllib.request

REPO = os.environ.get("TERMUX_REPO", "https://packages-cf.termux.dev/apt/termux-main")
ARCH = os.environ.get("TERMUX_ARCH", "aarch64")
PREFIX = "data/data/com.termux/files/usr"
# Dependencies that carry no runtime ELF we need (config/data-only or Termux tooling).
SKIP_DEPS = {"termux-tools", "ca-certificates", "resolv-conf", "termux-keyring",
             "termux-am", "termux-exec", "dash", "coreutils", "procps", "grep",
             "sed", "findutils", "less", "debianutils", "dialog", "util-linux"}
# Libraries provided by Android itself.
SYSTEM_LIBS = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so",
               "libz.so.1-system-do-not-use", "libEGL.so", "libGLESv2.so"}
EXECUTABLES = {"nodejs-lts": ["bin/node"], "nodejs": ["bin/node"], "bash": ["bin/bash"]}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "parakeet-build"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            print(f"retry {url}: {e}", file=sys.stderr)


def parse_index(text):
    pk = {}
    for block in text.split("\n\n"):
        d = {}
        for line in block.split("\n"):
            if ":" in line and not line.startswith(" "):
                k, v = line.split(":", 1)
                d[k] = v.strip()
        if "Package" in d:
            pk[d["Package"]] = d
    return pk


def deps_of(d):
    out = []
    for part in (d.get("Depends") or "").split(","):
        part = part.strip()
        if not part:
            continue
        name = re.split(r"[\s(|]", part)[0]
        out.append(name)
    return out


def resolve(index, roots):
    seen, order = set(), []
    stack = list(roots)
    while stack:
        n = stack.pop()
        if n in seen or n in SKIP_DEPS:
            continue
        if n not in index:
            print(f"warning: {n} not in index, skipping", file=sys.stderr)
            continue
        seen.add(n)
        order.append(n)
        stack.extend(deps_of(index[n]))
    return order


def ar_members(data):
    assert data[:8] == b"!<arch>\n", "not an ar archive"
    off = 8
    while off < len(data):
        hdr = data[off:off + 60]
        name = hdr[:16].decode().strip().rstrip("/")
        size = int(hdr[48:58].decode().strip())
        body = data[off + 60: off + 60 + size]
        yield name, body
        off += 60 + size + (size & 1)


def extract_deb(data, dest):
    for name, body in ar_members(data):
        if name.startswith("data.tar"):
            if name.endswith(".xz"):
                body = lzma.decompress(body)
            elif name.endswith(".zst"):
                body = subprocess.run(["zstd", "-dc"], input=body, stdout=subprocess.PIPE, check=True).stdout
            elif name.endswith(".gz"):
                import gzip
                body = gzip.decompress(body)
            with tarfile.open(fileobj=io.BytesIO(body)) as tf:
                tf.extractall(dest, filter="tar") if sys.version_info >= (3, 12) else tf.extractall(dest)
            return
    raise RuntimeError("no data.tar in deb")


def patchelf(*args):
    return subprocess.run(["patchelf", *args], check=True, stdout=subprocess.PIPE, text=True).stdout


def needed(path):
    return [x for x in patchelf("--print-needed", path).split() if x]


def flat_name(soname):
    """libicuuc.so.78 -> libicuuc.so ; libc++_shared.so -> libc++_shared.so"""
    m = re.match(r"^(lib.+?\.so)(\.[0-9.]+)?$", soname)
    if not m:
        raise ValueError(f"unexpected soname {soname}")
    # Suffix every library so none collides with Android's own (libz.so,
    # libcrypto.so and libssl.so exist in /system/lib64 as different builds).
    return m.group(1)[:-3].replace("+", "x") + "_tx.so"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--packages", default="nodejs-lts,bash")
    ap.add_argument("--manifest", default=None)
    a = ap.parse_args()
    roots = [p for p in a.packages.split(",") if p]
    index = parse_index(fetch(f"{REPO}/dists/stable/main/binary-{ARCH}/Packages").decode())
    pkgs = resolve(index, roots)
    print("packages:", pkgs)
    work = tempfile.mkdtemp(prefix="termux-")
    for p in pkgs:
        url = f"{REPO}/{index[p]['Filename']}"
        print("fetch", url)
        extract_deb(fetch(url), work)
    usr = os.path.join(work, PREFIX)
    libdir = os.path.join(usr, "lib")
    # Map every real shared object in lib/ by its file name (symlinks resolved).
    available = {}
    for fn in os.listdir(libdir):
        full = os.path.join(libdir, fn)
        if ".so" in fn and os.path.isfile(full):
            available[fn] = os.path.realpath(full)
    os.makedirs(a.out, exist_ok=True)
    manifest = {"packages": {p: index[p]["Version"] for p in pkgs}, "executables": {}, "libs": []}
    queue, done = [], set()

    def stage(src, dst_name):
        dst = os.path.join(a.out, dst_name)
        shutil.copyfile(src, dst)
        os.chmod(dst, 0o755)
        for n in needed(dst):
            if n in SYSTEM_LIBS:
                continue
            flat = flat_name(n)
            patchelf("--replace-needed", n, flat, dst)
            if n not in done:
                done.add(n)
                queue.append(n)
        patchelf("--set-rpath", "$ORIGIN", dst)
        return dst

    for p in roots:
        for rel in EXECUTABLES.get(p, []):
            src = os.path.realpath(os.path.join(usr, rel))
            base = os.path.basename(rel)
            name = f"lib{base}_exec.so"
            stage(src, name)
            manifest["executables"][base] = name
    while queue:
        n = queue.pop()
        if n not in available:
            raise SystemExit(f"missing dependency {n} (not in packaged debs)")
        flat = flat_name(n)
        dst = stage(available[n], flat)
        patchelf("--set-soname", flat, dst)
        manifest["libs"].append(flat)
    manifest["libs"].sort()
    with open(a.manifest or os.path.join(os.path.dirname(os.path.abspath(a.out)), "termux-manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    # Keep Termux's license texts alongside the build output.
    lic = os.path.join(usr, "share", "doc")
    licdst = os.path.join(os.path.dirname(os.path.abspath(a.out)), "termux-licenses")
    for root, _, files in os.walk(lic):
        for fn in files:
            if re.match(r"(?i)(copyright|license)", fn):
                src = os.path.join(root, fn)
                if os.path.exists(src):
                    d = os.path.join(licdst, os.path.relpath(root, lic))
                    os.makedirs(d, exist_ok=True)
                    shutil.copyfile(src, os.path.join(d, fn))
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
