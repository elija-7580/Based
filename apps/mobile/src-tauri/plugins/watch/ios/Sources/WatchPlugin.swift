// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import Foundation
import Tauri
import UIKit
import WatchConnectivity
import WebKit

// BSD-66: the iPhone end of the Apple Watch app (apps/watch). A note arrives as a file with metadata
// (`WatchCaptureMeta` in apps/watch/Shared/WatchCaptureTransfer.swift: kind, v, id, at, dur, ext). It is copied into
// an inbox folder in the app's container and stays there until the web app has turned it into a page and calls
// `done` (apps/web/src/mobile/watchInbox.ts). Follows legacy/App/Shared/Capture/WatchReceiver.swift.

/// The inbox on disk: `<id>.<ext>` with the content and `<id>.json` with the metadata.
final class WatchInbox {
    static let kind = "based.watch.voice"
    static let supportedVersion = 1

    let directory: URL

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        directory = base.appendingPathComponent("watch-inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// Only ids and extensions that are safe as file names (the watch sends a UUID and "m4a" or "txt").
    static func safe(_ s: String, max: Int) -> Bool {
        !s.isEmpty && s.count <= max && s.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "-" }
    }

    /// Stores a received file. Returns false when the transfer isn't a note this app version understands.
    func store(file: URL, metadata: [String: Any]) -> Bool {
        guard metadata["kind"] as? String == Self.kind else { return false }
        let version = (metadata["v"] as? Int) ?? (metadata["v"] as? Double).map { Int($0) } ?? 1
        guard version <= Self.supportedVersion else { return false }
        guard let id = metadata["id"] as? String, Self.safe(id, max: 64) else { return false }
        guard let at = (metadata["at"] as? Double) ?? (metadata["at"] as? Int).map({ Double($0) }) else { return false }
        let dur = (metadata["dur"] as? Double) ?? (metadata["dur"] as? Int).map { Double($0) } ?? 0
        let ext = (metadata["ext"] as? String).flatMap { Self.safe($0, max: 8) ? $0 : nil } ?? "m4a"
        let content = directory.appendingPathComponent("\(id).\(ext)")
        do {
            try? FileManager.default.removeItem(at: content)
            try FileManager.default.copyItem(at: file, to: content)
            let meta: [String: Any] = ["id": id, "at": at, "dur": dur, "ext": ext]
            try JSONSerialization.data(withJSONObject: meta).write(to: directory.appendingPathComponent("\(id).json"), options: .atomic)
            return true
        } catch {
            NSLog("Based: watch note couldn't be stored: \(error)")
            return false
        }
    }

    func items() -> [[String: Any]] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }.compactMap { name in
            guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)),
                  let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = meta["id"] as? String, let ext = meta["ext"] as? String,
                  FileManager.default.fileExists(atPath: directory.appendingPathComponent("\(id).\(ext)").path)
            else { return nil }
            return meta
        }
    }

    func content(id: String) -> Data? {
        guard Self.safe(id, max: 64), let meta = items().first(where: { $0["id"] as? String == id }), let ext = meta["ext"] as? String
        else { return nil }
        return try? Data(contentsOf: directory.appendingPathComponent("\(id).\(ext)"))
    }

    func remove(id: String) {
        guard Self.safe(id, max: 64) else { return }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name.hasPrefix("\(id).") {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }
}

class ItemArgs: Decodable {
    let id: String
}

class WatchPlugin: Plugin, WCSessionDelegate {
    let inbox = WatchInbox()
    private weak var webview: WKWebView?

    /// As early as possible: WatchConnectivity starts the app in the background to deliver files, and delivers them
    /// as soon as the session is active.
    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    @objc public override func load(webview: WKWebView) {
        self.webview = webview
    }

    @objc public func pending(_ invoke: Invoke) throws {
        invoke.resolve(["items": inbox.items()])
    }

    @objc public func read(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ItemArgs.self)
        guard let data = inbox.content(id: args.id) else {
            invoke.reject("This note from the watch is no longer in the inbox.")
            return
        }
        invoke.resolve(["data": data.base64EncodedString()])
    }

    @objc public func done(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ItemArgs.self)
        inbox.remove(id: args.id)
        invoke.resolve()
    }

    // MARK: WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        // Copy synchronously: the system deletes the file once this method returns.
        guard inbox.store(file: file.fileURL, metadata: file.metadata ?? [:]) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webview?.evaluateJavaScript("window.dispatchEvent(new Event('based:watch-inbox'))", completionHandler: nil)
        }
    }
}

@_cdecl("init_plugin_based_watch")
func initPlugin() -> Plugin {
    let plugin = WatchPlugin()
    plugin.start()
    return plugin
}
