#!/usr/bin/env bash
# BSD-147: Prüfungen für den TypeScript-Stack (ADR 0011). Läuft unter Linux ohne Mac.
#   usage: ci/typecheck/run-ts.sh [--e2e]
#   --e2e: zusätzlich Playwright (WebKit + Chromium) für apps/web; Browser vorher mit
#          `pnpm --filter @based/web exec playwright install --with-deps chromium webkit` holen.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm lint
pnpm -r test
if [[ "${1:-}" == "--e2e" ]]; then CI=1 pnpm --filter @based/web e2e; fi
echo "ts OK"
