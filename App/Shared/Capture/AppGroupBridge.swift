import Foundation
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#else
import UIKit
#endif
#if canImport(WidgetKit)
import WidgetKit
#endif

/// BSD-11: the app's side of the App Group shared with the Share extension and the widgets
/// (`group.<bundle id>`; the extensions read the same id from their Info.plist key `BasedAppGroup`).
///
/// * Things shared through the Share sheet wait as small files in `ShareInbox/`; they are filed into Captures when
///   the app starts or comes to the foreground.
/// * `widget.json` holds what the widgets show (running agents, what needs you, captures today); rewritten a few
///   seconds after the workspace changes, only when the content differs.
/// Without the App Group capability (not yet enabled for the app) the container is nil and all of this is a no-op.
@MainActor
final class AppGroupBridge {
    static let shared = AppGroupBridge()

    static var groupIdentifier: String {
        (Bundle.main.object(forInfoDictionaryKey: "BasedAppGroup") as? String) ?? "group.\(Bundle.main.bundleIdentifier ?? "based")"
    }

    /// The App Group folder, only when it exists. On macOS `containerURL` returns a path even without the App Group
    /// entitlement; the system creates the folder only for entitled apps. Without it we must not create or write
    /// it ourselves (macOS asks "access data from other apps" for foreign group containers, and every write failed
    /// and logged "Widget snapshot not written" a few seconds after each edit).
    static var container: URL? {
        guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupIdentifier) else { return nil }
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue ? url : nil
    }

    private weak var model: AppModel?
    private var token: ObservationToken?
    private var pending: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var last: WidgetSnapshot?
    /// Set after the first failed write: no retry (and no new log line) after every edit until the next start.
    private var snapshotFailed = false

    func start(model: AppModel) {
        self.model = model
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        guard Self.container != nil else { return }
        drainShares()
        writeSnapshot()
        token = model.store.observe { [weak self] _ in
            Task { @MainActor in self?.scheduleSnapshot() }
        }
        #if os(macOS)
        let active = NSApplication.didBecomeActiveNotification
        #else
        let active = UIApplication.didBecomeActiveNotification
        #endif
        observers.append(NotificationCenter.default.addObserver(forName: active, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.drainShares() }
        })
    }

    func drainShares() {
        guard let model, let dir = Self.container?.appendingPathComponent("ShareInbox") else { return }
        let r = ShareInbox(directory: dir).drain(into: model.brain.brain)
        if !r.filed.isEmpty {
            model.showToast(r.filed.count == 1 ? "1 shared item saved to Captures" : "\(r.filed.count) shared items saved to Captures")
        }
        if r.rejected > 0 { Log.warning("Share inbox: \(r.rejected) unreadable item(s) parked as .bad", category: "capture") }
    }

    private func scheduleSnapshot() {
        pending?.cancel()
        pending = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            self?.writeSnapshot()
        }
    }

    func writeSnapshot() {
        guard !snapshotFailed, let model, let url = Self.container?.appendingPathComponent("widget.json") else { return }
        let s = WidgetSnapshot.make(brain: model.brain.brain)
        if let last, last.sameContent(as: s) { return }
        do {
            try s.encoded().write(to: url, options: .atomic)
            last = s
            #if canImport(WidgetKit)
            WidgetCenter.shared.reloadAllTimelines()
            #endif
        } catch {
            snapshotFailed = true
            Log.warning("Widget snapshot not written (no more tries until the next start): \(error)", category: "capture")
        }
    }
}
