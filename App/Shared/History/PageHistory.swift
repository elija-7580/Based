import Foundation
import SwiftUI
import BasedCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Decides *when* pages get a version (the storage is `VersionHistory` in BasedCore, git-like and deduplicated):
///
/// * when a page is opened (so the state before your edits is always there to go back to),
/// * while you edit: at most every 10 minutes, and once you've paused for a minute,
/// * before a version is restored, and when the app quits or goes to the background.
///
/// Only pages edited locally are tracked (sync / import changes don't create versions). Old versions thin
/// out once a day (`VersionHistory.prune`), then unreferenced objects are swept.
@MainActor
final class PageHistory {
    let store: WorkspaceStore
    let history: VersionHistory?
    /// page → time of the last edit not yet in a version.
    private var dirty: [RecordID: Date] = [:]
    /// page → when its last version was taken (this session).
    private var lastVersion: [RecordID: Date] = [:]
    private var token: ObservationToken?
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []

    static let idleDelay: TimeInterval = 60
    static let maxInterval: TimeInterval = 10 * 60

    init(store: WorkspaceStore, directory: URL?) {
        self.store = store
        do {
            history = try VersionHistory(url: directory?.appendingPathComponent("history.sqlite"))
        } catch {
            Log.error("Version history unavailable: \(error)", category: "history")
            history = nil
        }
        guard history != nil else { return }
        token = store.observe { [weak self] change in
            guard change.origin == .local || change.origin == .undo || change.origin == .redo else { return }
            MainActor.assumeIsolated { self?.noteChange(change) }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        #if os(macOS)
        let quit = NSApplication.willTerminateNotification, background = NSApplication.didResignActiveNotification
        #else
        let quit = UIApplication.willTerminateNotification, background = UIApplication.didEnterBackgroundNotification
        #endif
        for name in [quit, background] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] n in
                MainActor.assumeIsolated { self?.flush(synchronously: n.name == quit) }
            })
        }
        // Thin out old versions once a day, in the background.
        let key = "history.lastPrune"
        let last = UserDefaults.standard.double(forKey: key)
        if Date().timeIntervalSince1970 - last > 86_400, let h = history {
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: key)
            DispatchQueue.global(qos: .background).asyncAfter(deadline: .now() + 30) {
                let removed = h.prune()
                let swept = h.collectGarbage()
                Log.info("Version history pruned: \(removed) versions, \(swept) objects", category: "history")
            }
        }
    }

    // MARK: Triggers

    /// A page became visible: make sure its current state is a version (no-op when unchanged).
    func pageOpened(_ page: RecordID) {
        guard history != nil, store.blocks[page]?.type == .page || store.blocks[page]?.isRow == true else { return }
        snapshot(page, reason: "opened")
    }

    private func noteChange(_ change: ChangeSet) {
        let now = Date()
        var pages = Set<RecordID>()
        for id in change.blockIDs {
            if let p = store.containingPage(of: id) { pages.insert(p) }
        }
        // Deleted blocks have no record left: their parent tells the page.
        for key in change.parents where key.hasPrefix("b:") {
            if let p = store.containingPage(of: String(key.dropFirst(2))) { pages.insert(p) }
        }
        for p in pages { dirty[p] = now }
    }

    private func tick() {
        let now = Date()
        for (page, edited) in dirty {
            let since = lastVersion[page] ?? .distantPast
            if now.timeIntervalSince(edited) >= Self.idleDelay || now.timeIntervalSince(since) >= Self.maxInterval {
                snapshot(page, reason: "edit")
            }
        }
    }

    /// Everything not yet in a version gets one (quit, background, before a restore).
    func flush(synchronously: Bool = false) {
        for page in Array(dirty.keys) { snapshot(page, reason: "edit", synchronously: synchronously) }
    }

    private func snapshot(_ page: RecordID, reason: String, synchronously: Bool = false) {
        guard let history else { return }
        dirty[page] = nil
        let blocks = store.versionBlocks(of: page)
        guard !blocks.isEmpty, blocks[0].trashedAt == nil else { return }
        lastVersion[page] = Date()
        let title = store.title(of: page)
        if synchronously {
            history.record(page: page, blocks: blocks, title: title, reason: reason)
        } else {
            history.recordAsync(page: page, blocks: blocks, title: title, reason: reason)
        }
    }

    // MARK: Reading / restoring

    func versions(of page: RecordID) -> [VersionHistory.Version] {
        if dirty[page] != nil { snapshot(page, reason: "edit", synchronously: true) }
        return history?.versions(of: page) ?? []
    }

    func blocks(of version: VersionHistory.Version) -> [Block] { history?.blocks(of: version) ?? [] }

    /// Restores a version as one undoable step; the state before is kept as a version too.
    func restore(_ version: VersionHistory.Version) {
        guard let history else { return }
        let page = version.pageID
        history.record(page: page, blocks: store.versionBlocks(of: page), title: store.title(of: page), reason: "before restore")
        let blocks = history.blocks(of: version)
        store.restoreVersion(of: page, blocks: blocks)
        dirty[page] = nil
        history.record(page: page, blocks: store.versionBlocks(of: page), title: store.title(of: page), reason: "restored")
        Log.info("Restored \(page.prefix(8)) to version from \(version.date)", category: "history")
    }

    var stats: VersionHistory.Stats? { history?.stats() }
}
