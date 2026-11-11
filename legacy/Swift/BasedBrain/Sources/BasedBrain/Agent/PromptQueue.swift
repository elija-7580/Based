import Foundation

/// A FIFO async gate: one holder at a time, waiters get in strictly in arrival order (BSD-48).
/// Used so that a prompt sent while an agent turn is running waits for that turn instead of overtaking it.
public final class AsyncTurnGate: @unchecked Sendable {
    private let lock = NSLock()
    private var busy = false
    private var waiters: [CheckedContinuation<Bool, Never>] = []

    public init() {}

    /// Waits for the gate. Returns false when the wait was cancelled by `cancelWaiting()` (the caller must not proceed
    /// and must not call `leave()`).
    public func enter() async -> Bool {
        await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            lock.lock()
            if !busy { busy = true; lock.unlock(); c.resume(returning: true); return }
            waiters.append(c)
            lock.unlock()
        }
    }

    /// Hands the gate to the next waiter (or frees it).
    public func leave() {
        lock.lock()
        if waiters.isEmpty { busy = false; lock.unlock(); return }
        let next = waiters.removeFirst()
        lock.unlock()
        next.resume(returning: true)
    }

    /// Releases every waiter with `false` (session stopped).
    public func cancelWaiting() {
        lock.lock(); let all = waiters; waiters = []; lock.unlock()
        for w in all { w.resume(returning: false) }
    }

    public var isBusy: Bool { lock.lock(); defer { lock.unlock() }; return busy }
    public var waitingCount: Int { lock.lock(); defer { lock.unlock() }; return waiters.count }
}

/// Messages sent while a chat answer is still running wait here and are sent one after another, like in Claude Code
/// (BSD-48). The queue starts the next turn only after the previous one is completely saved, so answers never swap.
/// "Send now" moves a waiting message to the front and stops the running answer.
@MainActor
public final class ChatPromptQueue<Payload> {
    public struct Item: Identifiable {
        public let id: UUID
        /// What the chat shows for the waiting message.
        public var text: String
        public var payload: Payload
    }

    /// Waiting messages, oldest first.
    public private(set) var waiting: [Item] = []
    /// A turn started by this queue is running.
    public private(set) var isBusy = false
    /// Called after every change (waiting list or busy state).
    public var onChange: (@MainActor () -> Void)?

    private let start: @MainActor (Payload) -> ChatTurnHandle?
    private var current: ChatTurnHandle?
    private var generation = 0

    /// `start` begins a turn and returns its handle (nil = nothing to send; the queue moves on).
    public init(start: @escaping @MainActor (Payload) -> ChatTurnHandle?) { self.start = start }

    /// Sends now when idle, otherwise queues. Returns the id of the waiting item, or nil when it started at once.
    @discardableResult
    public func submit(_ text: String, _ payload: Payload) -> UUID? {
        let item = Item(id: UUID(), text: text, payload: payload)
        if isBusy {
            waiting.append(item)
            onChange?()
            return item.id
        }
        run(item)
        return nil
    }

    /// Takes a waiting message back.
    public func remove(_ id: UUID) {
        waiting.removeAll { $0.id == id }
        onChange?()
    }

    /// Sends a waiting message next and interrupts the running answer (it ends with "Stopped." and is saved).
    public func sendNow(_ id: UUID) {
        guard let i = waiting.firstIndex(where: { $0.id == id }) else { return }
        let item = waiting.remove(at: i)
        waiting.insert(item, at: 0)
        onChange?()
        if let current { current.cancel() } else if !isBusy { run(waiting.removeFirst()) }
    }

    /// Stops the running answer; waiting messages stay and follow.
    public func stopCurrent() { current?.cancel() }

    /// Drops all waiting messages.
    public func clear() {
        waiting = []
        onChange?()
    }

    /// Chat switched: waiting messages are dropped and the running answer goes on in the background (it is saved
    /// to its own chat), but no longer blocks the queue.
    public func detach() {
        waiting = []
        generation += 1
        current = nil
        isBusy = false
        onChange?()
    }

    private func run(_ item: Item) {
        guard let handle = start(item.payload) else {
            // Nothing to send: go on with the next one.
            if !waiting.isEmpty { run(waiting.removeFirst()) } else { isBusy = false; onChange?() }
            return
        }
        generation += 1
        let mine = generation
        current = handle
        isBusy = true
        onChange?()
        Task { @MainActor [weak self] in
            await handle.finished()
            self?.turnEnded(mine)
        }
    }

    private func turnEnded(_ gen: Int) {
        guard gen == generation else { return }
        current = nil
        if !waiting.isEmpty { run(waiting.removeFirst()) } else { isBusy = false; onChange?() }
    }
}
