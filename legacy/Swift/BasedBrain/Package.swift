// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "BasedBrain",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "BasedBrain", targets: ["BasedBrain"]),
        .executable(name: "based-server", targets: ["based-server"]),
        // BSD-54: the `based` command line (Developer option).
        .executable(name: "based", targets: ["based-cli"]),
    ],
    dependencies: [.package(path: "../BasedCore")],
    targets: [
        .target(name: "BasedBrain", dependencies: [.product(name: "BasedCore", package: "BasedCore")]),
        .executableTarget(name: "based-server", dependencies: ["BasedBrain"]),
        .executableTarget(name: "based-cli", dependencies: ["BasedBrain"]),
        .testTarget(name: "BasedBrainTests", dependencies: ["BasedBrain"], exclude: ["Fixtures"]),
    ]
)
