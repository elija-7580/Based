#!/usr/bin/env bash
# BSD-380: Architektur-Bericht mit Graphify (Apache-2.0/MIT, PyPI graphifyy, gepinnt) – nur Code, ohne LLM
# (GRAPHIFY_BACKEND=none), ohne Hooks und ohne MCP-Server. Für den wöchentlichen Architektur-Teil von Review und
# Planung; Navigation im Alltag läuft über scripts/agent-graph.sh (codebase-memory-mcp).
#   usage: scripts/graph-report.sh [--full]
#   Standard: nur God Nodes, Import-Zyklen und Kennzahlen (~1 k Tokens); --full: der ganze GRAPH_REPORT.md (~10 k).
# Der Graph entsteht in einer Kopie von apps/, packages/, scripts/ (git archive) unter ~/.cache, nie im Repo.
set -euo pipefail
VERSION=0.9.108
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${BASED_GRAPH_CACHE:-$HOME/.cache/based-agent-graph}/graphify-$VERSION"
if [ ! -x "$CACHE/venv/bin/graphify" ]; then
  mkdir -p "$CACHE"
  python3 -m venv "$CACHE/venv"
  "$CACHE/venv/bin/pip" install --quiet --disable-pip-version-check "graphifyy==$VERSION" >&2
fi
WORK="$CACHE/work"
rm -rf "$WORK" && mkdir -p "$WORK/src"
(cd "$ROOT" && git archive HEAD apps packages scripts) | tar -x -C "$WORK/src"
start=$(date +%s)
(cd "$WORK" && GRAPHIFY_BACKEND=none GRAPHIFY_QUERY_LOG_DISABLE=1 "$CACHE/venv/bin/graphify" update src >/dev/null 2>&1)
REPORT="$WORK/src/graphify-out/GRAPH_REPORT.md"
echo "graphify $VERSION: $(( $(date +%s) - start )) s"
if [ "${1:-}" = "--full" ]; then cat "$REPORT"; exit 0; fi
awk '/^## Summary/,/^## Community Hubs/' "$REPORT" | grep -v "^## Community Hubs"
awk '/^## God Nodes/,/^## Surprising/' "$REPORT" | grep -v "^## Surprising"
awk '/^## Import Cycles/,/^## Communities/' "$REPORT" | grep -v "^## Communities" | sed 's#`src/#`#g; s# -> src/# -> #g'
