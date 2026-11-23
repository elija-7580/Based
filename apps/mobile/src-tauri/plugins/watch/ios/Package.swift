// swift-tools-version:5.3
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import PackageDescription

let package = Package(
    name: "tauri-plugin-based-watch",
    platforms: [
        .macOS(.v10_13),
        .iOS(.v13),
    ],
    products: [
        .library(name: "tauri-plugin-based-watch", type: .static, targets: ["tauri-plugin-based-watch"])
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(name: "tauri-plugin-based-watch", dependencies: [.byName(name: "Tauri")], path: "Sources")
    ]
)
