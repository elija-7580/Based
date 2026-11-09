// swift-tools-version: 6.0
// BSD-29 Spike: läuft automerge-swift unter Linux? Erwartet einen Klon von
// github.com/automerge/automerge-swift neben diesem Ordner (siehe ../README.md) und die selbst gebaute
// Rust-Bibliothek: swift run -Xlinker -L<klon>/rust/target/release -Xlinker -luniffi_automerge
import PackageDescription

let package = Package(
    name: "AMSpike",
    dependencies: [.package(path: "../automerge-swift")],
    targets: [.executableTarget(name: "AMSpike", dependencies: [.product(name: "Automerge", package: "automerge-swift")])]
)
