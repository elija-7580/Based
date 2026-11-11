// Type-check stub of Apple's Combine (subset used by Based). Signatures only.
import Foundation

public protocol Publisher<Output, Failure> {
    associatedtype Output
    associatedtype Failure: Error
}
public protocol ConnectablePublisher: Publisher {}
public protocol ObservableObject: AnyObject {}
public struct AnyPublisher<Output, Failure: Error>: Publisher { public init() {} }
public final class AnyCancellable: Hashable {
    public init(_ cancel: @escaping () -> Void) {}
    public func cancel() {}
    public func store(in set: inout Set<AnyCancellable>) {}
    public static func == (a: AnyCancellable, b: AnyCancellable) -> Bool { a === b }
    public func hash(into h: inout Hasher) {}
}
@propertyWrapper public struct Published<Value> {
    public init(wrappedValue: Value) { self.wrappedValue = wrappedValue }
    public var wrappedValue: Value
}
public final class PassthroughSubject<Output, Failure: Error>: Publisher {
    public init() {}
    public func send(_ v: Output) {}
}
extension Publisher {
    public func autoconnect() -> AnyPublisher<Output, Failure> { fatalError() }
    public func sink(receiveValue: @escaping (Output) -> Void) -> AnyCancellable { fatalError() }
    public func receive<S>(on s: S) -> AnyPublisher<Output, Failure> { fatalError() }
    public func eraseToAnyPublisher() -> AnyPublisher<Output, Failure> { fatalError() }
}
extension Timer {
    public final class TimerPublisher: ConnectablePublisher {
        public typealias Output = Date
        public typealias Failure = Never
    }
    public static func publish(every: TimeInterval, tolerance: TimeInterval? = nil, on: RunLoop, in: RunLoop.Mode, options: Any? = nil) -> TimerPublisher { fatalError() }
}
extension NotificationCenter {
    public struct Publisher: Combine.Publisher {
        public typealias Output = Notification
        public typealias Failure = Never
    }
    public func publisher(for name: Notification.Name, object: AnyObject? = nil) -> Publisher { fatalError() }
}
