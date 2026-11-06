import Foundation
import BasedCore
#if canImport(MetricKit)
import MetricKit
#endif

/// Logging + crash/hang capture for the app. `bootstrap()` runs first thing in `AppModel.init`.
///
/// - Log file: `~/Library/Application Support/Based/Logs/based.log` (JSONL, rotated, 5 × 2 MB)
/// - Breadcrumbs: navigation, commands, agent actions (attached to hang / crash reports)
/// - Hang watchdog: main thread blocked > 0.5 s → warning with breadcrumbs
/// - Crash marker + signal / uncaught-exception handler → "Based quit unexpectedly" notice on next launch
/// - MetricKit diagnostics (hangs, crashes, CPU exceptions) saved next to the log
/// - Layout auditor (macOS): clipped / overlapping elements, run from Diagnostics or automatically
enum AppDiagnostics {
    nonisolated(unsafe) private static var started = false
    #if canImport(MetricKit)
    nonisolated(unsafe) private static var metrics: AnyObject?
    #endif

    static var supportDirectory: URL {
        let fm = FileManager.default
        let base = (try? fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)) ?? fm.temporaryDirectory
        return base.appendingPathComponent("Based", isDirectory: true)
    }

    static var logDirectory: URL { supportDirectory.appendingPathComponent("Logs", isDirectory: true) }

    /// True when the process runs inside the App Sandbox (agents can't use the user's shell, PATH or ~/.claude).
    static var isSandboxed: Bool { ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil }

    static var isUITesting: Bool { ProcessInfo.processInfo.arguments.contains("-ui-testing") }

    static func bootstrap() {
        guard !started else { return }
        started = true
        SandboxMigration.migrateIfNeeded()
        let log = Log.shared
        log.subsystem = Bundle.main.bundleIdentifier ?? "com.based.app"
        log.configure(directory: logDirectory, name: "based")
        #if DEBUG
        log.minimumLevel = LogLevel(name: UserDefaults.standard.string(forKey: "log.level") ?? "") ?? .debug
        #else
        log.minimumLevel = LogLevel(name: UserDefaults.standard.string(forKey: "log.level") ?? "") ?? .info
        #endif
        let info = Bundle.main.infoDictionary ?? [:]
        let version = "\(info["CFBundleShortVersionString"] as? String ?? "?") (\(info["CFBundleVersion"] as? String ?? "?"))"
        Log.notice("Based \(version) launched · \(ProcessInfo.processInfo.operatingSystemVersionString) · sandboxed: \(isSandboxed)", category: "app")
        CrashReporter.install(directory: logDirectory)
        HangWatchdog.shared.start()
        #if canImport(MetricKit) && !os(tvOS)
        if #available(macOS 12.0, iOS 14.0, *) {
            let s = MetricsSubscriber(directory: logDirectory)
            MXMetricManager.shared.add(s)
            metrics = s
        }
        #endif
    }

    static var versionString: String {
        let info = Bundle.main.infoDictionary ?? [:]
        return "\(info["CFBundleShortVersionString"] as? String ?? "?") (\(info["CFBundleVersion"] as? String ?? "?"))"
    }

    /// Header for exported logs: app/OS version, sandbox state, last crash, breadcrumbs.
    static func reportHeader() -> String {
        var s = "Based \(versionString) — \(ProcessInfo.processInfo.operatingSystemVersionString)\n"
        s += "Sandboxed: \(isSandboxed) · Exported \(Date().formatted(date: .abbreviated, time: .standard))\n"
        if let c = CrashReporter.previousCrash { s += "Previous run ended unexpectedly: \(c.summary)\n" }
        s += "Hangs this session: \(HangWatchdog.shared.hangCount)\n"
        s += "Breadcrumbs: " + Log.shared.breadcrumbs.suffix(30).joined(separator: " | ") + "\n"
        return s
    }
}

#if canImport(MetricKit) && !os(tvOS)
@available(macOS 12.0, iOS 14.0, *)
final class MetricsSubscriber: NSObject, MXMetricManagerSubscriber {
    let directory: URL
    init(directory: URL) { self.directory = directory }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for p in payloads {
            let hangs = p.hangDiagnostics?.count ?? 0
            let crashes = p.crashDiagnostics?.count ?? 0
            let cpu = p.cpuExceptionDiagnostics?.count ?? 0
            let disk = p.diskWriteExceptionDiagnostics?.count ?? 0
            let name = "MetricKit-\(Int(p.timeStampEnd.timeIntervalSince1970)).json"
            try? p.jsonRepresentation().write(to: directory.appendingPathComponent(name))
            Log.error("MetricKit diagnostics: \(crashes) crashes, \(hangs) hangs, \(cpu) CPU and \(disk) disk-write exceptions (saved \(name))", category: "metrickit")
        }
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        for p in payloads {
            Log.info("MetricKit metrics for \(p.timeStampBegin.formatted()) – \(p.timeStampEnd.formatted())", category: "metrickit")
        }
    }
}
#endif

/// Builds ≤ Pass 8 ran in the App Sandbox, so their data lives in
/// `~/Library/Containers/<bundle id>/Data/Library/Application Support/Based`. The non-sandboxed
/// "local agents" build copies it (and the container's preferences) once to the normal location.
enum SandboxMigration {
    static let markerName = ".migrated-from-sandbox"

    static func migrateIfNeeded() {
        #if os(macOS)
        guard !AppDiagnostics.isSandboxed, let bundleID = Bundle.main.bundleIdentifier else { return }
        let fm = FileManager.default
        let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        let container = home.appendingPathComponent("Library/Containers/\(bundleID)/Data", isDirectory: true)
        let old = container.appendingPathComponent("Library/Application Support/Based", isDirectory: true)
        let new = AppDiagnostics.supportDirectory
        let marker = new.appendingPathComponent(markerName)
        guard fm.fileExists(atPath: old.path), !fm.fileExists(atPath: marker.path) else { return }
        try? fm.createDirectory(at: new, withIntermediateDirectories: true)
        var copied = 0
        if !fm.fileExists(atPath: new.appendingPathComponent("based.sqlite").path) {
            for item in (try? fm.contentsOfDirectory(at: old, includingPropertiesForKeys: nil)) ?? [] {
                let dest = new.appendingPathComponent(item.lastPathComponent)
                guard !fm.fileExists(atPath: dest.path) else { continue }
                do { try fm.copyItem(at: item, to: dest); copied += 1 } catch { NSLog("Based migration: \(error)") }
            }
        }
        // Preferences (agents, AI settings, server URL …) — only keys that aren't set yet.
        let plist = container.appendingPathComponent("Library/Preferences/\(bundleID).plist")
        var prefs = 0
        if let dict = NSDictionary(contentsOf: plist) as? [String: Any] {
            for (k, v) in dict where UserDefaults.standard.object(forKey: k) == nil {
                UserDefaults.standard.set(v, forKey: k); prefs += 1
            }
        }
        try? "Copied \(copied) items and \(prefs) preferences from \(old.path) on \(Date())\n".write(to: marker, atomically: true, encoding: .utf8)
        // Logged after Log.configure via a deferred notice.
        DispatchQueue.main.async {
            Log.notice("Migrated data from the sandbox container: \(copied) items, \(prefs) preferences (old copy kept at \(old.path))", category: "app")
        }
        #endif
    }
}
