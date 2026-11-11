import Foundation
#if canImport(Sparkle) && os(macOS)
import Sparkle

/// Sparkle for the downloadable build (Info.plist BasedDistribution = release): reads the appcast of the latest
/// GitHub release, shows Sparkle's update window (release notes, Install), verifies the EdDSA signature,
/// replaces the app and relaunches. Reports what it finds back to `Updater` for Settings and the sidebar.
@MainActor
final class SparkleBridge: NSObject, SPUUpdaterDelegate {
    private var controller: SPUStandardUpdaterController!
    private let report: @MainActor (SparkleEvent) -> Void

    init(report: @escaping @MainActor (SparkleEvent) -> Void) {
        self.report = report
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    }

    private var updater: SPUUpdater { controller.updater }

    /// Sparkle's own window: "checking…", then the update with its notes, or "You're up to date".
    func checkWithUI() { controller.checkForUpdates(nil) }
    /// Quiet check: only fills in Settings / the sidebar badge.
    func checkSilently() { if !updater.sessionInProgress { updater.checkForUpdateInformation() } }

    var automaticallyChecks: Bool {
        get { updater.automaticallyChecksForUpdates }
        set { updater.automaticallyChecksForUpdates = newValue }
    }
    var automaticallyDownloads: Bool {
        get { updater.automaticallyDownloadsUpdates }
        set { updater.automaticallyDownloadsUpdates = newValue }
    }
    var lastCheck: Date? { updater.lastUpdateCheckDate }

    // MARK: SPUUpdaterDelegate (Sparkle calls these on the main thread)

    nonisolated func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        let version = item.displayVersionString
        MainActor.assumeIsolated { report(.found(version)) }
    }

    nonisolated func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        MainActor.assumeIsolated { report(.upToDate) }
    }

    nonisolated func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        let ns = error as NSError
        // "No update" is reported as an error too; only surface real failures.
        if ns.domain == SUSparkleErrorDomain && ns.code == Int(SUError.noUpdateError.rawValue) { return }
        let text = ns.localizedDescription
        MainActor.assumeIsolated { report(.failed(text)) }
    }
}

enum SparkleEvent { case found(String), upToDate, failed(String) }
#endif
