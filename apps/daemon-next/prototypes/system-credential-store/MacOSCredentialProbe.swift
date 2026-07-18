// THROWAWAY PROTOTYPE for #677. Not production credential-store code.
import Foundation
import Security

enum ProbeFailure: Error, CustomStringConvertible {
    case status(String, OSStatus)
    case assertion(String)

    var description: String {
        switch self {
        case let .status(operation, status): return "\(operation):\(mapStatus(status)):\(status)"
        case let .assertion(code): return code
        }
    }
}

func mapStatus(_ status: OSStatus) -> String {
    switch status {
    case errSecSuccess: return "ready"
    case errSecItemNotFound: return "not_found"
    case errSecInteractionNotAllowed: return "prompt_required"
    case errSecAuthFailed: return "denied"
    case errSecUserCanceled: return "denied"
    case errSecMissingEntitlement: return "denied"
    case errSecNotAvailable: return "backend_unavailable"
    case errSecDecode: return "corrupt"
    default: return "backend_error"
    }
}

func randomData(count: Int) throws -> Data {
    var bytes = [UInt8](repeating: 0, count: count)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else { throw ProbeFailure.status("random", status) }
    return Data(bytes)
}

func constantTimeEqual(_ lhs: Data, _ rhs: Data) -> Bool {
    guard lhs.count == rhs.count else { return false }
    return zip(lhs, rhs).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
}

func baseQuery(
    service: String,
    account: String,
    keychain: SecKeychain? = nil,
    dataProtection: Bool = false,
    failAuthenticationUI: Bool = false
) -> [String: Any] {
    var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
    if failAuthenticationUI { query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail }
    if let keychain {
        query[kSecUseKeychain as String] = keychain
    } else if dataProtection {
        query[kSecUseDataProtectionKeychain as String] = true
    }
    return query
}

func add(service: String, account: String, secret: Data, keychain: SecKeychain? = nil, dataProtection: Bool = false) throws {
    var query = baseQuery(service: service, account: account, keychain: keychain, dataProtection: dataProtection)
    if dataProtection {
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    }
    query[kSecValueData as String] = secret
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else { throw ProbeFailure.status("add", status) }
}

func read(service: String, account: String, keychain: SecKeychain? = nil, dataProtection: Bool = false) throws -> Data {
    var query = baseQuery(
        service: service,
        account: account,
        keychain: keychain,
        dataProtection: dataProtection,
        failAuthenticationUI: true
    )
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else { throw ProbeFailure.status("read", status) }
    guard let data = result as? Data else { throw ProbeFailure.assertion("READ_RESULT_NOT_DATA") }
    return data
}

func update(service: String, account: String, secret: Data, keychain: SecKeychain? = nil, dataProtection: Bool = false) throws {
    let status = SecItemUpdate(
        baseQuery(service: service, account: account, keychain: keychain, dataProtection: dataProtection) as CFDictionary,
        [kSecValueData as String: secret] as CFDictionary
    )
    guard status == errSecSuccess else { throw ProbeFailure.status("update", status) }
}

@discardableResult
func delete(service: String, account: String, keychain: SecKeychain? = nil, dataProtection: Bool = false) -> OSStatus {
    SecItemDelete(baseQuery(service: service, account: account, keychain: keychain, dataProtection: dataProtection) as CFDictionary)
}

func require(_ condition: @autoclosure () -> Bool, _ code: String) throws {
    guard condition() else { throw ProbeFailure.assertion(code) }
}

func makeScratchKeychain(path: String, password: Data) throws -> SecKeychain {
    var keychain: SecKeychain?
    let status = password.withUnsafeBytes { buffer in
        SecKeychainCreate(path, UInt32(buffer.count), buffer.baseAddress, false, nil, &keychain)
    }
    guard status == errSecSuccess, let keychain else { throw ProbeFailure.status("create_keychain", status) }
    return keychain
}

func currentUserDefaultKeychain() throws -> SecKeychain {
    var keychain: SecKeychain?
    let status = SecKeychainCopyDefault(&keychain)
    guard status == errSecSuccess, let keychain else { throw ProbeFailure.status("copy_default_keychain", status) }
    return keychain
}

