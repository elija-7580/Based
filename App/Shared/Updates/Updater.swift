import Foundation
import Observation
import BasedCore
#if canImport(Network)
import Network
#endif

/// Updates for Based on the Mac.
///
/// Every Release build made by `scripts/install-mac.sh` carries the commit it was built from
/// (Info.plist `BasedGitCommit`). Based asks GitHub which commits on `main` are newer (on launch, then every
/// 6 hours, and from Based → Check for Updates…) and lists them. "Update now" asks the updater agent — a small
/// launchd job that install-mac.sh sets up, listening on 127.0.0.1:47321 — to pull, rebuild and reinstall.
/// The app itself never runs git or Xcode, so this works with and without the App Sandbox.
@MainActor @Observable
final class Updater {
    struct Commit: Identifiable, Hashable {
        let id: String
        let title: String
        let date: Date?
        var short: String { String(id.prefix(7)) }
    }

    enum CheckState: Equatable {
        case idle, checking, upToDate, available
        /// GitHub doesn't know this build's commit (built from local, unpushed changes) or it's a dev build.
        case unknown(String)
        case failed(String)
    }

    /// Progress of an update, as reported by the agent.
    enum Phase: Equatable {
        case idle, fetching, building(String), installing(String), done(String), failed(String)
        var isRunning: Bool { switch self { case .fetching, .building, .installing: return true; default: return false } }
    }

    nonisolated static let agentPort: UInt16 = 47321
    static let checkInterval: TimeInterval = 6 * 3600

    let installedCommit: String
    let installedDate: Date?
    let repo: String
    let version: String
    let build: String

    private(set) var check: CheckState = .idle
    private(set) var newCommits: [Commit] = []
    private(set) var latestCommit: String?
    private(set) var lastChecked: Date?
    private(set) var phase: Phase = .idle
    /// nil until asked; false → install-mac.sh hasn't set up the agent yet.
    private(set) var agentAvailable: Bool?
    /// Set when this launch is the result of an update (shown once in Settings → Updates).
    private(set) var justUpdated = false

    var autoCheck: Bool = UserDefaults.standard.object(forKey: "updates.autoCheck") as? Bool ?? true {
        didSet { UserDefaults.standard.set(autoCheck, forKey: "updates.autoCheck"); scheduleChecks() }
    }

    var isSupported: Bool {
        #if os(macOS)
        return true
        #else
        return false
        #endif
    }
    var updateAvailable: Bool { check == .available && !newCommits.isEmpty }
    var isDevelopmentBuild: Bool { installedCommit.isEmpty }
    var shortCommit: String { installedCommit.isEmpty ? "dev" : String(installedCommit.prefix(7)) }
    var compareURL: URL? {
        installedCommit.isEmpty ? URL(string: "https://github.com/\(repo)/commits/main")
                                : URL(string: "https://github.com/\(repo)/compare/\(installedCommit)...main")
    }

    /// Called once when this launch is the result of an update.
    @ObservationIgnored var onJustUpdated: (() -> Void)?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var checkTask: Task<Void, Never>?
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    init(bundle: Bundle = .main) {
        func info(_ key: String) -> String {
            let v = (bundle.object(forInfoDictionaryKey: key) as? String ?? "").trimmingCharacters(in: .whitespaces)
            return v.hasPrefix("$(") ? "" : v
        }
        installedCommit = info("BasedGitCommit")
        installedDate = ISO8601DateFormatter().date(from: info("BasedGitDate"))
        let r = info("BasedUpdateRepo")
        repo = r.isEmpty ? "elija-7580/Based" : r
        version = info("CFBundleShortVersionString")
        build = info("CFBundleVersion")
    }

    /// Called once at launch.
    func start() {
        guard isSupported, !started else { return }
        started = true
        Task {
            await refreshStatus()
            if case .done = phase {
                justUpdated = true
                onJustUpdated?()
                _ = await Self.send("ack")
                phase = .idle
            } else if phase.isRunning {
                poll()
            }
        }
        scheduleChecks()
    }

