#!/usr/bin/env bash
# Type-checks the SwiftUI app sources on Linux against signature-only stubs of Apple frameworks
# (ci/typecheck/stubs) and the real BasedCore/BasedBrain modules. Catches API misuse, typos and type
# errors in App/Shared without a Mac. It cannot prove the code builds with the real SDK, but most
# errors (wrong BasedCore calls, missing members, mismatched types) show up here.
#   usage: ci/typecheck/run.sh [--ios] [extra swiftc flags]
#   --ios: check the iOS branches instead (os(iOS) true, os(macOS) false) against a UIKit stub; no AppKit module
#          is visible in that run (BSD-95). Output goes to $OUT/ios.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TC="$ROOT/ci/typecheck"; OUT="${TYPECHECK_OUT:-/tmp/based-typecheck}"
IOS=0
if [[ "${1:-}" == "--ios" ]]; then IOS=1; shift; OUT="$OUT/ios"; fi
PLATFORM=(); [[ $IOS == 1 ]] && PLATFORM=(-D STUB_IOS)
mkdir -p "$OUT/mods" "$OUT/src"
( cd "$ROOT/Swift/BasedBrain" && swift build >/dev/null )
BRAIN="$ROOT/Swift/BasedBrain/.build/debug"
CSQL=(-Xcc -fmodule-map-file="$ROOT/Swift/BasedCore/Sources/CSQLite/module.modulemap" -I "$ROOT/Swift/BasedCore/Sources/CSQLite")
mod() { local name=$1; shift; swiftc -diagnostic-style=llvm -emit-module -parse-as-library -swift-version 5 -suppress-warnings -module-name "$name" \
          -emit-module-path "$OUT/mods/$name.swiftmodule" -I "$OUT/mods" ${PLATFORM[@]+"${PLATFORM[@]}"} "$@"; }
rm -rf "$OUT/mods"; mkdir -p "$OUT/mods"
mod Combine "$TC/stubs/Combine.swift"
mod CoreGraphics "$TC/stubs/CoreGraphics.swift"

mod NaturalLanguage "$TC/stubs/NaturalLanguage.swift"
mod Carbon "$TC/stubs/Carbon.swift"
mod WatchConnectivity "$TC/stubs/WatchConnectivity.swift"
mod Security "$TC/stubs/Security.swift"
mod CoreAudio "$TC/stubs/CoreAudio.swift"
mod AVFoundation "$TC/stubs/AVFoundation.swift"
mod FluidAudio "$TC/stubs/FluidAudio.swift"
mod MetricKit "$TC/stubs/MetricKit.swift"
mod StubBase "$TC/stubs/StubBase.swift"
if [[ $IOS == 1 ]]; then mod UIKit "$TC/stubs/UIKit.swift"; else mod AppKit "$TC/stubs/AppKit.swift"; fi
mod UniformTypeIdentifiers "$TC/stubs/UniformTypeIdentifiers.swift"
mod SwiftUI "$TC"/stubs/SwiftUI/*.swift
for m in CoreLocation Charts WebKit AVKit PDFKit SwiftTerm MapKit; do mod "$m" "$TC/stubs/$m.swift"; done
PRE=(); [[ $IOS == 1 ]] && PRE=(--ios)
rm -rf "$OUT/src"; python3 "$TC/preprocess.py" ${PRE[@]+"${PRE[@]}"} "$ROOT/App/Shared" "$OUT/src"
swiftc -diagnostic-style=llvm -typecheck -continue-building-after-errors -parse-as-library -swift-version 5 -module-name Based -D DEBUG \
  -I "$OUT/mods" -I "$BRAIN" -I "$BRAIN/Modules" "${CSQL[@]}" "$@" "$OUT"/src/*.swift
if [[ $IOS == 1 ]]; then
  # BSD-131: the iOS extensions (Share sheet, Home/Lock Screen widgets) are separate modules; check them too.
  mod WidgetKit "$TC/stubs/WidgetKit.swift"
  for ext in ShareExtension Widgets; do
    rm -rf "$OUT/ext-$ext"; python3 "$TC/preprocess.py" --ios "$ROOT/App/$ext" "$OUT/ext-$ext"
    swiftc -diagnostic-style=llvm -typecheck -continue-building-after-errors -parse-as-library -swift-version 5 -module-name "Based$ext" \
      -I "$OUT/mods" -I "$BRAIN" -I "$BRAIN/Modules" "${CSQL[@]}" ${PLATFORM[@]+"${PLATFORM[@]}"} "$@" "$OUT/ext-$ext"/*.swift
  done
fi
echo "typecheck OK"

# BSD-147: TypeScript-Stack (ADR 0011) mitprüfen, sobald pnpm da ist. SKIP_TS=1 schaltet das ab.
if [[ "${SKIP_TS:-0}" != 1 ]] && command -v pnpm >/dev/null 2>&1 && [[ -f "$ROOT/pnpm-workspace.yaml" ]]; then
  bash "$ROOT/ci/typecheck/run-ts.sh"
fi
