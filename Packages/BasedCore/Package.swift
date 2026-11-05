// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "BasedCore",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "BasedCore", targets: ["BasedCore"]),
    ],
    targets: [
        .systemLibrary(
            name: "CSQLite",
            path: "Sources/CSQLite",
            providers: [.apt(["libsqlite3-dev"]), .yum(["sqlite-devel"])]
        ),
        .target(
            name: "BasedCore",
            dependencies: [.target(name: "CSQLite", condition: .when(platforms: [.linux]))]
        ),
        .testTarget(name: "BasedCoreTests", dependencies: ["BasedCore"]),
    ]
)
