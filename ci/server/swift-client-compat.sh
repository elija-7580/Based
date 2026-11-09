#!/usr/bin/env bash
# BSD-158: Kompatibilität Swift-Client ↔ TS-Server. Startet den TS-based-server (apps/server) auf einer frischen
# Datenbank und lässt den unveränderten Swift-Client (`ServerSync`, BasedBrain) über HTTP dagegen laufen:
# Swift/BasedBrain/Tests/BasedBrainTests/ExternalServerCompatTests.swift (ohne die Umgebungsvariablen übersprungen).
# Danach liest der TS-Client denselben Server (apps/server/test/external-mixed.test.ts).
#   usage: ci/server/swift-client-compat.sh [--skip-build] [--reference]
#   --skip-build  Swift-Tests nicht neu bauen (schon mit `swift build --build-tests` gebaut)
#   --reference   dieselben Tests zusätzlich gegen den Swift-based-server (Kontrolle, dass die Tests stimmen)
# Umgebung: SWIFT_BIN (Ordner mit `swift`), BASED_COMPAT_PORT (Standard 18120; Referenz-Server: Port + 1).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PKG="$ROOT/Swift/BasedBrain"
PORT="${BASED_COMPAT_PORT:-18120}"
TOKEN="compat-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
SKIP_BUILD=0
REFERENCE=0
for a in "$@"; do
  case "$a" in
    --skip-build) SKIP_BUILD=1 ;;
    --reference) REFERENCE=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done
if [[ -n "${SWIFT_BIN:-}" ]]; then export PATH="$SWIFT_BIN:$PATH"; fi
command -v swift >/dev/null || { echo "swift not found (set SWIFT_BIN)" >&2; exit 2; }

WORK="$(mktemp -d)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

if [[ $SKIP_BUILD == 0 ]]; then (cd "$PKG" && swift build --build-tests); fi

wait_for() {
  local url="$1"
  for _ in $(seq 1 150); do
    if curl -sf "$url/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "server at $url did not start" >&2
  return 1
}

run_suite() {
  local url="$1" label="$2"
  echo "== Swift-Client gegen $label ($url)"
  (cd "$PKG" && BASED_COMPAT_SERVER_URL="$url" BASED_COMPAT_SERVER_TOKEN="$TOKEN" \
    swift test --skip-build --filter ExternalServerCompatTests 2>&1) | tee "$WORK/$label.log" | grep -E "✔|✘|passed|failed|error" || true
  if ! grep -q "Test run with .* passed" "$WORK/$label.log"; then
    echo "FEHLER: Swift-Client gegen $label" >&2
    tail -50 "$WORK/$label.log" >&2
    return 1
  fi
  if ! grep -q "ExternalServerCompatTests" "$WORK/$label.log"; then
    echo "FEHLER: Suite lief nicht (übersprungen?)" >&2
    return 1
  fi
}

# TS-Server
(cd "$ROOT/apps/server" && BASED_TOKEN="$TOKEN" BASED_LOG_LEVEL=warning exec node_modules/.bin/tsx src/main.ts \
  --db "$WORK/ts.sqlite" --port "$PORT" --host 127.0.0.1) &
PIDS+=($!)
wait_for "http://127.0.0.1:$PORT"
run_suite "http://127.0.0.1:$PORT" "ts-server"
echo "== TS-Client liest, was die Swift-Clients geschrieben haben"
(cd "$ROOT/apps/server" && BASED_COMPAT_SERVER_URL="http://127.0.0.1:$PORT" BASED_COMPAT_SERVER_TOKEN="$TOKEN" \
  "$ROOT/node_modules/.bin/vitest" run test/external-mixed.test.ts)

if [[ $REFERENCE == 1 ]]; then
  REF_PORT=$((PORT + 1))
  (cd "$PKG" && BASED_LOG_LEVEL=warning exec .build/debug/based-server --db "$WORK/swift.sqlite" --port "$REF_PORT" \
    --token "$TOKEN" --no-scheduler --no-acp) &
  PIDS+=($!)
  wait_for "http://127.0.0.1:$REF_PORT"
  run_suite "http://127.0.0.1:$REF_PORT" "swift-server"
fi
echo "swift-client compat OK"
