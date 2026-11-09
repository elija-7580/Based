import Foundation

/// Which sync channels run (BSD-28, ADR 0001): the Based server (sync v2) is the main channel; iCloud/CloudKit
/// is experimental and off unless the user turns it on. The two channels don't forward to each other
/// (CloudKit changes are logged `local=0` and never reach the server; server pulls never reach CloudKit),
/// so devices that use different channels drift apart — hence one channel is recommended.
public enum SyncChannelPolicy {
    /// UserDefaults key of the iCloud switch (absent = never chosen).
    public static let cloudKitSettingKey = "sync.cloudKitEnabled"

    public struct Decision: Equatable, Sendable {
        /// Run Server sync (it is configured).
        public var server: Bool
        /// Run CloudKit sync.
        public var cloudKit: Bool
        /// The value to store for the iCloud switch (resolves a never-chosen setting once).
        public var cloudKitSetting: Bool
        /// Both channels on: warn that devices on only one channel won't see each other's changes.
        public var warning: String?
        /// Short status for sidebar/topbar: "Server", "iCloud", "Server + iCloud", "Local only".
        public var label: String
    }

    public static let bothChannelsWarning =
        "Server and iCloud are both on. They don't forward changes to each other: a device that uses only one of them won't see edits made through the other. Use one channel on all devices."

    /// - Parameters:
    ///   - serverConfigured: server URL and token are set.
    ///   - cloudKitSetting: the iCloud switch; nil if the user never chose (default: off).
    ///   - buildHasContainer: this build has an iCloud container and `BASED_CLOUD_SYNC`.
    ///   - usedCloudKitBefore: this workspace already synced through CloudKit (CloudKit state in the database).
    ///     A never-chosen switch then stays on when no server is configured, so an existing iCloud-only setup
    ///     doesn't silently stop syncing after the update.
    public static func active(serverConfigured: Bool, cloudKitSetting: Bool?, buildHasContainer: Bool,
                              usedCloudKitBefore: Bool = false) -> Decision {
        let setting = cloudKitSetting ?? (usedCloudKitBefore && !serverConfigured && buildHasContainer)
        let cloud = setting && buildHasContainer
        let label: String
        switch (serverConfigured, cloud) {
        case (true, true): label = "Server + iCloud"
        case (true, false): label = "Server"
        case (false, true): label = "iCloud"
        case (false, false): label = "Local only"
        }
        return Decision(server: serverConfigured, cloudKit: cloud, cloudKitSetting: setting,
                        warning: serverConfigured && cloud ? bothChannelsWarning : nil, label: label)
    }
}
