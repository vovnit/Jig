import Foundation
import Security

/// Secret `data` fields, in the Keychain: one generic password per field, with the
/// app as the service. Items stay on this device (no backups or device transfer) and
/// are readable after the first unlock, so background jobs can use them later.
/// Methods return an error message, or nil on success.
nonisolated enum SecretStore {
    private static func query(app: String, key: String? = nil) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.nitochkin.jig.\(app)",
        ]
        if let key { q[kSecAttrAccount as String] = key }
        return q
    }

    static func get(app: String, key: String) -> String? {
        var q = query(app: app, key: key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(app: String, key: String, value: String) -> String? {
        let data = Data(value.utf8)
        let status = SecItemUpdate(query(app: app, key: key) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard status == errSecItemNotFound else { return message(status) }
        var add = query(app: app, key: key)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return message(SecItemAdd(add as CFDictionary, nil))
    }

    static func delete(app: String, key: String) -> String? {
        message(SecItemDelete(query(app: app, key: key) as CFDictionary))
    }

    static func clear(app: String) -> String? {
        message(SecItemDelete(query(app: app) as CFDictionary))
    }

    private static func message(_ status: OSStatus) -> String? {
        if status == errSecSuccess || status == errSecItemNotFound { return nil }
        return SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)"
    }
}
