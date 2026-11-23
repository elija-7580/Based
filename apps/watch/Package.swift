// swift-tools-version:5.9
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Nur für die Tests der Übertragungslogik (`swift test`); die App selbst baut XcodeGen aus project.yml.
import PackageDescription

let package = Package(
    name: "WatchCapture",
    platforms: [.macOS(.v13), .watchOS(.v10)],
    targets: [
        .target(name: "WatchCapture", path: "Shared"),
        .testTarget(name: "WatchCaptureTests", dependencies: ["WatchCapture"], path: "Tests/WatchCaptureTests"),
    ]
)
