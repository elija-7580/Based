import Foundation
import BasedCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - Server-sent events (BSD-46)

/// One server-sent event: the `event:` name (if any) and its `data:` lines joined with "\n".
public struct SSEEvent: Sendable, Equatable {
    public var event: String?
    public var data: String
    public init(event: String? = nil, data: String) { self.event = event; self.data = data }
}

/// Incremental SSE parser. Works on bytes, so chunks may split anywhere — inside a line, a "\r\n" or a
/// multi-byte character. Comments (": ping") are skipped; an event ends at a blank line.
public struct SSEParser: Sendable {
    private var buffer = Data()
    private var event: String?
    private var data: [String] = []

    public init() {}

    public mutating func feed(_ chunk: Data) -> [SSEEvent] {
        buffer.append(chunk)
        var out: [SSEEvent] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            var line = buffer[buffer.startIndex..<nl]
            if line.last == 0x0D { line = line.dropLast() }
            buffer.removeSubrange(buffer.startIndex...nl)
            if let e = take(String(decoding: line, as: UTF8.self)) { out.append(e) }
        }
        return out
    }

    /// End of the stream: an unterminated last event still counts.
    public mutating func finish() -> [SSEEvent] {
        var out = feed(Data([0x0A]))
        if let e = take("") { out.append(e) }
        return out
    }

    private mutating func take(_ line: String) -> SSEEvent? {
        if line.isEmpty {
            defer { event = nil; data = [] }
            guard !data.isEmpty || event != nil else { return nil }
            return SSEEvent(event: event, data: data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil }
        let field: Substring, value: Substring
        if let c = line.firstIndex(of: ":") {
            field = line[..<c]
            var v = line[line.index(after: c)...]
            if v.first == " " { v = v.dropFirst() }
            value = v
        } else { field = Substring(line); value = "" }
        switch field {
        case "event": event = String(value)
        case "data": data.append(String(value))
        default: break
        }
        return nil
    }
}

// MARK: - Streaming HTTP

public struct HTTPStreamResponse: Sendable {
    public var status: Int
    /// Header names lower-cased.
    public var headers: [String: String]
    public var body: AsyncThrowingStream<Data, Error>
    public init(status: Int, headers: [String: String], body: AsyncThrowingStream<Data, Error>) {
        self.status = status; self.headers = headers; self.body = body
    }

    /// The whole body as text (error responses), at most `limit` bytes.
    public func text(limit: Int = 4000) async -> String {
        var d = Data()
        do { for try await c in body { d.append(c); if d.count >= limit { break } } } catch {}
        return String(decoding: d.prefix(limit), as: UTF8.self)
    }
}

/// Sends a request and hands back the body as it arrives. Injected in tests.
public protocol HTTPStreamTransport: Sendable {
    func send(_ request: URLRequest) async throws -> HTTPStreamResponse
}

/// URLSession with a data delegate (works on Apple platforms and with FoundationNetworking on Linux, which has
/// no `URLSession.bytes`). One session per request; cancelling the calling task cancels the request.
public struct URLSessionStreamTransport: HTTPStreamTransport {
    public var configuration: URLSessionConfiguration
    public init(configuration: URLSessionConfiguration = .default) { self.configuration = configuration }

    public func send(_ request: URLRequest) async throws -> HTTPStreamResponse {
        let delegate = StreamDelegate()
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: request)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<HTTPStreamResponse, Error>) in
                delegate.start(c, task: task, session: session)
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }
}

private final class StreamDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var head: CheckedContinuation<HTTPStreamResponse, Error>?
    private var body: AsyncThrowingStream<Data, Error>.Continuation?
    private var stream: AsyncThrowingStream<Data, Error>?

    func start(_ c: CheckedContinuation<HTTPStreamResponse, Error>, task: URLSessionDataTask, session: URLSession) {
        let (s, cont) = AsyncThrowingStream.makeStream(of: Data.self)
        cont.onTermination = { reason in
            if case .cancelled = reason { task.cancel() }
            session.finishTasksAndInvalidate()
        }
        lock.lock(); head = c; body = cont; stream = s; lock.unlock()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let http = response as? HTTPURLResponse
        var headers: [String: String] = [:]
        for (k, v) in http?.allHeaderFields ?? [:] { headers[String(describing: k).lowercased()] = String(describing: v) }
        lock.lock(); let c = head; head = nil; let s = stream; lock.unlock()
        if let c, let s { c.resume(returning: HTTPStreamResponse(status: http?.statusCode ?? 0, headers: headers, body: s)) }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock(); let b = body; lock.unlock()
        b?.yield(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let c = head; head = nil; let b = body; body = nil; lock.unlock()
        if let c { c.resume(throwing: error ?? URLError(.badServerResponse)) }
        if let error { b?.finish(throwing: error) } else { b?.finish() }
    }
}

