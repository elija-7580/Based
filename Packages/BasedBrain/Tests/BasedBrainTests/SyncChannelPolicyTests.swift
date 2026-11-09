import Testing
@testable import BasedBrain

/// BSD-28: Server sync is the main channel, CloudKit is opt-in.
@Suite struct SyncChannelPolicyTests {
    @Test(arguments: [true, false], [true, false])
    func neverChosenMeansCloudKitOff(server: Bool, container: Bool) {
        let d = SyncChannelPolicy.active(serverConfigured: server, cloudKitSetting: nil, buildHasContainer: container)
        #expect(d.cloudKit == false)
        #expect(d.cloudKitSetting == false)
        #expect(d.server == server)
        #expect(d.warning == nil)
        #expect(d.label == (server ? "Server" : "Local only"))
    }

    @Test func allCombinations() {
        for server in [true, false] {
            for setting in [Bool?.none, true, false] {
                for container in [true, false] {
                    for used in [true, false] {
                        let d = SyncChannelPolicy.active(serverConfigured: server, cloudKitSetting: setting,
                                                         buildHasContainer: container, usedCloudKitBefore: used)
                        let expectedSetting = setting ?? (used && !server && container)
                        #expect(d.cloudKitSetting == expectedSetting)
                        #expect(d.cloudKit == (expectedSetting && container))
                        #expect(d.server == server)
                        #expect((d.warning != nil) == (server && d.cloudKit))
                        let label = server ? (d.cloudKit ? "Server + iCloud" : "Server") : (d.cloudKit ? "iCloud" : "Local only")
                        #expect(d.label == label)
                    }
                }
            }
        }
    }

    @Test func existingICloudOnlySetupKeepsSyncing() {
        let d = SyncChannelPolicy.active(serverConfigured: false, cloudKitSetting: nil, buildHasContainer: true, usedCloudKitBefore: true)
        #expect(d.cloudKit && d.cloudKitSetting && d.label == "iCloud")
        // … but not when a server is configured: the server is the main channel.
        let s = SyncChannelPolicy.active(serverConfigured: true, cloudKitSetting: nil, buildHasContainer: true, usedCloudKitBefore: true)
        #expect(!s.cloudKit && s.label == "Server")
    }

    @Test func explicitChoiceWins() {
        let on = SyncChannelPolicy.active(serverConfigured: true, cloudKitSetting: true, buildHasContainer: true)
        #expect(on.cloudKit && on.warning == SyncChannelPolicy.bothChannelsWarning)
        let off = SyncChannelPolicy.active(serverConfigured: false, cloudKitSetting: false, buildHasContainer: true, usedCloudKitBefore: true)
        #expect(!off.cloudKit && off.label == "Local only")
        // No container: the switch can be on, CloudKit still can't run.
        let noBuild = SyncChannelPolicy.active(serverConfigured: false, cloudKitSetting: true, buildHasContainer: false)
        #expect(!noBuild.cloudKit && noBuild.cloudKitSetting)
    }
}
