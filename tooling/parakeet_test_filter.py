#!/usr/bin/env python3
"""Which Flutter test files a CI shard runs, and the --name filter that leaves out
the single tests in tooling/parakeet-test-skips.txt (dsh-Go tests of features
Parakeet removed, each listed there with its reason).

  parakeet_test_filter.py files <shard> [<shards>=3]   # test files, one per line (cwd: app/)
  parakeet_test_filter.py name                          # regex for `flutter test --name`
  parakeet_test_filter.py report                        # what is left out, by reason
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKIPS = os.path.join(HERE, "parakeet-test-skips.txt")
SPECIAL = set("\\^$.|?*+()[]{}/")


def load():
    out, reason = [], None
    for raw in open(SKIPS, encoding="utf-8"):
        line = raw.rstrip("\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            reason = line[1:-1]
            continue
        assert reason, "entry before any [reason]: " + line
        out.append((line.strip(), reason))
    return out


def split(entry):
    """('test/a_test.dart', 'full name') for one test, (path, None) for a file or directory."""
    if ".dart: " in entry:
        path, name = entry.split(".dart: ", 1)
        return path + ".dart", name
    return entry, None


def escape(s):
    return "".join("\\" + c if c in SPECIAL else c for c in s)


def main():
    cmd = sys.argv[1]
    entries = [(split(e), r) for e, r in load()]
    if cmd == "files":
        shard, shards = int(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 3
        files = sorted(os.path.join(d, f).replace(os.sep, "/")
                       for d, _, fs in os.walk("test") for f in fs if f.endswith("_test.dart"))
        gone = [p for (p, n), _ in entries if n is None]
        # Same split as before the skips (awk 'NR % 3 == shard' over the sorted list).
        mine = [f for i, f in enumerate(files, 1) if i % shards == shard]
        for f in mine:
            if not any(f == g or (g.endswith("/") and f.startswith(g)) for g in gone):
                print(f)
    elif cmd == "name":
        names = sorted({n for (_, n), _ in entries if n is not None})
        # A test runs unless its full name is one of these.
        print("^(?!(?:%s)$)" % "|".join(escape(n) for n in names))
    elif cmd == "report":
        by = {}
        for (p, n), r in entries:
            by.setdefault(r, []).append(p if n is None else "%s: %s" % (p, n))
        for r, es in by.items():
            print("%d left out: %s" % (len(es), r))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
