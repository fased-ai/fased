// swift-tools-version: 6.2
// Package manifest for the FasedAgent macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "FasedAgent",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "FasedAgentIPC", targets: ["FasedAgentIPC"]),
        .library(name: "FasedAgentDiscovery", targets: ["FasedAgentDiscovery"]),
        .executable(name: "FasedAgent", targets: ["FasedAgent"]),
        .executable(name: "fased-mac", targets: ["FasedAgentMacCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.3.1"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.1.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.8.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.8.1"),
        .package(url: "https://github.com/steipete/Peekaboo.git", branch: "main"),
        .package(path: "../shared/FasedAgentKit"),
        .package(path: "../../Swabble"),
    ],
    targets: [
        .target(
            name: "FasedAgentIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "FasedAgentDiscovery",
            dependencies: [
                .product(name: "FasedAgentKit", package: "FasedAgentKit"),
            ],
            path: "Sources/FasedAgentDiscovery",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "FasedAgent",
            dependencies: [
                "FasedAgentIPC",
                "FasedAgentDiscovery",
                .product(name: "FasedAgentKit", package: "FasedAgentKit"),
                .product(name: "FasedAgentChatUI", package: "FasedAgentKit"),
                .product(name: "FasedAgentProtocol", package: "FasedAgentKit"),
                .product(name: "SwabbleKit", package: "swabble"),
                .product(name: "MenuBarExtraAccess", package: "MenuBarExtraAccess"),
                .product(name: "Subprocess", package: "swift-subprocess"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "PeekabooBridge", package: "Peekaboo"),
                .product(name: "PeekabooAutomationKit", package: "Peekaboo"),
            ],
            exclude: [
                "Resources/Info.plist",
            ],
            resources: [
                .copy("Resources/FasedAgent.icns"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "FasedAgentMacCLI",
            dependencies: [
                "FasedAgentDiscovery",
                .product(name: "FasedAgentKit", package: "FasedAgentKit"),
                .product(name: "FasedAgentProtocol", package: "FasedAgentKit"),
            ],
            path: "Sources/FasedAgentMacCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "FasedAgentIPCTests",
            dependencies: [
                "FasedAgentIPC",
                "FasedAgent",
                "FasedAgentDiscovery",
                .product(name: "FasedAgentProtocol", package: "FasedAgentKit"),
                .product(name: "SwabbleKit", package: "swabble"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
