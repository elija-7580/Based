# ADR 0004: Swift 6.2 is pinned; tests use Swift Testing only

- **Status:** accepted (2026-11-08, architecture review)
- **Deciders:** Elija, architecture review

## Context

The nightly agent runs `swift test` on Linux. With Swift 6.2 the Swift Testing suites pass, but the
XCTest runner then aborts on `@MainActor final class …: XCTestCase` (swift-corelibs-xctest casts test
methods to `() throws -> Void`), so `swift test` exits non-zero and ~120 XCTest cases never run on Linux.
With Swift 6.0.3 the XCTest discovery does not even compile. The safety net of every night is therefore
red.

## Options

1. Remove `@MainActor` from XCTest classes and hop to the main actor inside every test.
2. Run with `--disable-xctest` forever.
3. Pin Swift 6.2 and migrate all package tests to Swift Testing.

## Decision

Option 3. The toolchain is pinned to Swift 6.2 (local, CI template, nightly setup). New and migrated tests
in `BasedCore` and `BasedBrain` use Swift Testing only (`@Suite`, `@Test`, `#expect`, `#require`).
No `@MainActor` `XCTestCase` classes. `@MainActor struct` suites are fine. App UI tests stay XCUITest
and run only on the Mac.

## Consequences

- `swift test` (without flags) is green on Linux and on the Mac, and every test runs in both places.
- Swift Testing runs tests in parallel by default; suites that share global state must be `.serialized`.
- Performance `measure {}` blocks become plain timings with an explicit bound.
- Follow-ups: BSD-19 (BasedCore), BSD-20 (BasedBrain), BSD-22 (CI template on 6.2).
