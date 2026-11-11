import Foundation
import Observation
import BasedCore
#if canImport(Security)
import Security
#endif

/// API keys, tokens and the session key — stored in the Keychain, served from an in-memory cache.
///
/// Why the cache: locally built copies of Based are ad-hoc signed and get a new code signature with every
/// build, so the macOS Keychain asks again ("Based wants to use your confidential information…") for every
/// item after a rebuild. Before Pass 14 `SecItemCopyMatching` waited for that dialog **on the main thread**
/// while the app launched (a 431 s launch hang in a Pass 13 report).
///
/// Now:
/// - all Keychain I/O runs on one serial background queue — the main thread never waits for securityd;
/// - the launch load is **non-interactive** (no dialog); items macOS won't hand out silently become *pending*;
/// - Settings → AI shows "N keys need Keychain permission" with **Allow Keychain access…**, which reads them
///   with the normal macOS prompt (choose "Always Allow"). Signing with your Apple development team
///   (`DEVELOPMENT_TEAM` in `Config/Local.xcconfig`) keeps the signature stable, so that answer sticks
///   across rebuilds;
/// - `didLoad` is posted (main thread) whenever values arrive, so providers / sync / sessions reload.
enum Secrets {
    /// Posted on the main thread after the background load or a permission grant delivered values.
    static let didLoad = Notification.Name("BasedSecretsDidLoad")
    static let service = "com.based.app"

    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [String: String] = [:]
    nonisolated(unsafe) private static var pendingKeys: [String] = []
    nonisolated(unsafe) private static var loadedFlag = false
    nonisolated(unsafe) private static var started = false
    private static let queue = DispatchQueue(label: "based.secrets", qos: .userInitiated)

    // MARK: Read / write — never blocks on the Keychain

    /// The cached value (nil until the background load finished, see `isLoaded` / `didLoad`).
    static func get(_ key: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let v = cache[key], !v.isEmpty else { return nil }
        return v
    }

    /// Updates the cache immediately; the Keychain write happens on the background queue.
    static func set(_ key: String, _ value: String?) {
        let v = (value?.isEmpty ?? true) ? nil : value
        lock.lock()
        let wasPending = pendingKeys.contains(key)
        pendingKeys.removeAll { $0 == key }   // a value typed now replaces what the Keychain had
        let changed = cache[key] != v
        cache[key] = v
        lock.unlock()
        if changed || wasPending { queue.async { write(key, v) } }
        publishStatus()
    }

    /// Keys in the Keychain this build couldn't read without a permission prompt.
    static var pending: [String] { lock.lock(); defer { lock.unlock() }; return pendingKeys }
    static func isPending(_ key: String) -> Bool { lock.lock(); defer { lock.unlock() }; return pendingKeys.contains(key) }
    /// False until the launch load finished — don't generate replacement keys (the session key) before that.
    static var isLoaded: Bool { lock.lock(); defer { lock.unlock() }; return loadedFlag }
    static var cachedCount: Int { lock.lock(); defer { lock.unlock() }; return cache.count }

    // MARK: Launch load / permission grant

    /// Call once, first thing at launch. Reads every item without UI on the background queue.
    static func startLoading() {
        lock.lock()
        guard !started else { lock.unlock(); return }
        started = true
        lock.unlock()
        queue.async {
            let start = Date()
            let (values, left, listed) = loadAll(interactive: false)
            let ms = Int(Date().timeIntervalSince(start) * 1000)
            lock.lock()
            for (k, v) in values where cache[k] == nil { cache[k] = v }   // keys set meanwhile win
            pendingKeys = left.filter { cache[$0] == nil }
            loadedFlag = true
            let pendingNow = pendingKeys
            lock.unlock()
            if pendingNow.isEmpty {
                Log.info("Keychain: \(values.count) of \(listed) item(s) loaded in \(ms) ms", category: "secrets")
            } else {
                Log.notice("Keychain: \(values.count) of \(listed) item(s) loaded in \(ms) ms; \(pendingNow.count) need permission (\(pendingNow.joined(separator: ", "))) — new code signature? Settings → AI → Allow Keychain access…", category: "secrets")
            }
            announce()
        }
    }

    /// Reads the pending keys *with* the macOS prompt (one per key). Runs on the background queue.
    static func requestPendingAccess(completion: @escaping @MainActor (_ granted: Int, _ remaining: Int) -> Void) {
        queue.async {
            let keys = pending
            var got: [String: String] = [:]
            var left: [String] = []
            #if os(macOS) && canImport(Security)
            for a in keys {
                switch read(a) {
                case .value(let v): got[a] = v
                case .missing: break
                case .failed(let st):
                    left.append(a)
                    Log.warning("Keychain access to “\(a)” not granted (OSStatus \(st))", category: "secrets")
                }
            }
            #endif
            lock.lock()
            for (k, v) in got where cache[k] == nil { cache[k] = v }
            pendingKeys = left.filter { cache[$0] == nil }
            let remaining = pendingKeys.count
            lock.unlock()
            Log.notice("Keychain access: \(got.count) granted, \(remaining) remaining", category: "secrets")
            announce()
            Task { @MainActor in completion(got.count, remaining) }
        }
    }

