#!/usr/bin/env bash
# Type-checks the Apple Watch app (App/watchOS) and its complication (App/watchOSWidget) on Linux against the
# signature-only stubs, the way run.sh checks App/Shared (BSD-66). The watch targets don't link BasedCore; they
# compile Swift/BasedCore/Sources/BasedCore/Watch/WatchCaptureTransfer.swift directly, so does this check.
#   usage: ci/typecheck/run-watch.sh      (output in $TYPECHECK_OUT/watch, default /tmp/based-typecheck/watch)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TC="$ROOT/ci/typecheck"; OUT="${TYPECHECK_OUT:-/tmp/based-typecheck}/watch"
rm -rf "$OUT"; mkdir -p "$OUT/mods"
FLAGS=(-D STUB_IOS -D STUB_WATCH)
mod() { local name=$1; shift; swiftc -diagnostic-style=llvm -emit-module -parse-as-library -swift-version 5 -suppress-warnings -module-name "$name" \
          -emit-module-path "$OUT/mods/$name.swiftmodule" -I "$OUT/mods" "${FLAGS[@]}" "$@"; }
mod Combine "$TC/stubs/Combine.swift"
mod CoreGraphics "$TC/stubs/CoreGraphics.swift"
mod Security "$TC/stubs/Security.swift"
mod CoreAudio "$TC/stubs/CoreAudio.swift"
mod AVFoundation "$TC/stubs/AVFoundation.swift" "$TC/stubs/AVAudioRecorder.swift"
mod StubBase "$TC/stubs/StubBase.swift"
mod UIKit "$TC/stubs/UIKit.swift"
mod UniformTypeIdentifiers "$TC/stubs/UniformTypeIdentifiers.swift"
mod SwiftUI "$TC"/stubs/SwiftUI/*.swift
mod WatchConnectivity "$TC/stubs/WatchConnectivity.swift"
mod WidgetKit "$TC/stubs/WidgetKit.swift"
SHARED="$ROOT/Swift/BasedCore/Sources/BasedCore/Watch/WatchCaptureTransfer.swift"
tc() { swiftc -diagnostic-style=llvm -typecheck -continue-building-after-errors -parse-as-library -swift-version 5 -module-name "$1" \
         -I "$OUT/mods" "${FLAGS[@]}" "${@:2}"; }
tc BasedWatch "$ROOT"/App/watchOS/*.swift "$SHARED"
tc BasedWatchWidget "$ROOT"/App/watchOSWidget/*.swift
echo "watch typecheck OK"
