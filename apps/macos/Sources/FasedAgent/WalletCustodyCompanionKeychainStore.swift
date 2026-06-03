import Foundation
import LocalAuthentication
import Security

struct WalletCustodyCompanionStoredShareRecord: Codable, Sendable {
    let version: Int
    let gatewayOrigin: String
    let walletId: String
    let deviceShare: String
    let credentialId: String?
    let deviceLabel: String?
    let createdAt: String
    let updatedAt: String
}

struct WalletCustodyCompanionStoredShareSummary: Codable, Sendable {
    let gatewayOrigin: String
    let walletId: String
    let deviceLabel: String?
    let updatedAt: String
}

final class WalletCustodyCompanionKeychainStore {
    static let shared = WalletCustodyCompanionKeychainStore()

    private let service = "ai.fased.wallet-custody.device-share"
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private init() {}

    func save(_ record: WalletCustodyCompanionStoredShareRecord) throws {
        let account = Self.accountKey(
            gatewayOrigin: record.gatewayOrigin,
            walletId: record.walletId)
        let data = try self.encoder.encode(record)
        _ = self.delete(gatewayOrigin: record.gatewayOrigin, walletId: record.walletId)

        var accessControlError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .userPresence,
            &accessControlError)
        else {
            let error = accessControlError?.takeRetainedValue()
            throw NSError(
                domain: "WalletCustodyCompanionKeychainStore",
                code: -1,
                userInfo: [
                    NSLocalizedDescriptionKey: "Failed to create keychain access control.",
                    NSUnderlyingErrorKey: error as Any,
                ])
        }

        var insert: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessControl as String: accessControl,
        ]
        insert[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIAllow
        let insertStatus = SecItemAdd(insert as CFDictionary, nil)
        guard insertStatus == errSecSuccess else {
            throw Self.error(for: insertStatus, operation: "insert")
        }
    }

    func load(
        gatewayOrigin: String,
        walletId: String,
        prompt: String
    ) throws -> WalletCustodyCompanionStoredShareRecord? {
        let context = LAContext()
        context.localizedReason = prompt
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: Self.accountKey(gatewayOrigin: gatewayOrigin, walletId: walletId),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context,
            kSecUseOperationPrompt as String: prompt,
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = item as? Data else {
            throw Self.error(for: status, operation: "load")
        }
        return try self.decoder.decode(WalletCustodyCompanionStoredShareRecord.self, from: data)
    }

    @discardableResult
    func delete(gatewayOrigin: String, walletId: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: Self.accountKey(gatewayOrigin: gatewayOrigin, walletId: walletId),
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    func hasStoredShare(gatewayOrigin: String, walletId: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecAttrAccount as String: Self.accountKey(gatewayOrigin: gatewayOrigin, walletId: walletId),
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        return status == errSecSuccess && item != nil
    }

    func storedWalletCount() -> Int {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: self.service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return 0
        }
        guard status == errSecSuccess else {
            return 0
        }
        if let rows = item as? [[String: Any]] {
            return rows.count
        }
        if item != nil {
            return 1
        }
        return 0
    }

    private static func accountKey(gatewayOrigin: String, walletId: String) -> String {
        "\(gatewayOrigin.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())::\(walletId.trimmingCharacters(in: .whitespacesAndNewlines))"
    }

    private static func error(for status: OSStatus, operation: String) -> NSError {
        NSError(
            domain: "WalletCustodyCompanionKeychainStore",
            code: Int(status),
            userInfo: [
                NSLocalizedDescriptionKey: "Keychain \(operation) failed with status \(status).",
            ])
    }
}
