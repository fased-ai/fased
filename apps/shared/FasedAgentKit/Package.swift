// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "FasedAgentKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "FasedAgentProtocol", targets: ["FasedAgentProtocol"]),
        .library(name: "FasedAgentKit", targets: ["FasedAgentKit"]),
        .library(name: "FasedAgentChatUI", targets: ["FasedAgentChatUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/steipete/ElevenLabsKit", exact: "0.1.0"),
        .package(url: "https://github.com/gonzalezreal/textual", exact: "0.3.1"),
    ],
    targets: [
        .target(
            name: "FasedAgentProtocol",
            path: "Sources/FasedAgentProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "FasedAgentKit",
            dependencies: [
                "FasedAgentProtocol",
                .product(name: "ElevenLabsKit", package: "ElevenLabsKit"),
            ],
            path: "Sources/FasedAgentKit",
            resources: [
                .process("Resources"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "FasedAgentChatUI",
            dependencies: [
                "FasedAgentKit",
                .product(
                    name: "Textual",
                    package: "textual",
                    condition: .when(platforms: [.macOS, .iOS])),
            ],
            path: "Sources/FasedAgentChatUI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "FasedAgentKitTests",
            dependencies: ["FasedAgentKit", "FasedAgentChatUI"],
            path: "Tests/FasedAgentKitTests",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
