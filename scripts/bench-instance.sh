#!/usr/bin/env bash
# Starts an optimised Debug build of Based on a COPY of the workspace (the installed app keeps running untouched),
# for profiling. Send it debug commands with scripts/bench-cmd.swift "based://debug/open?id=…".
#   usage: scripts/bench-instance.sh [data-dir]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${1:-${TMPDIR:-/tmp}/based-bench}"
SRC="$HOME/Library/Application Support/Based"
mkdir -p "$DATA"
sqlite3 "$SRC/based.sqlite" ".backup '$DATA/based.sqlite'"
cd "$ROOT"
xcodebuild -project Based.xcodeproj -scheme Based-macOS -configuration Debug -derivedDataPath "$ROOT/build-bench" \
  -skipPackagePluginValidation -skipMacroValidation SWIFT_OPTIMIZATION_LEVEL=-O SWIFT_COMPILATION_MODE=wholemodule build | tail -1
BASED_DATA_DIR="$DATA" "$ROOT/build-bench/Build/Products/Debug/Based.app/Contents/MacOS/Based" >/dev/null 2>&1 &
echo "bench pid $! data $DATA"