// MARK: - Retry

/// Retries overloaded / rate-limited / flaky requests with exponential backoff and jitter (BSD-46).
/// Only before the first token: once output was shown, a retry would repeat it.
public struct RetryPolicy: Sendable {
    public var maxAttempts = 4
    public var baseDelay: TimeInterval = 1
    public var maxDelay: TimeInterval = 20
    public var statuses: Set<Int> = [429, 500, 502, 503, 529]
    public var sleep: @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64(max(0, $0) * 1_000_000_000)) }
    public var jitter: @Sendable () -> Double = { Double.random(in: 0...0.3) }

    public init() {}
    public static let standard = RetryPolicy()

    /// Delay before attempt `attempt + 1` (attempt counts from 1). `retry-after` wins when the server sends it.
    public func delay(after attempt: Int, retryAfter: TimeInterval?) -> TimeInterval {
        if let r = retryAfter, r >= 0 { return min(r, 60) }
        return min(maxDelay, baseDelay * pow(2, Double(attempt - 1))) * (1 + jitter())
    }

    public func run<T>(_ operation: () async throws -> T) async throws -> T {
        var attempt = 0
        while true {
            attempt += 1
            do { return try await operation() }
            catch let e as AfterOutput { throw e.error }
            catch {
                guard attempt < maxAttempts, !Task.isCancelled, let wait = retryDelay(error, attempt) else {
                    if let h = error as? HTTPFailure { throw AIError.http(h.status, h.body) }
                    throw error
                }
                Log.info("API request failed (\(error)); retry \(attempt + 1)/\(maxAttempts) in \(String(format: "%.1f", wait)) s", category: "ai")
                try await sleep(wait)
            }
        }
    }

    private func retryDelay(_ error: Error, _ attempt: Int) -> TimeInterval? {
        if let h = error as? HTTPFailure { return statuses.contains(h.status) ? delay(after: attempt, retryAfter: h.retryAfter) : nil }
        if error is URLError { return (error as! URLError).code == .cancelled ? nil : delay(after: attempt, retryAfter: nil) }
        if case AIError.http(let code, _) = error { return statuses.contains(code) ? delay(after: attempt, retryAfter: nil) : nil }
        return nil
    }
}

/// A failed HTTP response with what the retry needs.
struct HTTPFailure: Error, CustomStringConvertible {
    var status: Int
    var body: String
    var retryAfter: TimeInterval?
    var description: String { "HTTP \(status): \(body.prefix(400))" }

    static func from(_ r: HTTPStreamResponse) async -> HTTPFailure {
        var after: TimeInterval?
        if let ms = r.headers["retry-after-ms"].flatMap(Double.init) { after = ms / 1000 }
        else if let s = r.headers["retry-after"].flatMap(Double.init) { after = s }
        return HTTPFailure(status: r.status, body: await r.text(), retryAfter: after)
    }
}

/// An error after output was already streamed: not retried.
struct AfterOutput: Error { var error: Error }

extension HTTP {
    static func streamRequest(_ url: URL, headers: [String: String], body: JSONValue) throws -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = try body.encoded()
        req.timeoutInterval = 300
        return req
    }

    /// Streams `request`, feeding SSE events to `handle` (which returns whether it showed output). Retries per
    /// `policy` until the first output; HTTP errors become `AIError.http`.
    static func streamSSE<T>(_ request: URLRequest, transport: HTTPStreamTransport, policy: RetryPolicy,
                             makeState: () -> T, handle: (inout T, SSEEvent) throws -> Bool) async throws -> T {
        try await policy.run {
            let r = try await transport.send(request)
            guard (200..<300).contains(r.status) else { throw await HTTPFailure.from(r) }
            var state = makeState()
            var parser = SSEParser()
            var shown = false
            do {
                for try await chunk in r.body {
                    for e in parser.feed(chunk) { if try handle(&state, e) { shown = true } }
                }
                for e in parser.finish() { if try handle(&state, e) { shown = true } }
            } catch {
                if shown { throw AfterOutput(error: error) }
                throw error
            }
            return state
        }
    }
}