    private func scheduleChecks() {
        checkTask?.cancel()
        guard autoCheck, isSupported else { return }
        checkTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)   // don't compete with launch work
            while !Task.isCancelled {
                await self?.checkNow()
                try? await Task.sleep(nanoseconds: UInt64(Self.checkInterval * 1_000_000_000))
            }
        }
    }

    // MARK: Checking GitHub

    func checkNow() async {
        guard check != .checking else { return }
        check = .checking
        defer { lastChecked = Date() }
        do {
            if installedCommit.isEmpty {
                let head = try await Self.fetch(HeadResponse.self, "repos/\(repo)/commits/main")
                latestCommit = head.sha
                newCommits = []
                check = .unknown("This is a development build (not made by install-mac.sh), so Based can't tell what's new.")
                return
            }
            let cmp = try await Self.fetch(CompareResponse.self, "repos/\(repo)/compare/\(installedCommit)...main")
            newCommits = cmp.commits.reversed().map { c in
                Commit(id: c.sha, title: c.commit.message.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? "",
                       date: c.commit.committer?.date.flatMap { ISO8601DateFormatter().date(from: $0) })
            }
            latestCommit = cmp.commits.last?.sha ?? installedCommit
            switch cmp.status {
            case "identical", "behind": check = .upToDate; newCommits = []
            case "ahead": check = cmp.ahead_by > 0 ? .available : .upToDate
            default: check = newCommits.isEmpty ? .upToDate : .available   // diverged: main still has new commits
            }
            Log.info("updates: \(check == .available ? "\(newCommits.count) new commits" : "up to date") (installed \(shortCommit))")
        } catch FetchError.status(404) {
            newCommits = []
            check = .unknown("This build's commit (\(shortCommit)) isn't on GitHub — it was built from local changes.")
        } catch FetchError.status(let code) where code == 403 || code == 429 {
            check = .failed("GitHub is rate-limiting update checks. Try again later.")
        } catch {
            check = .failed("Couldn't reach GitHub (\(error.localizedDescription)).")
            Log.warning("updates: check failed: \(error)")
        }
    }

    private enum FetchError: Error { case status(Int) }

    private struct CompareResponse: Decodable {
        let status: String
        let ahead_by: Int
        let commits: [C]
        struct C: Decodable {
            let sha: String
            let commit: Inner
            struct Inner: Decodable {
                let message: String
                let committer: Who?
                struct Who: Decodable { let date: String? }
            }
        }
    }
    private struct HeadResponse: Decodable { let sha: String }

    private static func fetch<T: Decodable>(_ type: T.Type, _ path: String) async throws -> T {
        var req = URLRequest(url: URL(string: "https://api.github.com/" + path)!)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Based-Updater", forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 { throw FetchError.status(http.statusCode) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: Installing (through the agent)

    /// Starts pulling, building and installing. Based quits and reopens on its own when the build is done.
    func install() async {
        guard !phase.isRunning else { return }
        Log.info("updates: install requested (installed \(shortCommit))")
        guard let reply = await Self.send("update") else {
            agentAvailable = false
            phase = .failed("The updater isn't set up on this Mac yet. Run scripts/install-mac.sh once in Terminal.")
            return
        }
        agentAvailable = true
        if reply.hasPrefix("started") || reply.hasPrefix("running") { phase = .fetching; poll() }
        else { phase = .failed("The updater answered “\(reply)”.") }
    }

    /// Runs the same update in a Terminal window (macOS can block background jobs from reading
    /// ~/Documents or ~/Desktop, where the repository may live).
    func installInTerminal() async {
        guard let reply = await Self.send("terminal") else { agentAvailable = false; return }
        if reply.hasPrefix("opened") || reply.hasPrefix("running") { phase = .fetching; poll() }
    }

    func refreshStatus() async {
        guard let reply = await Self.send("status") else { agentAvailable = false; return }
        agentAvailable = true
        phase = Self.parse(reply)
    }

    private func poll() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self else { return }
                await self.refreshStatus()
                if !self.phase.isRunning { return }
            }
        }
    }

    nonisolated static func parse(_ reply: String) -> Phase {
        let line = reply.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
        let parts = line.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let detail = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
        switch parts.first ?? "" {
        case "fetching": return .fetching
        case "building": return .building(detail)
        case "installing": return .installing(detail)
        case "done": return .done(detail)
        case "failed": return .failed(detail.isEmpty ? "The update failed. See ~/Library/Logs/Based/update.log." : detail)
        default: return .idle
        }
    }

    /// One request/response with the updater agent; nil when nothing listens (agent not installed).
    nonisolated static func send(_ command: String) async -> String? {
        #if canImport(Network) && os(macOS)
        final class Box: @unchecked Sendable {
            let lock = NSLock()
            var finished = false
            var buffer = Data()
        }
        let box = Box()
        return await withCheckedContinuation { (cont: CheckedContinuation<String?, Never>) in
            let conn = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: agentPort)!, using: .tcp)
            let queue = DispatchQueue(label: "based.updater.agent")
            @Sendable func finish(_ ok: Bool) {
                box.lock.lock()
                if box.finished { box.lock.unlock(); return }
                box.finished = true
                let text = String(decoding: box.buffer, as: UTF8.self)
                box.lock.unlock()
                conn.cancel()
                cont.resume(returning: ok ? text : nil)
            }
            @Sendable func receive() {
                conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, complete, error in
                    if let data { box.lock.lock(); box.buffer.append(data); box.lock.unlock() }
                    if complete { finish(true) } else if error != nil { finish(false) } else { receive() }
                }
            }
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    conn.send(content: Data((command + "\n").utf8), completion: .contentProcessed { _ in receive() })
                case .failed, .waiting, .cancelled: finish(false)   // .waiting = connection refused
                default: break
                }
            }
            conn.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 5) { finish(false) }
        }
        #else
        return nil
        #endif
    }
}
