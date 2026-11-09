// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "BasedCore",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "BasedCore", targets: ["BasedCore"]),
        // BSD-149 (ADR 0011): Golden Fixtures für den TypeScript-Stack (`swift run based-fixtures <out>`).
        .executable(name: "based-fixtures", targets: ["based-fixtures"]),
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
        .executableTarget(name: "based-fixtures", dependencies: ["BasedCore"]),
        .testTarget(name: "BasedCoreTests", dependencies: ["BasedCore"]),
    ]
)
