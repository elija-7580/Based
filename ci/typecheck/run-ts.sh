#!/usr/bin/env bash
# BSD-147: Prüfungen für den TypeScript-Stack (ADR 0011). Läuft unter Linux ohne Mac.
#   usage: ci/typecheck/run-ts.sh [--fast | --e2e | --e2e-area <muster>]
#   (ohne Option)       typecheck, lint, Unit-Tests in beiden Datenformaten (inkl. Fixture-Runner)
#   --fast              wie der CI-Job ts-fast (BSD-322): dazu Playwright-Smoke (@smoke, nur Chromium) – der Merge-Check
#   --e2e-area <muster> dazu nur die Playwright-Specs, deren Dateiname auf <muster> passt (sonst: Titel per --grep),
#                       beide Browser, z. B. --e2e-area editor  oder  --e2e-area "database-(views|create)"
#   --e2e               dazu der volle Playwright-Lauf (WebKit + Chromium, inkl. @perf mit den lokalen Schwellen)
#   Browser vorher mit `pnpm --filter @based/web exec playwright install --with-deps chromium webkit` holen.
#   Mehrere Arbeitsordner auf einer Maschine: BASED_E2E_PORT=<port> setzen.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mode="${1:-}"
area=""
case "$mode" in
  ""|--fast|--e2e) ;;
  --e2e-area) area="${2:?--e2e-area braucht ein Muster}" ;;
  *) echo "unbekannte Option: $mode (erlaubt: --fast, --e2e, --e2e-area <muster>)" >&2; exit 2 ;;
esac
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm lint
pnpm -r test
# BSD-30: dieselben Tests noch einmal im neuen Format (Spalten als eigene Records).
BASED_PROPERTY_RECORDS=1 pnpm -r test
pw() { CI=1 pnpm --filter @based/web exec playwright test --trace off "$@"; }
case "$mode" in
  --fast) pw --project=chromium --grep @smoke ;;
  --e2e-area)
    if ls apps/web/e2e | grep -qE "$area"; then pw "$area"; else pw --grep "$area"; fi ;;
  --e2e) CI=1 pnpm --filter @based/web e2e ;;
esac
echo "ts OK"
