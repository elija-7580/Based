#if canImport(CloudKit)
import CloudKit
import Foundation

public enum CloudSyncStatus: Equatable, Sendable {
    case disabled
    case noAccount
    case idle(lastSync: Date?)
    case syncing
    case error(String)
}

/// iCloud sync via CKSyncEngine: one CKRecord per Based record in the private zone "Based".
/// Conflicts are resolved per record by the hybrid-logical-clock stamp (last writer wins).
@MainActor
public final class CloudSync: CKSyncEngineDelegate {
    public let store: WorkspaceStore
    public let assets: FileAssetStore?
    public let container: CKContainer
    public private(set) var status: CloudSyncStatus = .idle(lastSync: nil) { didSet { onStatus?(status) } }
    public var onStatus: ((CloudSyncStatus) -> Void)?

    private var engine: CKSyncEngine?
    private let zoneID = CKRecordZone.ID(zoneName: "Based", ownerName: CKCurrentUserDefaultName)
    private var meta: Persistence? { store.persistence }
    private static let stateKey = "ck:state"
    private static let systemPrefix = "ck:sys:"

    public init(store: WorkspaceStore, containerIdentifier: String, assets: FileAssetStore?) {
        self.store = store
        self.assets = assets
        self.container = CKContainer(identifier: containerIdentifier)
    }

    // MARK: Lifecycle

