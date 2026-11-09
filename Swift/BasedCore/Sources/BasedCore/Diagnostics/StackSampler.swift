import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// One symbolicated stack frame (hang reports).
public struct StackFrame: Sendable, Hashable, Codable {
    public var address: UInt
    /// Binary the frame belongs to ("Based.debug.dylib", "SwiftUI", "libsystem_kernel.dylib" …).
    public var image: String
    /// Demangled, shortened symbol name; nil when the binary is stripped.
    public var symbol: String?
    /// Offset from the symbol (or from the image start when there is no symbol).
    public var offset: UInt

    public init(address: UInt, image: String, symbol: String?, offset: UInt) {
        self.address = address; self.image = image; self.symbol = symbol; self.offset = offset
    }

    /// Code from the app itself (the Based executable / debug dylib, BasedCore, BasedBrain).
    public var isAppCode: Bool {
        if image.hasPrefix("Based") { return true }
        guard let symbol else { return false }
        return symbol.hasPrefix("Based") || symbol.contains(" in Based")
    }

    /// "Based.debug.dylib   WorkspaceStore.backlinks(to:) + 120"
    public var line: String {
        let img = image.count < 22 ? image.padding(toLength: 22, withPad: " ", startingAt: 0) : image
        if let symbol { return "\(img) \(symbol) + \(offset)" }
        return "\(img) 0x\(String(address, radix: 16)) (+0x\(String(offset, radix: 16)))"
    }
}

/// Symbol lookup + Swift demangling for sampled stacks.
@_silgen_name("swift_demangle")
private func _based_swift_demangle(_ mangledName: UnsafePointer<CChar>?, _ mangledNameLength: Int,
                                   _ outputBuffer: UnsafeMutablePointer<CChar>?, _ outputBufferSize: UnsafeMutablePointer<Int>?,
                                   _ flags: UInt32) -> UnsafeMutablePointer<CChar>?

public enum StackSymbols {
    /// Demangles Swift symbols ("$s9BasedCore…" / "_$s…"); other names are returned unchanged.
    public static func demangle(_ name: String) -> String {
        let n = name.hasPrefix("_$s") || name.hasPrefix("_$S") ? String(name.dropFirst()) : name
        guard n.hasPrefix("$s") || n.hasPrefix("$S") || n.hasPrefix("_T") else { return name }
        return n.withCString { p -> String in
            guard let d = _based_swift_demangle(p, strlen(p), nil, nil, 0) else { return name }
            defer { free(d) }
            return String(cString: d)
        }
    }

    /// Shorter, readable form: drops `Swift.` / `__C.` qualifiers and the outer return type.
    public static func simplify(_ demangled: String) -> String {
        var s = demangled
        for q in ["Swift.", "__C.", "SwiftUI.", "Foundation."] { s = s.replacingOccurrences(of: q, with: "") }
        // "closure #1 () -> () in Foo.bar(x: Int) -> Int": only the function after the last " in " loses its return type.
        let head: Substring, tail: Substring
        if let r = s.range(of: " in ", options: .backwards) { head = s[..<r.upperBound]; tail = s[r.upperBound...] } else { head = ""; tail = s[...] }
        var depth = 0, cut: String.Index?
        var i = tail.startIndex
        while i < tail.endIndex {
            let c = tail[i]
            if c == "(" || c == "[" || c == "<" { depth += 1 }
            else if c == ")" || c == "]" || c == ">" { if !(c == ">" && i > tail.startIndex && tail[tail.index(before: i)] == "-") { depth -= 1 } }
            else if depth == 0, c == " ", tail[i...].hasPrefix(" -> "), i > tail.startIndex, tail[tail.index(before: i)] == ")" { cut = i; break }
            i = tail.index(after: i)
        }
        s = String(head) + String(cut.map { tail[..<$0] } ?? tail)
        if s.count > 180 { s = String(s.prefix(179)) + "…" }
        return s
    }

    /// Resolves return addresses to frames (Apple platforms: `dladdr`; elsewhere: raw addresses).
    public static func symbolicate(_ addresses: [UInt]) -> [StackFrame] {
        var out: [StackFrame] = []
        out.reserveCapacity(addresses.count)
        for (i, a) in addresses.enumerated() {
            // Return addresses point after the call; look up the call instruction itself.
            let lookup = i == 0 ? a : a &- 1
            out.append(resolve(a, lookup: lookup))
        }
        return out
    }

    private static func resolve(_ a: UInt, lookup: UInt) -> StackFrame {
        #if canImport(Darwin)
        var info = Dl_info()
        if let p = UnsafeRawPointer(bitPattern: lookup), dladdr(p, &info) != 0 {
            let path = info.dli_fname.map { String(cString: $0) } ?? "?"
            let image = (path as NSString).lastPathComponent
            let fbase = UInt(bitPattern: info.dli_fbase)
            let saddr = UInt(bitPattern: info.dli_saddr)
            if let s = info.dli_sname, saddr != 0, saddr <= a {
                return StackFrame(address: a, image: image, symbol: simplify(demangle(String(cString: s))), offset: a - saddr)
            }
            return StackFrame(address: a, image: image, symbol: nil, offset: fbase <= a ? a - fbase : 0)
        }
        #endif
        return StackFrame(address: a, image: "?", symbol: nil, offset: 0)
    }

    /// Frames worth showing: skips the leading kernel / runtime waits so the first lines are meaningful.
    public static func trimmed(_ frames: [StackFrame], limit: Int = 40) -> [StackFrame] {
        Array(frames.prefix(limit))
    }

    /// The first frame from Based's own code — "where it hangs" in one line.
    public static func culprit(_ frames: [StackFrame]) -> StackFrame? { frames.first(where: \.isAppCode) }
}

