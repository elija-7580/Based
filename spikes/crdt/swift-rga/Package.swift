// swift-tools-version: 6.0
// BSD-29 Spike: eigenes Text-CRDT (RGA + Marks) in reinem Swift. Nicht Teil der App, nicht in CI.
import PackageDescription

let package = Package(
    name: "SpikeRGA",
    targets: [
        .target(name: "SpikeRGA"),
        .testTarget(name: "SpikeRGATests", dependencies: ["SpikeRGA"]),
    ]
)
