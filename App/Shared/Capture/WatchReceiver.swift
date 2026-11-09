import Foundation
import BasedCore
import BasedBrain
#if os(iOS)
import WatchConnectivity
#endif

// BSD-66: the iPhone end of the Apple Watch app. A voice note arrives as a file with `WatchCaptureMeta`; it is copied
// into the asset store and becomes a capture (source Watch, recorded time of the watch) that waits for its transcript
// (`VoiceCaptureService.transcribeWaiting`). The watch shows "N today · sorted at 23:00" from the application context.

@MainActor
enum WatchImport {
    static let ledgerKey = "watch.receivedIDs"

    /// Stores one received recording. Returns false when it couldn't be stored (the watch keeps nothing either way:
    /// WatchConnectivity already finished the transfer, so failures are logged).
    @discardableResult
    static func receive(file: URL, metadata: [String: Any]?, model: AppModel) -> Bool {
        let meta: WatchCaptureMeta
        do { meta = try WatchCaptureMeta(dictionary: metadata ?? [:]) } catch {
            Log.warning("Watch transfer ignored: \(error)", category: "capture")
            return false
        }
        var ledger = WatchInboxLedger(seen: UserDefaults.standard.stringArray(forKey: ledgerKey) ?? [])
        // The system deletes `file` when the delegate call returns: copy it first.
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("watch-\(meta.id).\(meta.fileExtension)")
        do {
            try? FileManager.default.removeItem(at: copy)
            try FileManager.default.copyItem(at: file, to: copy)
            defer { try? FileManager.default.removeItem(at: copy) }
            let ref = try model.assets.importFile(at: copy)
            guard let result = WatchCaptureLogic.receive(meta: meta, audio: ref, brain: model.brain.brain, ledger: &ledger) else { return true }
            UserDefaults.standard.set(ledger.seen, forKey: ledgerKey)
            if case .failed(let m) = result { Log.warning("Watch voice note not saved: \(m)", category: "capture"); return false }
        } catch {
            Log.error("Watch voice note couldn't be stored: \(error)", category: "capture")
            return false
        }
        let brain = model.brain.brain, assets = model.assets
        Task { _ = await VoiceCaptureService.transcribeWaiting(brain: brain, assets: assets) }
        return true
    }
}

#if os(iOS)
/// WatchConnectivity on the iPhone: receives files, sends the status line.
final class WatchReceiver: NSObject, WCSessionDelegate, @unchecked Sendable {
    static let shared = WatchReceiver()
    @MainActor private weak var model: AppModel?
    @MainActor private var token: ObservationToken?
    @MainActor private var pendingPush: Task<Void, Never>?

    @MainActor
    func start(model: AppModel) {
        self.model = model
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        // Keep the watch's "N today" current while the app runs. BSD-144: coalesced — the status reads every capture,
        // so it must not run once per store change (keystroke); the observer itself only schedules.
        token = model.store.observe { [weak self] _ in
            Task { @MainActor in self?.schedulePush() }
        }
    }

    @MainActor
    private func schedulePush() {
        pendingPush?.cancel()
        pendingPush = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            self?.pushStatus()
        }
    }

    @MainActor
    func pushStatus() {
        guard let model, WCSession.isSupported(), WCSession.default.activationState == .activated,
              WCSession.default.isPaired, WCSession.default.isWatchAppInstalled else { return }
        let context = WatchCaptureLogic.status(brain: model.brain.brain).context
        guard !NSDictionary(dictionary: context).isEqual(to: WCSession.default.applicationContext) else { return }
        try? WCSession.default.updateApplicationContext(context)
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in self.pushStatus() }
    }
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        // Copy synchronously: the file is gone once this method returns.
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("watch-in-\(UUID().uuidString).\(file.fileURL.pathExtension)")
        do { try FileManager.default.copyItem(at: file.fileURL, to: tmp) } catch {
            Log.error("Watch file couldn't be copied: \(error)", category: "capture")
            return
        }
        let metadata = file.metadata.map { NSDictionary(dictionary: $0) }
        Task { @MainActor in
            defer { try? FileManager.default.removeItem(at: tmp) }
            guard let model = self.model else { return }
            WatchImport.receive(file: tmp, metadata: metadata as? [String: Any], model: model)
            self.pushStatus()
        }
    }
}
#endif
