import Foundation
import BasedCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Detects main-thread hangs: a background thread pings the main queue every 250 ms; when the
/// main thread answers late (> `threshold`), the hang is logged with its duration, the latest
/// breadcrumbs (what the user just did) and — new in Pass 13 — the main thread's call stack,
/// sampled while it was still blocked (`MainThreadSampler`), so a report says *where* it hangs.
/// A hang that is still going on after 2 s is written to the log and the crash marker right away:
/// if the app is force-quit while frozen, the next launch can show where it was stuck.
final class HangWatchdog: @unchecked Sendable {
    static let shared = HangWatchdog()

    struct Hang: Identifiable, Hashable {
        let id = UUID()
        let date: Date
        let seconds: Double
        let breadcrumbs: [String]
        /// First stack sample taken while blocked (innermost first); empty when sampling is unavailable.
        var frames: [StackFrame] = []
        var samples = 0

        var report: DiagnosticReport.Hang {
            .init(date: date, milliseconds: Int(seconds * 1000), breadcrumbs: breadcrumbs, frames: frames, samples: samples)
        }
    }

    var threshold: Double = 0.5
    /// First stack sample this long into a block (below `threshold`, so reportable hangs have one).
    var sampleAfter: Double = 0.3
    private let lock = NSLock()
    private var pingSentAt: UInt64 = 0
    private var pingID = 0
    private var waiting = false
    private var reportedOngoing = false
    private var stacks: [[StackFrame]] = []
    private var thread: Thread?
    private var _hangs: [Hang] = []

    var hangs: [Hang] { lock.lock(); defer { lock.unlock() }; return _hangs }
    var hangCount: Int { hangs.count }
    var samplingAvailable: Bool { MainThreadSampler.isAvailable }

    /// Call on the main thread.
    func start() {
        guard thread == nil, !ProcessInfo.processInfo.arguments.contains("-no-watchdog") else { return }
        MainThreadSampler.prepare()
        let t = Thread { [weak self] in self?.loop() }
        t.name = "based.hang-watchdog"
        t.qualityOfService = .utility
        t.start()
        thread = t
    }

    private func loop() {
        var idleTicks = 0
        while true {
            Thread.sleep(forTimeInterval: 0.05)
            let now = DispatchTime.now().uptimeNanoseconds
            lock.lock()
            if !waiting {
                idleTicks += 1
                guard idleTicks >= 5 else { lock.unlock(); continue }   // ping every ~250 ms
                idleTicks = 0
                waiting = true
                pingSentAt = now
                pingID += 1
                stacks = []
                let id = pingID
                lock.unlock()
                DispatchQueue.main.async { [weak self] in self?.pong(id) }
                continue
            }
            let id = pingID
            let waited = Double(now - pingSentAt) / 1e9
            // Samples at 0.3 s, then every second while still blocked (at most 5).
            let due = stacks.count < 5 && waited >= sampleAfter + Double(stacks.count)
            let report = waited > 2 && !reportedOngoing
            let ongoing = reportedOngoing
            if report { reportedOngoing = true }
            lock.unlock()
            if due {
                let frames = StackSymbols.symbolicate(MainThreadSampler.sample())
                lock.lock()
                if waiting && pingID == id { stacks.append(frames) }
                lock.unlock()
            }
            if report {
                // Still blocked: log now (the app might never recover — e.g. deadlock or force quit).
                lock.lock(); let frames = stacks.first ?? []; lock.unlock()
                let lines = StackSymbols.trimmed(frames, limit: 30).map(\.line)
                var msg = "Main thread blocked for > \(Int(waited)) s (ongoing)"
                if let c = StackSymbols.culprit(frames) { msg += " in \(c.symbol ?? c.line)" }
                if !lines.isEmpty { msg += "\n" + lines.joined(separator: "\n") }
                Log.error(msg, category: "hang", metadata: ["breadcrumbs": Log.shared.breadcrumbs.suffix(10).joined(separator: " | ")])
                Log.shared.flush()
                CrashReporter.noteOngoingHang(seconds: waited, frames: lines)
            } else if ongoing, due {
                lock.lock(); let frames = stacks.first ?? []; lock.unlock()
                CrashReporter.noteOngoingHang(seconds: waited, frames: StackSymbols.trimmed(frames, limit: 30).map(\.line))
            }
        }
    }

    /// Runs on the main thread.
    private func pong(_ id: Int) {
        let now = DispatchTime.now().uptimeNanoseconds
        lock.lock()
        guard id == pingID else { lock.unlock(); return }
        let seconds = Double(now - pingSentAt) / 1e9
        let wasOngoing = reportedOngoing
        let sampled = stacks
        waiting = false
        reportedOngoing = false
        stacks = []
        lock.unlock()
        if wasOngoing { CrashReporter.clearOngoingHang() }
        guard seconds > threshold, Self.appIsActive else { return }
        let crumbs = Array(Log.shared.breadcrumbs.suffix(10))
        var hang = Hang(date: Date(), seconds: seconds, breadcrumbs: crumbs)
        hang.frames = sampled.first ?? []
        hang.samples = sampled.count
        lock.lock(); _hangs.append(hang); if _hangs.count > 200 { _hangs.removeFirst() }; lock.unlock()
        var md = ["ms": String(Int(seconds * 1000)), "breadcrumbs": crumbs.joined(separator: " | ")]
        if let c = StackSymbols.culprit(hang.frames) { md["in"] = c.symbol ?? c.line }
        if !hang.frames.isEmpty { md["stack"] = StackSymbols.trimmed(hang.frames, limit: 12).map(\.line).joined(separator: " | ") }
        Log.warning("Hang: main thread blocked \(Int(seconds * 1000)) ms", category: "hang", metadata: md)
    }

    private static var appIsActive: Bool {
        #if os(macOS)
        return NSApplication.shared.isActive
        #else
        return UIApplication.shared.applicationState == .active
        #endif
    }
}
