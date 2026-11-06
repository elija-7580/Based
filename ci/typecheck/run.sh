#!/usr/bin/env bash
# Type-checks the SwiftUI app sources on Linux against signature-only stubs of Apple frameworks
# (ci/typecheck/stubs) and the real BasedCore/BasedBrain modules. Catches API misuse, typos and type
# errors in App/Shared without a Mac. It cannot prove the code builds with the real SDK, but most
# errors (wrong BasedCore calls, missing members, mismatched types) show up here.
#   usage: ci/typecheck/run.sh [extra swiftc flags]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TC="$ROOT/ci/typecheck"; OUT="${TYPECHECK_OUT:-/tmp/based-typecheck}"
mkdir -p "$OUT/mods" "$OUT/src"
( cd "$ROOT/Packages/BasedBrain" && swift build --build-tests >/dev/null )
BRAIN="$ROOT/Packages/BasedBrain/.build/debug"
CSQL=(-Xcc -fmodule-map-file="$ROOT/Packages/BasedCore/Sources/CSQLite/module.modulemap" -I "$ROOT/Packages/BasedCore/Sources/CSQLite")
mod() { local name=$1; shift; swiftc -diagnostic-style=llvm -emit-module -parse-as-library -swift-version 5 -suppress-warnings -module-name "$name" \
          -emit-module-path "$OUT/mods/$name.swiftmodule" -I "$OUT/mods" "$@"; }
mod Combine "$TC/stubs/Combine.swift"

mod Security "$TC/stubs/Security.swift"
mod MetricKit "$TC/stubs/MetricKit.swift"
mod AppKit "$TC/stubs/AppKit.swift"
mod UniformTypeIdentifiers "$TC/stubs/UniformTypeIdentifiers.swift"
mod SwiftUI "$TC"/stubs/SwiftUI/*.swift
for m in CoreLocation Charts WebKit AVKit PDFKit SwiftTerm MapKit; do mod "$m" "$TC/stubs/$m.swift"; done
rm -rf "$OUT/src"; python3 "$TC/preprocess.py" "$ROOT/App/Shared" "$OUT/src"
swiftc -diagnostic-style=llvm -typecheck -continue-building-after-errors -parse-as-library -swift-version 5 -module-name Based -D DEBUG \
  -I "$OUT/mods" -I "$BRAIN" -I "$BRAIN/Modules" "${CSQL[@]}" "$@" "$OUT"/src/*.swift
echo "typecheck OK"