    /// Hides the permission notice for this session (the items stay in the Keychain).
    static func dismissPending() {
        lock.lock(); pendingKeys = []; lock.unlock()
        publishStatus()
    }

    // MARK: Internals

    private static func announce() {
        Task { @MainActor in
            SecretsStatus.shared.refresh()
            NotificationCenter.default.post(name: didLoad, object: nil)
        }
    }

    private static func publishStatus() { Task { @MainActor in SecretsStatus.shared.refresh() } }

    #if canImport(Security)
    private enum ReadResult { case value(String), missing, failed(OSStatus) }

    /// (values, keys that need permission, number of items found). Background queue only.
    private static func loadAll(interactive: Bool) -> ([String: String], [String], Int) {
        #if os(macOS)
        // Legacy file keychain: list accounts (attributes only — nothing is decrypted, no prompt),
        // then read each one with user interaction switched off.
        let accounts = listAccounts()
        guard !accounts.isEmpty else { return ([:], [], 0) }
        var values: [String: String] = [:], left: [String] = []
        if !interactive { _ = SecKeychainSetUserInteractionAllowed(false) }
        for a in accounts {
            switch read(a) {
            case .value(let v): values[a] = v
            case .missing: break
            case .failed: left.append(a)
            }
        }
        if !interactive { _ = SecKeychainSetUserInteractionAllowed(true) }
        return (values, left, accounts.count)
        #else
        // iOS: one query returns everything (no ACL prompts on iOS).
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecReturnAttributes as String: true, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        var out: AnyObject?
        var values: [String: String] = [:]
        if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let items = out as? [[String: Any]] {
            for item in items {
                if let a = item[kSecAttrAccount as String] as? String, let d = item[kSecValueData as String] as? Data,
                   let s = String(data: d, encoding: .utf8), !s.isEmpty { values[a] = s }
            }
        }
        return (values, [], values.count)
        #endif
    }

    private static func listAccounts() -> [String] {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        var out: AnyObject?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        guard st == errSecSuccess, let items = out as? [[String: Any]] else {
            if st != errSecItemNotFound { Log.info("Keychain listing: OSStatus \(st)", category: "secrets") }
            return []
        }
        return Array(Set(items.compactMap { $0[kSecAttrAccount as String] as? String })).sorted()
    }

    private static func read(_ account: String) -> ReadResult {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        if st == errSecItemNotFound { return .missing }
        guard st == errSecSuccess, let d = out as? Data, let s = String(data: d, encoding: .utf8) else { return .failed(st) }
        return s.isEmpty ? .missing : .value(s)
    }

    /// Background queue only (deleting an item another build created may show the macOS prompt —
    /// that's fine here, nothing waits for it).
    private static func write(_ key: String, _ value: String?) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        _ = SecItemDelete(base as CFDictionary)
        guard let value else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let st = SecItemAdd(add as CFDictionary, nil)
        if st != errSecSuccess { Log.warning("Keychain write of “\(key)” failed (OSStatus \(st))", category: "secrets") }
    }
    #else
    private static func loadAll(interactive: Bool) -> ([String: String], [String], Int) {
        var values: [String: String] = [:]
        for (k, v) in UserDefaults.standard.dictionaryRepresentation() where k.hasPrefix("secret.") {
            if let s = v as? String, !s.isEmpty { values[String(k.dropFirst(7))] = s }
        }
        return (values, [], values.count)
    }
    private static func write(_ key: String, _ value: String?) { UserDefaults.standard.set(value, forKey: "secret." + key) }
    #endif
}

/// SwiftUI-observable mirror of the secrets state (pending permission, revision for refreshing fields).
@MainActor @Observable
final class SecretsStatus {
    static let shared = SecretsStatus()
    private(set) var pending: [String] = []
    private(set) var loaded = false
    private(set) var revision = 0
    private(set) var requesting = false
    var lastMessage: String?

    func refresh() {
        pending = Secrets.pending
        loaded = Secrets.isLoaded
        revision += 1
    }

    /// Human names for the pending keys ("Anthropic API key", "Server token", …).
    var pendingDescription: String { pending.map(Self.label).joined(separator: ", ") }

    static func label(_ key: String) -> String {
        switch key {
        case "anthropic": return "Anthropic API key"
        case "openai": return "OpenAI API key"
        case "server.token": return "Server token"
        case "notion": return "Notion token"
        case "session.key": return "Session encryption key"
        default: return key
        }
    }

    func requestAccess() {
        guard !requesting else { return }
        requesting = true
        lastMessage = nil
        Secrets.requestPendingAccess { [weak self] granted, remaining in
            guard let self else { return }
            self.requesting = false
            self.lastMessage = remaining == 0 ? "Loaded \(granted) key\(granted == 1 ? "" : "s") from the Keychain."
                : "Loaded \(granted); \(remaining) still not allowed."
            self.refresh()
        }
    }
}
