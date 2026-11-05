#!/usr/bin/env python3
"""Build GitHub push_files payloads for changed files (agent helper).
Usage: mkpush.py "commit message"   -> writes /data/push-N.json, prints summary
       mkpush.py --confirm          -> marks the pending files as pushed
"""
import hashlib, json, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, ".pushstate.json")
PENDING = os.path.join(ROOT, ".pushstate.pending.json")
SKIP_DIRS = {".build", ".swiftpm", "DerivedData", ".git", "xcuserdata", "node_modules"}
SKIP_FILES = {".pushstate.json", ".pushstate.pending.json", ".DS_Store"}
LIMIT = 850_000

def load(p):
    try:
        with open(p) as f: return json.load(f)
    except FileNotFoundError: return {}

if sys.argv[1:] == ["--confirm"]:
    state = load(STATE); state.update(load(PENDING))
    json.dump(state, open(STATE, "w"), indent=0, sort_keys=True)
    if os.path.exists(PENDING): os.remove(PENDING)
    print("confirmed", len(state), "files tracked"); sys.exit(0)

msg = sys.argv[1] if len(sys.argv) > 1 else "Update"
state = load(STATE); changed = []
for d, dirs, files in os.walk(ROOT):
    dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
    for name in sorted(files):
        if name in SKIP_FILES: continue
        full = os.path.join(d, name); rel = os.path.relpath(full, ROOT)
        data = open(full, "rb").read()
        try: text = data.decode("utf-8")
        except UnicodeDecodeError: continue
        h = hashlib.sha1(data).hexdigest()
        if state.get(rel) != h: changed.append((rel, text, h))
for f in os.listdir("/data"):
    if f.startswith("push-") and f.endswith(".json"): os.remove(os.path.join("/data", f))
batches, cur, size = [], [], 0
for rel, text, h in changed:
    if cur and size + len(text) > LIMIT: batches.append(cur); cur, size = [], 0
    cur.append((rel, text, h)); size += len(text)
if cur: batches.append(cur)
pending = {}
for i, b in enumerate(batches, 1):
    payload = {"owner": "elija-7580", "repo": "Based", "branch": "main",
               "message": msg if len(batches) == 1 else f"{msg} ({i}/{len(batches)})",
               "files": [{"path": r, "content": t} for r, t, _ in b]}
    json.dump(payload, open(f"/data/push-{i}.json", "w"))
    pending.update({r: h for r, _, h in b})
json.dump(pending, open(PENDING, "w"))
print(f"{len(changed)} changed files in {len(batches)} batch(es)")
for rel, _, _ in changed[:40]: print("  ", rel)