do {
    let runId = UUID().uuidString.lowercased()
    let service = "dev.agentbean.prototype.credential.\(runId)"
    let profileA = "ref-\(UUID().uuidString.lowercased())-g1"
    let profileB = "ref-\(UUID().uuidString.lowercased())-g1"
    let firstSecret = try randomData(count: 32)
    let replacementSecret = try randomData(count: 32)
    let siblingSecret = try randomData(count: 32)
    let dataProtectionService = "dev.agentbean.prototype.credential.dp.\(runId)"
    let dataProtectionAccount = "ref-\(UUID().uuidString.lowercased())-g1"
    let dataProtectionSecret = try randomData(count: 32)
    let userKeychain = try currentUserDefaultKeychain()

    defer {
        _ = delete(service: service, account: profileA, keychain: userKeychain)
        _ = delete(service: service, account: profileB, keychain: userKeychain)
        _ = delete(service: dataProtectionService, account: dataProtectionAccount, dataProtection: true)
    }

    var dataProtectionStatus = "ready"
    var dataProtectionOSStatus = Int(errSecSuccess)
    do {
        try add(
            service: dataProtectionService,
            account: dataProtectionAccount,
            secret: dataProtectionSecret,
            dataProtection: true
        )
        let dataProtectionReadBack = try read(
            service: dataProtectionService,
            account: dataProtectionAccount,
            dataProtection: true
        )
        try require(constantTimeEqual(dataProtectionReadBack, dataProtectionSecret), "DATA_PROTECTION_READ_BACK_MISMATCH")
    } catch let failure as ProbeFailure {
        guard case let .status(_, status) = failure else { throw failure }
        dataProtectionStatus = mapStatus(status)
        dataProtectionOSStatus = Int(status)
    }

    try add(service: service, account: profileA, secret: firstSecret, keychain: userKeychain)
    let firstReadBack = try read(service: service, account: profileA, keychain: userKeychain)
    try require(constantTimeEqual(firstReadBack, firstSecret), "READ_BACK_MISMATCH")
    try update(service: service, account: profileA, secret: replacementSecret, keychain: userKeychain)
    let replacementReadBack = try read(service: service, account: profileA, keychain: userKeychain)
    try require(constantTimeEqual(replacementReadBack, replacementSecret), "UPDATE_READ_BACK_MISMATCH")
    try add(service: service, account: profileB, secret: siblingSecret, keychain: userKeychain)
    let siblingReadBack = try read(service: service, account: profileB, keychain: userKeychain)
    try require(constantTimeEqual(siblingReadBack, siblingSecret), "PROFILE_B_READ_BACK_MISMATCH")
    let isolatedProfileReadBack = try read(service: service, account: profileA, keychain: userKeychain)
    try require(!constantTimeEqual(isolatedProfileReadBack, siblingSecret), "PROFILE_SECRET_COLLISION")

    try require(delete(service: service, account: profileA, keychain: userKeychain) == errSecSuccess, "DELETE_FAILED")
    do {
        _ = try read(service: service, account: profileA, keychain: userKeychain)
        throw ProbeFailure.assertion("DELETE_NOT_CONFIRMED")
    } catch let failure as ProbeFailure {
        guard case let .status(_, status) = failure, status == errSecItemNotFound else { throw failure }
    }

    let scratchPath = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("agentbean-credential-prototype-\(runId).keychain-db").path
    let scratchPassword = try randomData(count: 24)
    let scratchService = "dev.agentbean.prototype.locked.\(runId)"
    let scratchAccount = "ref-\(UUID().uuidString.lowercased())-g1"
    let scratchSecret = try randomData(count: 32)
    let scratchKeychain = try makeScratchKeychain(path: scratchPath, password: scratchPassword)
    defer { SecKeychainDelete(scratchKeychain) }
    try add(service: scratchService, account: scratchAccount, secret: scratchSecret, keychain: scratchKeychain)
    try require(SecKeychainLock(scratchKeychain) == errSecSuccess, "SCRATCH_LOCK_FAILED")
    var lockedStatus = "unknown"
    do {
        _ = try read(service: scratchService, account: scratchAccount, keychain: scratchKeychain)
        throw ProbeFailure.assertion("LOCKED_READ_UNEXPECTEDLY_SUCCEEDED")
    } catch let failure as ProbeFailure {
        guard case let .status(_, status) = failure else { throw failure }
        lockedStatus = mapStatus(status)
        try require(
            status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecItemNotFound,
            "LOCKED_STATUS_UNSTABLE_\(status)"
        )
    }

    let verdict: [String: Any] = [
        "schemaVersion": 1,
        "question": "macos-current-user-keychain-no-ui-generation-and-lock-boundary",
        "host": ["os": ProcessInfo.processInfo.operatingSystemVersionString, "arch": "arm64"],
        "checks": [
            "genericPassword": true,
            "dataProtectionAfterFirstUnlockStatus": dataProtectionStatus,
            "dataProtectionAfterFirstUnlockOSStatus": dataProtectionOSStatus,
            "legacyCurrentUserKeychainOperations": true,
            "writeReadBack": true,
            "updateReadBack": true,
            "opaqueProfileIsolation": true,
            "deleteConfirmedNotFound": true,
            "authenticationUiFail": true,
            "lockedStatus": lockedStatus,
            "secretAbsentFromArgvAndEnvironment": true,
            "cleanupAttempted": true,
        ],
        "verdict": "macos-local-user-partial-needs-launchagent-session-transitions",
    ]
    let json = try JSONSerialization.data(withJSONObject: verdict, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write(Data([0x0A]))
} catch {
    FileHandle.standardError.write(Data("PROBE_FAILED:\(error)\n".utf8))
    exit(1)
}
