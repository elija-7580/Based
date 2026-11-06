import Foundation

/// Tiny lock wrapper whose `sync` is not flagged by the "unavailable from async contexts" diagnostic.
/// Critical sections are always short and non-suspending.
public final class Locked<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()
    public init(_ value: Value) { self.value = value }
    @discardableResult
    public func sync<T>(_ body: (inout Value) throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body(&value)
    }
    public var current: Value { sync { $0 } }
}
