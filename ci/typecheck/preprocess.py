#!/usr/bin/env python3
"""Copy App sources into a temp dir, resolving Apple-platform conditions so they type-check on Linux
against the stub frameworks in ./stubs. Usage: preprocess.py <src-dir>... <out-dir>"""
import os, re, sys
*srcs, out = sys.argv[1:]
os.makedirs(out, exist_ok=True)
def selector(m_text):
    out, i = [], 0
    while True:
        j = m_text.find("#selector(", i)
        if j < 0: out.append(m_text[i:]); break
        out.append(m_text[i:j]); k = j + len("#selector("); depth = 1; s = k
        while depth: 
            if m_text[k] == "(": depth += 1
            elif m_text[k] == ")": depth -= 1
            k += 1
        inner = m_text[s:k-1].replace('"', "'")
        out.append('Selector("%s")' % inner); i = k
    return "".join(out)
for src in srcs:
    for root, _, files in os.walk(src):
        for f in files:
            if not f.endswith(".swift"): continue
            p = os.path.join(root, f); t = open(p, encoding="utf-8").read()
            t = re.sub(r"\bos\(macOS\)", "true", t)
            t = re.sub(r"\bos\((iOS|watchOS|visionOS|tvOS)\)", "false", t)
            t = re.sub(r"\btargetEnvironment\(macCatalyst\)", "false", t)
            t = re.sub(r"@objc(\([^)]*\))?\s+", "", t)
            t = selector(t)
            rel = os.path.relpath(p, src).replace(os.sep, "__")
            open(os.path.join(out, os.path.basename(src.rstrip("/")) + "__" + rel), "w", encoding="utf-8").write(t)
