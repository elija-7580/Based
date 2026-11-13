#!/usr/bin/env bash
# BSD-379: Code-Graph für Agenten (codebase-memory-mcp, MIT, kein Konto, keine Telemetrie). Installiert die gepinnte
# Version per npm in einen Cache (kein curl | bash), indexiert das Repo und gibt Projektnamen und Dauer aus.
#   usage: scripts/agent-graph.sh [--with-legacy]   danach: scripts/agent-graph.sh q <tool> [--flag wert …]
#   Beispiele: q search_graph --name-pattern '^moveBlocks$'
#              q trace_path --function-name deleteBlocksIn --direction inbound --depth 2
#              q get_code_snippet --qualified-name <qn aus search_graph>
#              q detect_changes          (git diff → betroffene Symbole, vor dem Commit)
# Das Projekt-Argument (--project) setzt das Skript selbst. Der Index liegt unter ~/.cache/codebase-memory-mcp und
# kommt nie ins Repo (.gitignore: .codebase-memory/).
set -euo pipefail
VERSION=0.12.1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${BASED_GRAPH_CACHE:-$HOME/.cache/based-agent-graph}/$VERSION"
BIN="$PREFIX/node_modules/.bin/codebase-memory-mcp"
if [ ! -x "$BIN" ]; then
  mkdir -p "$PREFIX"
  (cd "$PREFIX" && [ -f package.json ] || echo '{"private":true}' > "$PREFIX/package.json")
  npm install --prefix "$PREFIX" --no-audit --no-fund --silent "codebase-memory-mcp@$VERSION" >&2
fi
# Projektname wie codebase-memory-mcp ihn bildet: absoluter Pfad, Schrägstriche → Bindestriche.
PROJECT="$(echo "${ROOT#/}" | tr '/' '-')"
if [ "${1:-}" = "q" ]; then
  shift
  tool="${1:?Werkzeug fehlt, z. B. search_graph}"
  shift
  exec "$BIN" cli --quiet "$tool" --project "$PROJECT" "$@"
fi
if [ "${1:-}" = "--with-legacy" ]; then export BASED_GRAPH_LEGACY=1; fi
start=$(date +%s)
# .cbmignore schließt legacy/ (eingefrorene Swift-App) aus; --with-legacy indexiert sie mit (PRÜFEN-Abgleich).
if [ "${BASED_GRAPH_LEGACY:-}" = "1" ]; then mv "$ROOT/.cbmignore" "$ROOT/.cbmignore.off"; trap 'mv "$ROOT/.cbmignore.off" "$ROOT/.cbmignore"' EXIT; fi
"$BIN" cli --quiet index_repository --repo-path "$ROOT" >/dev/null
echo "graph: $PROJECT indexiert in $(( $(date +%s) - start )) s (codebase-memory-mcp $VERSION) – Abfragen: scripts/agent-graph.sh q <tool> …"
