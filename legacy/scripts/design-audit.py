#!/usr/bin/env python3
"""BSD-68: design-token audit.

Finds hard-coded design values in App/Shared outside the token files (DesignSystem.swift, Theme.swift):
  colour     Color(red:/white:/hue:/.sRGB …), Color(hex…), Theme.hex(
  font       .font(.system(size: <number>
  padding    .padding(<number>) / .padding(.edge, <number>)
  radius     cornerRadius: <number> / .cornerRadius(<number>)
  frame      .frame(width:/height:/minWidth:… <number>)   (reported, but layout sizes are often legit)

Usage: scripts/design-audit.py [--list] [--kind font,padding] [--warn-above N] [root]
Prints counts per kind (and with --list every finding as path:line). Exit code is always 0 unless
--fail-above N is given and the total (excluding frame) exceeds N.
"""
import os, re, sys

KINDS = {
    "colour": re.compile(r"Color\(\s*(red|white|hue|\.sRGB|\.displayP3|hex)\b|Color\(hex|\.init\(red:"),
    "font": re.compile(r"\.font\(\s*\.system\(\s*size:\s*[0-9]"),
    "padding": re.compile(r"\.padding\(\s*(?:\.[a-zA-Z]+\s*,\s*|\[[^\]]*\]\s*,\s*)?[0-9]"),
    "radius": re.compile(r"cornerRadius(?::|\()\s*[0-9]"),
    "frame": re.compile(r"\.frame\([^)]*\b(?:width|height|minWidth|maxWidth|minHeight|maxHeight|idealWidth|idealHeight):\s*[0-9]"),
}
SKIP_FILES = {"DesignSystem.swift", "Theme.swift"}


def scan(root):
    found = {k: [] for k in KINDS}
    for d, _, files in os.walk(root):
        for f in sorted(files):
            if not f.endswith(".swift") or f in SKIP_FILES:
                continue
            p = os.path.join(d, f)
            with open(p, encoding="utf-8") as fh:
                for n, line in enumerate(fh, 1):
                    code = line.split("//", 1)[0]
                    for k, rx in KINDS.items():
                        c = len(rx.findall(code))
                        if c:
                            found[k] += [f"{p}:{n}"] * c
    return found


def main(argv):
    args = list(argv)
    show = "--list" in args
    if show:
        args.remove("--list")
    kinds = None
    fail_above = None
    if "--kind" in args:
        i = args.index("--kind"); kinds = set(args[i + 1].split(",")); del args[i:i + 2]
    if "--fail-above" in args:
        i = args.index("--fail-above"); fail_above = int(args[i + 1]); del args[i:i + 2]
    root = args[0] if args else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "App", "Shared")
    found = scan(root)
    total = 0
    for k, hits in found.items():
        if kinds and k not in kinds:
            continue
        if k != "frame":
            total += len(hits)
        print(f"{k:8} {len(hits)}")
        if show:
            for h in hits:
                print("   ", os.path.relpath(h))
    print(f"total    {total} (without frame)")
    if fail_above is not None and total > fail_above:
        print(f"::warning::design audit: {total} hard-coded values (limit {fail_above})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