/// Samples the main thread's call stack from another thread (used by the hang watchdog).
///
/// Apple platforms only: the sampler suspends the main thread, reads its registers, walks the
/// frame-pointer chain within the main thread's stack bounds into a preallocated buffer (no
/// allocation, logging or locking while the thread is suspended — it might hold the malloc lock),
/// resumes it, and only then copies the addresses out. Debugger-safe (no signals).
public enum MainThreadSampler {
    static let capacity = 128
    nonisolated(unsafe) private static let buffer = UnsafeMutablePointer<UInt>.allocate(capacity: 128)
    private static let lock = NSLock()
    #if canImport(Darwin)
    nonisolated(unsafe) private static var port: mach_port_t = 0
    nonisolated(unsafe) private static var stackLow: UInt = 0
    nonisolated(unsafe) private static var stackHigh: UInt = 0
    #endif

    /// Call once on the main thread (records its Mach port and stack bounds).
    public static func prepare() {
        guard Thread.isMainThread else { return }
        _ = buffer
        #if canImport(Darwin)
        let t = pthread_self()
        let high = UInt(bitPattern: pthread_get_stackaddr_np(t))
        let size = UInt(pthread_get_stacksize_np(t))
        lock.lock()
        port = pthread_mach_thread_np(t)
        stackHigh = high
        stackLow = high > size ? high - size : 0
        lock.unlock()
        #endif
    }

    public static var isAvailable: Bool {
        #if canImport(Darwin)
        lock.lock(); defer { lock.unlock() }
        return port != 0
        #else
        return false
        #endif
    }

    /// Return addresses of the main thread, innermost first (empty when unavailable). Never call on the main thread.
    public static func sample() -> [UInt] {
        guard !Thread.isMainThread else { return [] }
        lock.lock(); defer { lock.unlock() }
        #if canImport(Darwin)
        let n = walk(port, stackLow, stackHigh, buffer, capacity)
        guard n > 0 else { return [] }
        var out: [UInt] = []
        out.reserveCapacity(n)
        for i in 0..<n where out.last != buffer[i] { out.append(buffer[i]) }
        return out
        #else
        return []
        #endif
    }

    #if canImport(Darwin)
    /// Straight-line between suspend and resume: no allocation, no locks, no logging.
    private static func walk(_ target: mach_port_t, _ low: UInt, _ high: UInt, _ buf: UnsafeMutablePointer<UInt>, _ cap: Int) -> Int {
        guard target != 0, high > low else { return 0 }
        guard thread_suspend(target) == KERN_SUCCESS else { return 0 }
        var pc: UInt = 0, fp: UInt = 0, lr: UInt = 0
        #if arch(arm64)
        // Return addresses saved by arm64e system code carry pointer-authentication bits.
        let mask: UInt = 0x0000_000F_FFFF_FFFF
        var state = arm_thread_state64_t()
        var count = mach_msg_type_number_t(MemoryLayout<arm_thread_state64_t>.size / MemoryLayout<natural_t>.size)
        let words = Int(count)
        let kr = withUnsafeMutablePointer(to: &state) { p in
            p.withMemoryRebound(to: natural_t.self, capacity: words) { thread_get_state(target, thread_state_flavor_t(ARM_THREAD_STATE64), $0, &count) }
        }
        if kr == KERN_SUCCESS { pc = UInt(state.__pc) & mask; fp = UInt(state.__fp); lr = UInt(state.__lr) & mask }
        #elseif arch(x86_64)
        let mask: UInt = 0x0000_7FFF_FFFF_FFFF
        var state = x86_thread_state64_t()
        var count = mach_msg_type_number_t(MemoryLayout<x86_thread_state64_t>.size / MemoryLayout<natural_t>.size)
        let words = Int(count)
        let kr = withUnsafeMutablePointer(to: &state) { p in
            p.withMemoryRebound(to: natural_t.self, capacity: words) { thread_get_state(target, thread_state_flavor_t(x86_THREAD_STATE64), $0, &count) }
        }
        if kr == KERN_SUCCESS { pc = UInt(state.__rip); fp = UInt(state.__rbp) }
        #else
        let mask: UInt = ~0
        let kr = KERN_FAILURE
        #endif
        var n = 0
        if kr == KERN_SUCCESS {
            if pc != 0 { buf[n] = pc; n += 1 }
            if lr != 0, lr != pc { buf[n] = lr; n += 1 }
            // Frame record: [fp] = caller's fp, [fp + 8] = return address. Async frames set bit 60.
            while n < cap, fp >= low, fp &+ 16 <= high, fp & 0x7 == 0, let frame = UnsafePointer<UInt>(bitPattern: fp) {
                let next = frame[0] & 0x0FFF_FFFF_FFFF_FFFF
                let ret = frame[1] & mask
                if ret == 0 { break }
                buf[n] = ret; n += 1
                if next <= fp { break }
                fp = next
            }
        }
        _ = thread_resume(target)
        return n
    }
    #endif
}

/// Whether a debugger (Xcode / lldb) is attached — Xcode's Stop button kills the app without a clean
/// shutdown, which must not be reported as a crash.
public enum DebuggerCheck {
    public static var isAttached: Bool {
        #if canImport(Darwin)
        var info = kinfo_proc()
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        var size = MemoryLayout<kinfo_proc>.stride
        let r = sysctl(&mib, u_int(mib.count), &info, &size, nil, 0)
        return r == 0 && (info.kp_proc.p_flag & P_TRACED) != 0
        #else
        guard let s = try? String(contentsOfFile: "/proc/self/status", encoding: .utf8),
              let line = s.split(separator: "\n").first(where: { $0.hasPrefix("TracerPid:") }) else { return false }
        return line.dropFirst("TracerPid:".count).trimmingCharacters(in: .whitespaces) != "0"
        #endif
    }
}
