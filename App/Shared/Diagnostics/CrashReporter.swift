import Foundation
import BasedCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Writes a "running" marker at launch and removes it on clean termination. A marker found at the
/// next launch means the previous run crashed, was force-quit or hung — the app shows a notice and
/// the Diagnostics view. Fatal signals and uncaught Objective-C exceptions are appended to
/// `Logs/crash.txt` (async-signal-safe `write`).
enum CrashReporter {
    struct Info: Equatable {
        var started: Date?
        var breadcrumbs: [String]
        var crashText: String?
        var summary: String {
            if let c = crashText?.split(separator: "\n").first { return String(c) }
            return "no clean shutdown (force quit, hang or crash)"
        }
    }

    nonisolated(unsafe) static private(set) var previousCrash: Info?
    nonisolated(unsafe) static private var markerURL: URL?
    nonisolated(unsafe) static private var timer: Timer?

    static func install(directory: URL) {
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let marker = directory.appendingPathComponent(".running.json")
        let crashFile = directory.appendingPathComponent("crash.txt")
        markerURL = marker
        if let d = try? Data(contentsOf: marker), let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            let started = (obj["started"] as? Double).map { Date(timeIntervalSince1970: $0) }
            let crumbs = obj["breadcrumbs"] as? [String] ?? []
            var text: String?
            if let s = try? String(contentsOf: crashFile, encoding: .utf8), !s.isEmpty {
                text = s
                try? fm.moveItem(at: crashFile, to: directory.appendingPathComponent("crash-\(Int(Date().timeIntervalSince1970)).txt"))
            }
            previousCrash = Info(started: started, breadcrumbs: crumbs, crashText: text)
            Log.error("Previous run ended unexpectedly: \(previousCrash!.summary)", category: "crash",
                      metadata: ["breadcrumbs": crumbs.suffix(15).joined(separator: " | ")])
        }
        writeMarker()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in writeMarker() }
        #if os(macOS)
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in cleanShutdown() }
        #else
        NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: nil) { _ in cleanShutdown() }
        // iOS apps are usually killed in the background without willTerminate: suspended = clean.
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in cleanShutdown() }
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { _ in writeMarker() }
        #endif
        installSignalHandlers(crashFile: crashFile)
    }

    static func writeMarker() {
        guard let url = markerURL else { return }
        let obj: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "started": Date().timeIntervalSince1970,
                                  "breadcrumbs": Array(Log.shared.breadcrumbs.suffix(30))]
        if let d = try? JSONSerialization.data(withJSONObject: obj) { try? d.write(to: url, options: .atomic) }
    }

    static func cleanShutdown() {
        Log.notice("Clean shutdown", category: "app")
        Log.shared.flush()
        if let url = markerURL { try? FileManager.default.removeItem(at: url) }
    }

    static func dismissPreviousCrash() { previousCrash = nil }

    private static func installSignalHandlers(crashFile: URL) {
        crashFD = open(crashFile.path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        NSSetUncaughtExceptionHandler { e in
            let text = "Uncaught exception \(e.name.rawValue): \(e.reason ?? "")\n" + e.callStackSymbols.prefix(40).joined(separator: "\n") + "\n"
            if crashFD >= 0 { _ = text.withCString { write(crashFD, $0, strlen($0)) } }
            Log.fault(text, category: "crash")
            Log.shared.flush()
        }
        let names: [(Int32, String)] = [(SIGSEGV, "SIGSEGV"), (SIGBUS, "SIGBUS"), (SIGILL, "SIGILL"), (SIGABRT, "SIGABRT"), (SIGFPE, "SIGFPE"), (SIGTRAP, "SIGTRAP")]
        for (sig, name) in names where sig < 64 {
            signalMessages[Int(sig)] = strdup("Fatal signal \(sig) (\(name)) at \(Date())\n")
            signal(sig, crashSignalHandler)
        }
    }
}

nonisolated(unsafe) private var crashFD: Int32 = -1
/// Pre-built messages per signal number (no allocation inside the handler).
nonisolated(unsafe) private let signalMessages: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?> = {
    let p = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: 64)
    p.initialize(repeating: nil, count: 64)
    return p
}()

/// Async-signal-safe: only `write`, `strlen`, `signal` and `raise`.
private func crashSignalHandler(_ sig: Int32) {
    if crashFD >= 0, sig >= 0, sig < 64, let m = signalMessages[Int(sig)] {
        _ = write(crashFD, m, strlen(m))
    }
    signal(sig, SIG_DFL)
    raise(sig)
}
