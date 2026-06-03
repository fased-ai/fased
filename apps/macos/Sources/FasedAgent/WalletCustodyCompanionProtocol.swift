import Foundation

enum WalletCustodyCompanionProtocol {
    static let helperName = "fased-macos-custody-companion"
    static let protocolVersion = 1
    static let host = "127.0.0.1"
    static let port: UInt16 = 18795
    static let healthPath = "/v1/custody/health"
    static let deviceShareStatusPath = "/v1/custody/device-share/status"
    static let deviceShareStorePath = "/v1/custody/device-share/store"
    static let deviceShareLoadPath = "/v1/custody/device-share/load"
    static let deviceShareDeletePath = "/v1/custody/device-share/delete"
    static let availableRoutes = [
        healthPath,
        deviceShareStatusPath,
        deviceShareStorePath,
        deviceShareLoadPath,
        deviceShareDeletePath,
    ]

    struct HealthResponse: Codable, Sendable {
        let ok: Bool
        let protocolVersion: Int
        let helper: String
        let platform: String
        let storageMode: String
        let availableRoutes: [String]
        let storedWalletCount: Int
    }

    struct DeviceShareStatusResponse: Codable, Sendable {
        let ok: Bool
        let stored: Bool
    }

    struct DeviceShareStoreRequest: Codable, Sendable {
        let gatewayOrigin: String
        let walletId: String
        let deviceShare: String
        let credentialId: String?
        let deviceLabel: String?
    }

    struct DeviceShareStoreResponse: Codable, Sendable {
        let ok: Bool
        let stored: Bool
        let storageMode: String
    }

    struct DeviceShareLoadRequest: Codable, Sendable {
        let gatewayOrigin: String
        let walletId: String
        let prompt: String?
    }

    struct DeviceShareLoadResponse: Codable, Sendable {
        let ok: Bool
        let deviceShare: String
    }

    struct DeviceShareDeleteRequest: Codable, Sendable {
        let gatewayOrigin: String
        let walletId: String
    }

    struct DeviceShareDeleteResponse: Codable, Sendable {
        let ok: Bool
        let removed: Bool
    }
}
