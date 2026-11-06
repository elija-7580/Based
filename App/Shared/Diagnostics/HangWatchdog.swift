import Foundation
import BasedCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Detects main-thread hangs: a background thread pings the main queue every 250 ms; when the
/// main thread answers late (> `threshold`), the hang is logged with its duration and the latest
/// breadcrumbs (what the user just did). Only counts while the app is active.
final class HangWatchdog: @unchecked Sendable {
    static let shared = HangWatchdog()

    struct Hang: Identifiable, Hashable {
        let id = UUID()
        let date: Date
        let seconds: Double
        let breadcrumbs: [String]
    }

    var threshold: Double = 0.5
    private let lock = NSLock()
    private var pingSentAt: UInt64 = 0
    private var waiting = false
    private var reportedOngoing = false
    private var thread: Thread?
    private var _hangs: [Hang] = []

    var hangs: [Hang] { lock.lock(); defer { lock.unlock() }; return _hangs }
    var hangCount: Int { hangs.count }

    func start() {
        guard thread == nil, !ProcessInfo.processInfo.arguments.contains("-no-watchdog") else { return }
        let t = Thread { [weak self] in self?.loop() }
        t.name = "based.hang-watchdog"
        t.qualityOfService = .utility
        t.start()
        thread = t
    }

    private func loop() {
        while true {
            Thread.sleep(forTimeInterval: 0.25)
            let now = DispatchTime.now().uptimeNanoseconds
            lock.lock()
            if !waiting {
                waiting = true
                pingSentAt = now
                lock.unlock()
                DispatchQueue.main.async { [weak self] in self?.pong() }
                continue
            }
            let waited = Double(now - pingSentAt) / 1e9
            let report = waited > 2 && !reportedOngoing
            if report { reportedOngoing = true }
            lock.unlock()
            if report {
                // Still blocked: log now (the app might never recover — e.g. deadlock).
                Log.error("Main thread blocked for > \(Int(waited)) s (ongoing)", category: "hang",
                          metadata: ["breadcrumbs": Log.shared.breadcrumbs.suffix(10).joined(separator: " | ")])
                Log.shared.flush()
            }
        }
    }

    /// Runs on the main thread.
    private func pong() {
        let now = DispatchTime.now().uptimeNanoseconds
        lock.lock()
        let seconds = Double(now - pingSentAt) / 1e9
        waiting = false
        reportedOngoing = false
        lock.unlock()
        guard seconds > threshold, Self.appIsActive else { return }
        let crumbs = Array(Log.shared.breadcrumbs.suffix(10))
        let hang = Hang(date: Date(), seconds: seconds, breadcrumbs: crumbs)
        lock.lock(); _hangs.append(hang); if _hangs.count > 200 { _hangs.removeFirst() }; lock.unlock()
        Log.warning("Hang: main thread blocked \(Int(seconds * 1000)) ms", category: "hang",
                    metadata: ["ms": String(Int(seconds * 1000)), "breadcrumbs": crumbs.joined(separator: " | ")])
    }

    private static var appIsActive: Bool {
        #if os(macOS)
        return NSApplication.shared.isActive
        #else
        return UIApplication.shared.applicationState == .active
        #endif
    }
}
