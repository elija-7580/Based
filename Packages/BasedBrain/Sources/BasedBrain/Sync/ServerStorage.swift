import Foundation
import BasedCore

/// BSD-121: how based-server keeps its workspace. Like the app (BSD-42), commits only enqueue and a
/// `PersistenceWriter` saves them on a background queue; sync reads (`changes(after:)`, `lastChangeSeq`) wait for
/// the queue first. SIGTERM / SIGINT save what is still queued before the process exits.
public enum ServerStorage {
    /// Opens the server's workspace file behind a background writer.
    @MainActor
    public static func openStore(url: URL, node: String = "server") throws -> WorkspaceStore {
        WorkspaceStore(persistence: PersistenceWriter(try SQLitePersistence(url: url)), node: node)
    }

    /// Saves queued writes (at most `timeout` seconds). Returns false (and logs) if some changes are still unsaved.
    @MainActor @discardableResult
    public static func flush(_ store: WorkspaceStore, timeout: TimeInterval = 5, reason: String) -> Bool {
        let saved = store.flushSync(timeout: timeout)
        if saved {
            Log.info("Saved all changes (\(reason))", category: "store")
        } else {
            Log.error("\(store.unsavedChangeCount) changes not saved (\(reason))", category: "store")
        }
        return saved
    }

    /// Handles SIGTERM and SIGINT on the main queue: flush, then `exit(0)` (1 if changes stayed unsaved).
    /// Keep the returned sources alive for the life of the process.
    @MainActor
    public static func flushOnTermination(_ store: WorkspaceStore, timeout: TimeInterval = 5,
                                          exit: @escaping @MainActor (Int32) -> Void = { Foundation.exit($0) }) -> [DispatchSourceSignal] {
        [SIGTERM, SIGINT].map { sig in
            signal(sig, SIG_IGN)   // the dispatch source gets the signal instead of the default "terminate now"
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler {
                MainActor.assumeIsolated {
                    let ok = flush(store, timeout: timeout, reason: sig == SIGTERM ? "SIGTERM" : "SIGINT")
                    exit(ok ? 0 : 1)
                }
            }
            source.resume()
            return source
        }
    }
}