    public func start() {
        guard engine == nil else { return }
        var state: CKSyncEngine.State.Serialization?
        if let data = meta?.meta(Self.stateKey) {
            state = try? JSONDecoder().decode(CKSyncEngine.State.Serialization.self, from: data)
        }
        let config = CKSyncEngine.Configuration(database: container.privateCloudDatabase,
                                                stateSerialization: state, delegate: self)
        let engine = CKSyncEngine(config)
        self.engine = engine
        if state == nil {
            // First launch with sync: create the zone and upload everything.
            engine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: zoneID))])
            enqueue(store.allRecords().map(\.key))
        }
        store.onLocalChange = { [weak self] keys in self?.enqueue(keys) }
        Task { await self.refreshAccountStatus() }
    }

    public func stop() {
        store.onLocalChange = nil
        engine = nil
        status = .disabled
    }

    public func refreshAccountStatus() async {
        do {
            let s = try await container.accountStatus()
            if s != .available { status = .noAccount }
        } catch {
            status = .error(error.localizedDescription)
        }
    }

    /// Pull remote changes and push pending local ones (pull-to-refresh, app foreground).
    public func syncNow() async {
        guard let engine else { return }
        status = .syncing
        do {
            try await engine.fetchChanges()
            try await engine.sendChanges()
            status = .idle(lastSync: Date())
        } catch {
            status = .error(error.localizedDescription)
        }
    }

    // MARK: Local → pending

    func recordID(_ key: RecordKey) -> CKRecord.ID {
        CKRecord.ID(recordName: key.description, zoneID: zoneID)
    }

    public func enqueue(_ keys: [RecordKey]) {
        guard let engine, !keys.isEmpty else { return }
        var changes: [CKSyncEngine.PendingRecordZoneChange] = []
        for k in keys {
            // A row this version can't decode is missing from memory but not deleted (BSD-16).
            if store.frozenKeys.contains(k) { continue }
            if store.record(k) != nil { changes.append(.saveRecord(recordID(k))) }
            else { changes.append(.deleteRecord(recordID(k))); meta?.setMeta(Self.systemPrefix + k.description, nil) }
        }
        engine.state.add(pendingRecordZoneChanges: changes)
    }

    // MARK: CKRecord mapping

    func ckRecord(for key: RecordKey) -> CKRecord? {
        guard let r = store.record(key), let payload = try? r.encoded() else { return nil }
        let record: CKRecord
        if let data = meta?.meta(Self.systemPrefix + key.description), let restored = Self.decodeSystemFields(data) {
            record = restored
        } else {
            record = CKRecord(recordType: "BasedRecord", recordID: recordID(key))
        }
        record["kind"] = key.kind.rawValue as CKRecordValue
        record["stamp"] = r.stamp.description as CKRecordValue
        record["payload"] = payload as CKRecordValue
        if case .block(let b) = r, let ref = b.props.asset, let url = assets?.url(for: ref) {
            record["asset"] = CKAsset(fileURL: url)
        } else {
            record["asset"] = nil
        }
        return record
    }

    func decode(_ record: CKRecord) -> Record? {
        guard let kindRaw = record["kind"] as? String, let kind = RecordKind(rawValue: kindRaw),
              let payload = record["payload"] as? Data else { return nil }
        return try? Record.decode(kind: kind, data: payload)
    }

    static func encodeSystemFields(_ record: CKRecord) -> Data {
        let coder = NSKeyedArchiver(requiringSecureCoding: true)
        record.encodeSystemFields(with: coder)
        coder.finishEncoding()
        return coder.encodedData
    }

    static func decodeSystemFields(_ data: Data) -> CKRecord? {
        guard let coder = try? NSKeyedUnarchiver(forReadingFrom: data) else { return nil }
        coder.requiresSecureCoding = true
        defer { coder.finishDecoding() }
        return CKRecord(coder: coder)
    }

    func saveSystemFields(_ record: CKRecord) {
        meta?.setMeta(Self.systemPrefix + record.recordID.recordName, Self.encodeSystemFields(record))
    }

    // MARK: CKSyncEngineDelegate

    public func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
        switch event {
        case .stateUpdate(let e):
            if let data = try? JSONEncoder().encode(e.stateSerialization) { meta?.setMeta(Self.stateKey, data) }

        case .accountChange(let e):
            switch e.changeType {
            case .signIn:
                syncEngine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: zoneID))])
                enqueue(store.allRecords().map(\.key))
                status = .idle(lastSync: nil)
            case .signOut, .switchAccounts:
                // Keep local data; forget server bookkeeping so a new account starts clean.
                if let p = meta as? SQLitePersistence {
                    for k in p.metaKeys(prefix: Self.systemPrefix) { p.setMeta(k, nil) }
                }
                status = .noAccount
            @unknown default:
                break
            }

        case .fetchedDatabaseChanges(let e):
            for d in e.deletions where d.zoneID == zoneID {
                // Zone deleted elsewhere (e.g. "Delete iCloud data"): re-upload.
                if let p = meta as? SQLitePersistence {
                    for k in p.metaKeys(prefix: Self.systemPrefix) { p.setMeta(k, nil) }
                }
                syncEngine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: zoneID))])
                enqueue(store.allRecords().map(\.key))
            }

        case .fetchedRecordZoneChanges(let e):
            var records: [Record] = []
            for m in e.modifications {
                let ck = m.record
                saveSystemFields(ck)
                if let r = decode(ck) {
                    records.append(r)
                    if case .block(let b) = r, let ref = b.props.asset, let asset = ck["asset"] as? CKAsset,
                       let url = asset.fileURL, let assets, !assets.contains(ref), let data = try? Data(contentsOf: url) {
                        try? assets.store(data, for: ref)
                    }
                }
            }
            var deletions: [RecordKey] = []
            for d in e.deletions {
                if let key = RecordKey(string: d.recordID.recordName) {
                    deletions.append(key)
                    meta?.setMeta(Self.systemPrefix + key.description, nil)
                }
            }
            let stale = store.applyRemote(records, deletions: deletions)
            enqueue(stale)

        case .sentRecordZoneChanges(let e):
            for r in e.savedRecords { saveSystemFields(r) }
            var resend: [RecordKey] = []
            for failure in e.failedRecordSaves {
                let record = failure.record
                guard let key = RecordKey(string: record.recordID.recordName) else { continue }
                switch failure.error.code {
                case .serverRecordChanged:
                    if let server = failure.error.serverRecord {
                        saveSystemFields(server)
                        if let remote = decode(server) {
                            let stale = store.applyRemote([remote])
                            resend.append(contentsOf: stale)
                        }
                    }
                case .zoneNotFound:
                    syncEngine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: zoneID))])
                    meta?.setMeta(Self.systemPrefix + key.description, nil)
                    resend.append(key)
                case .unknownItem:
                    meta?.setMeta(Self.systemPrefix + key.description, nil)
                    resend.append(key)
                case .networkFailure, .networkUnavailable, .zoneBusy, .serviceUnavailable, .notAuthenticated,
                     .operationCancelled, .requestRateLimited:
                    break // CKSyncEngine retries automatically
                default:
                    status = .error(failure.error.localizedDescription)
                }
            }
            enqueue(resend)
            status = .idle(lastSync: Date())

        case .willFetchChanges, .willSendChanges:
            status = .syncing
        case .didFetchChanges, .didSendChanges:
            status = .idle(lastSync: Date())
        case .sentDatabaseChanges, .willFetchRecordZoneChanges, .didFetchRecordZoneChanges:
            break
        @unknown default:
            break
        }
    }

    public func nextRecordZoneChangeBatch(_ context: CKSyncEngine.SendChangesContext,
                                          syncEngine: CKSyncEngine) async -> CKSyncEngine.RecordZoneChangeBatch? {
        let scope = context.options.scope
        let changes = syncEngine.state.pendingRecordZoneChanges.filter { scope.contains($0) }
        guard !changes.isEmpty else { return nil }
        var records: [CKRecord] = []
        var deletes: [CKRecord.ID] = []
        for change in changes.prefix(300) {
            switch change {
            case .saveRecord(let id):
                if let key = RecordKey(string: id.recordName), let r = ckRecord(for: key) {
                    records.append(r)
                } else {
                    syncEngine.state.remove(pendingRecordZoneChanges: [change])
                }
            case .deleteRecord(let id):
                deletes.append(id)
            @unknown default:
                break
            }
        }
        return CKSyncEngine.RecordZoneChangeBatch(recordsToSave: records, recordIDsToDelete: deletes, atomicByZone: false)
    }
}
#endif