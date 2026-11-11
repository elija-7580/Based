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
/// `Logs/crash.txt` (async-signal-safe `write`). The marker also records whether a debugger was
/// attached (Xcode's Stop button kills the app — not a crash) and, while the main thread is frozen,
/// the hang's duration and stack (frozen → force quit shows *where* it was stuck).
enum CrashReporter {
    struct Info: Equatable {
        var started: Date?
        var breadcrumbs: [String]
        var crashText: String?
        /// The run was attached to a debugger (Xcode) — ending without clean shutdown is expected there.
        var underDebugger = false
        /// Set when the main thread was still blocked when the run ended.
        var hangSeconds: Double?
        var hangFrames: [String] = []

        var summary: String {
            if let c = crashText?.split(separator: "\n").first { return String(c) }
            if let h = hangSeconds {
                return "The app was frozen (main thread blocked for \(Int(h)) s or more) and was then force-quit or killed"
            }
            if underDebugger { return "Stopped from Xcode / the debugger (no clean shutdown — not a crash)" }
            return "No clean shutdown (force quit, hang or crash)"
        }

        /// Worth an alert at launch: crashes and freezes, not Xcode's Stop button.
        var isAlertWorthy: Bool { crashText != nil || hangSeconds != nil || !underDebugger }

        var report: DiagnosticReport.PreviousRun {
            .init(summary: summary, breadcrumbs: breadcrumbs, crashText: crashText, hangFrames: hangFrames,
                  logTail: Log.shared.previousSessionTail)
        }
    }

    /// What happened to the previous run (kept for reports even after the notice is dismissed).
    nonisolated(unsafe) static private(set) var previousCrash: Info?
    nonisolated(unsafe) static private var noticeDismissed = false
    nonisolated(unsafe) static private var markerURL: URL?
    nonisolated(unsafe) static private var timer: Timer?
    nonisolated(unsafe) static private var debuggerAttached = false
    private static let markerLock = NSLock()
    nonisolated(unsafe) static private var ongoingHang: (seconds: Double, frames: [String])?
    nonisolated(unsafe) static private var markerActive = true

    /// The launch notice to show (nil once dismissed or when the previous run was only stopped from Xcode).
    static var pendingNotice: Info? {
        guard !noticeDismissed, let c = previousCrash, c.isAlertWorthy else { return nil }
        return c
    }

    static func install(directory: URL) {
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let marker = directory.appendingPathComponent(".running.json")
        let crashFile = directory.appendingPathComponent("crash.txt")
        markerURL = marker
        debuggerAttached = DebuggerCheck.isAttached
        if let d = try? Data(contentsOf: marker), let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            let started = (obj["started"] as? Double).map { Date(timeIntervalSince1970: $0) }
            let crumbs = obj["breadcrumbs"] as? [String] ?? []
            var text: String?
            if let s = try? String(contentsOf: crashFile, encoding: .utf8), !s.isEmpty {
                text = s
                try? fm.moveItem(at: crashFile, to: directory.appendingPathComponent("crash-\(Int(Date().timeIntervalSince1970)).txt"))
            }
            var info = Info(started: started, breadcrumbs: crumbs, crashText: text)
            info.underDebugger = obj["debugger"] as? Bool ?? false
            if let hang = obj["hang"] as? [String: Any] {
                info.hangSeconds = hang["seconds"] as? Double
                info.hangFrames = hang["frames"] as? [String] ?? []
            }
            previousCrash = info
            var md = ["breadcrumbs": crumbs.suffix(15).joined(separator: " | ")]
            if !info.hangFrames.isEmpty { md["stack"] = info.hangFrames.prefix(12).joined(separator: " | ") }
            if info.isAlertWorthy {
                Log.error("Previous run ended unexpectedly: \(info.summary)", category: "crash", metadata: md)
            } else {
                Log.notice("Previous run: \(info.summary)", category: "crash", metadata: md)
            }
        }
        writeMarker()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in writeMarker() }
        #if os(macOS)
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in cleanShutdown() }
        #else
        NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: nil) { _ in cleanShutdown() }
        // iOS apps are usually killed in the background without willTerminate: suspended = clean.
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in cleanShutdown() }
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { _ in resumeMarker() }
        #endif
        installSignalHandlers(crashFile: crashFile)
    }

    /// Thread-safe (the hang watchdog calls it while the main thread is blocked).
    static func writeMarker() {
        markerLock.lock(); defer { markerLock.unlock() }
        guard markerActive, let url = markerURL else { return }
        var obj: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "started": Date().timeIntervalSince1970,
                                  "breadcrumbs": Array(Log.shared.breadcrumbs.suffix(30)), "debugger": debuggerAttached]
        if let h = ongoingHang { obj["hang"] = ["seconds": h.seconds, "frames": h.frames] as [String: Any] }
        if let d = try? JSONSerialization.data(withJSONObject: obj) { try? d.write(to: url, options: .atomic) }
    }

    /// The main thread has been blocked for `seconds` (watchdog thread): remembered in the marker.
    static func noteOngoingHang(seconds: Double, frames: [String]) {
        markerLock.lock(); ongoingHang = (seconds, frames); markerLock.unlock()
        writeMarker()
    }

    static func clearOngoingHang() {
        markerLock.lock(); let had = ongoingHang != nil; ongoingHang = nil; markerLock.unlock()
        if had { writeMarker() }
    }

    static func cleanShutdown() {
        Log.notice("Clean shutdown", category: "app")
        Log.shared.flush()
        markerLock.lock(); defer { markerLock.unlock() }
        markerActive = false
        if let url = markerURL { try? FileManager.default.removeItem(at: url) }
    }

    /// iOS: back in the foreground after a background "clean shutdown".
    static func resumeMarker() {
        markerLock.lock(); markerActive = true; markerLock.unlock()
        writeMarker()
    }

    /// Hides the launch notice; the info stays available for "Copy logs".
    static func dismissPreviousCrash() { noticeDismissed = true }

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
