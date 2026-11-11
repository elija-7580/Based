#!/usr/bin/env python3
"""BSD-68: replaces hard-coded values that equal an existing design token with that token (pixel-identical).

  .font(.system(size: 11|12|13|14|17[, weight: .w]))  -> DS.Text.caption/small/body/ui/title(...)
  .padding([.edge, ]2|4|6|8|12|16|24)                -> DS.Space.xxs/xs/sm/md/lg/xl/xxl
  cornerRadius: 4|6|8|12  /  .cornerRadius(…)         -> DS.Radius.small/control/card/panel

Values without a token (11.5, 10, 14 pt padding …) stay; scripts/design-audit.py lists them.
Usage: scripts/design-codemod.py <file-or-dir> [...] [--exclude dir,dir]
"""
import os, re, sys

TEXT = {"11": "caption", "12": "small", "13": "body", "14": "ui", "17": "title"}
SPACE = {"2": "xxs", "4": "xs", "6": "sm", "8": "md", "12": "lg", "16": "xl", "24": "xxl"}
RADIUS = {"4": "small", "6": "control", "8": "card", "12": "panel"}

FONT = re.compile(r"\.font\(\.system\(size: (\d+)(?:, weight: \.(\w+))?\)\)")
PAD = re.compile(r"\.padding\((\.[a-zA-Z]+, )?(\d+)\)")
RAD = re.compile(r"cornerRadius(: |\()(\d+)(?![\d.])")


def font(m):
    size, weight = m.group(1), m.group(2)
    name = TEXT.get(size)
    if not name:
        return m.group(0)
    if name == "title":
        w = weight or "regular"
        return f".font(DS.Text.title({'' if w == 'semibold' else '.' + w}))"
    return f".font(DS.Text.{name}({'' if not weight or weight == 'regular' else '.' + weight}))"


def pad(m):
    name = SPACE.get(m.group(2))
    return f".padding({m.group(1) or ''}DS.Space.{name})" if name else m.group(0)


def rad(m):
    name = RADIUS.get(m.group(2))
    return f"cornerRadius{m.group(1)}DS.Radius.{name}" if name else m.group(0)


def rewrite(path):
    src = open(path, encoding="utf-8").read()
    out = []
    n = 0
    for line in src.splitlines(keepends=True):
        code, sep, comment = line.partition("//")
        new = RAD.sub(rad, PAD.sub(pad, FONT.sub(font, code)))
        if new != code:
            n += 1
        out.append(new + sep + comment)
    if n:
        open(path, "w", encoding="utf-8").write("".join(out))
    return n


def main(argv):
    excl = set()
    if "--exclude" in argv:
        i = argv.index("--exclude"); excl = {os.path.normpath(p) for p in argv[i + 1].split(",")}; del argv[i:i + 2]
    total = 0
    for root in argv:
        paths = [root] if root.endswith(".swift") else [os.path.join(d, f) for d, _, fs in os.walk(root) for f in fs if f.endswith(".swift")]
        for p in sorted(paths):
            if os.path.basename(p) in ("DesignSystem.swift", "Theme.swift"):
                continue
            if any(os.path.normpath(p).startswith(e + os.sep) or os.path.normpath(p) == e for e in excl):
                continue
            c = rewrite(p)
            if c:
                total += c
                print(f"{c:4} {p}")
    print(f"lines changed: {total}")


if __name__ == "__main__":
    main(sys.argv[1:])
