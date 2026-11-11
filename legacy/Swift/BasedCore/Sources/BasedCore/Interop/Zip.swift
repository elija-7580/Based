import Foundation
#if canImport(Compression)
import Compression
#endif

public enum ZipError: Error, LocalizedError, Equatable {
    case notAZip
    case corrupt(String)
    case unsupported(String)
    case checksum(String)

    public var errorDescription: String? {
        switch self {
        case .notAZip: return "The file is not a ZIP archive."
        case .corrupt(let s): return "The ZIP archive is damaged (\(s))."
        case .unsupported(let s): return "Unsupported ZIP feature: \(s)."
        case .checksum(let s): return "Checksum mismatch in \(s)."
        }
    }
}

/// Read-only ZIP archive (PKZIP 2.0 + ZIP64), entries stored or deflated.
/// Pure Swift so it works on iOS, macOS and Linux (server, tests); on Apple platforms the
/// Compression framework inflates, elsewhere the built-in `Inflate`.
public final class ZipArchive {
    public struct Entry: Sendable, Hashable {
        public var path: String
        public var method: UInt16
        public var flags: UInt16
        public var crc32: UInt32
        public var compressedSize: UInt64
        public var uncompressedSize: UInt64
        public var localHeaderOffset: UInt64
        public var isDirectory: Bool { path.hasSuffix("/") }
        public var isEncrypted: Bool { flags & 1 != 0 }
    }

    public let url: URL
    public private(set) var entries: [Entry] = []
    private let handle: FileHandle
    private let fileSize: UInt64

    public init(url: URL) throws {
        self.url = url
        guard let h = try? FileHandle(forReadingFrom: url) else { throw ZipError.notAZip }
        handle = h
        fileSize = (try? h.seekToEnd()) ?? 0
        guard fileSize >= 22 else { throw ZipError.notAZip }
        try readCentralDirectory()
    }

    deinit { try? handle.close() }

    /// Quick check of the local-file-header magic ("PK\u{3}\u{4}") or an empty archive.
    public static func isZip(_ url: URL) -> Bool {
        guard let h = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? h.close() }
        guard let d = try? h.read(upToCount: 4), d.count == 4 else { return false }
        return d[d.startIndex] == 0x50 && d[d.startIndex + 1] == 0x4B && (d[d.startIndex + 2] == 3 || d[d.startIndex + 2] == 5)
    }

    // MARK: Reading

    private func read(at offset: UInt64, count: Int) throws -> [UInt8] {
        guard count >= 0, offset <= fileSize, UInt64(count) <= fileSize - offset else { throw ZipError.corrupt("read past end") }
        try handle.seek(toOffset: offset)
        var out: [UInt8] = []
        out.reserveCapacity(count)
        var remaining = count
        while remaining > 0 {
            guard let d = try handle.read(upToCount: min(remaining, 8 << 20)), !d.isEmpty else { throw ZipError.corrupt("short read") }
            out.append(contentsOf: d)
            remaining -= d.count
        }
        return out
    }

    private func readCentralDirectory() throws {
        // End of central directory: last 22 bytes + up to 64 KiB comment.
        let tailLen = Int(min(fileSize, 22 + 65_535 + 20))
        let tailStart = fileSize - UInt64(tailLen)
        let tail = try read(at: tailStart, count: tailLen)
        var eocd = -1
        var i = tail.count - 22
        while i >= 0 {
            if tail[i] == 0x50, tail[i + 1] == 0x4B, tail[i + 2] == 5, tail[i + 3] == 6 { eocd = i; break }
            i -= 1
        }
        guard eocd >= 0 else { throw ZipError.notAZip }
        var r = ByteReader(tail, at: eocd + 4)
        _ = r.u16(); _ = r.u16()
        _ = r.u16()
        var total = UInt64(r.u16())
        var cdSize = UInt64(r.u32())
        var cdOffset = UInt64(r.u32())
        if total == 0xFFFF || cdSize == 0xFFFF_FFFF || cdOffset == 0xFFFF_FFFF {
            // ZIP64 locator sits right before the EOCD record.
            let loc = eocd - 20
            guard loc >= 0, tail[loc] == 0x50, tail[loc + 1] == 0x4B, tail[loc + 2] == 6, tail[loc + 3] == 7 else {
                throw ZipError.corrupt("missing ZIP64 locator")
            }
            var lr = ByteReader(tail, at: loc + 8)
            let eocd64Offset = lr.u64()
            let rec = try read(at: eocd64Offset, count: 56)
            guard rec[0] == 0x50, rec[1] == 0x4B, rec[2] == 6, rec[3] == 6 else { throw ZipError.corrupt("bad ZIP64 record") }
            var zr = ByteReader(rec, at: 24)
            _ = zr.u64()
            total = zr.u64()
            cdSize = zr.u64()
            cdOffset = zr.u64()
        }
        guard cdOffset <= fileSize, cdSize <= fileSize - cdOffset, cdSize < 1 << 31 else { throw ZipError.corrupt("central directory out of range") }
        let cd = try read(at: cdOffset, count: Int(cdSize))
        var p = ByteReader(cd, at: 0)
        var out: [Entry] = []
        out.reserveCapacity(Int(min(total, 1_000_000)))
        while p.remaining >= 46 {
            guard p.u32() == 0x0201_4B50 else { break }
            _ = p.u16(); _ = p.u16()
            let flags = p.u16()
            let method = p.u16()
            _ = p.u16(); _ = p.u16()
            let crc = p.u32()
            var csize = UInt64(p.u32())
            var usize = UInt64(p.u32())
            let nameLen = Int(p.u16()), extraLen = Int(p.u16()), commentLen = Int(p.u16())
            _ = p.u16(); _ = p.u16(); _ = p.u32()
            var offset = UInt64(p.u32())
            guard p.remaining >= nameLen + extraLen + commentLen else { throw ZipError.corrupt("truncated entry") }
            let nameBytes = p.bytes(nameLen)
            let extra = p.bytes(extraLen)
            p.skip(commentLen)
            var name = Self.decodeName(nameBytes, utf8: flags & 0x800 != 0)
            // Extra fields: ZIP64 sizes (0x0001), Info-ZIP Unicode path (0x7075).
            var e = ByteReader(extra, at: 0)
            while e.remaining >= 4 {
                let id = e.u16(), len = Int(e.u16())
                guard e.remaining >= len else { break }
                let body = e.bytes(len)
                var b = ByteReader(body, at: 0)
                if id == 0x0001 {
                    if usize == 0xFFFF_FFFF, b.remaining >= 8 { usize = b.u64() }
                    if csize == 0xFFFF_FFFF, b.remaining >= 8 { csize = b.u64() }
                    if offset == 0xFFFF_FFFF, b.remaining >= 8 { offset = b.u64() }
                } else if id == 0x7075, body.count > 5, let s = String(bytes: body[5...], encoding: .utf8) {
                    name = s
                }
            }
            out.append(Entry(path: name.replacingOccurrences(of: "\\", with: "/"), method: method, flags: flags, crc32: crc,
                             compressedSize: csize, uncompressedSize: usize, localHeaderOffset: offset))
        }
        entries = out
    }

    static func decodeName(_ bytes: [UInt8], utf8: Bool) -> String {
        if let s = String(bytes: bytes, encoding: .utf8) { return s }
        // CP437 fallback for the printable ASCII range, Latin-1 for the rest (close enough for file names).
        return String(bytes.map { Character(Unicode.Scalar($0)) })
    }

    /// The decompressed bytes of one entry (CRC-checked).
    public func data(for entry: Entry) throws -> Data {
        guard !entry.isEncrypted else { throw ZipError.unsupported("encrypted entry \(entry.path)") }
        let head = try read(at: entry.localHeaderOffset, count: 30)
        guard head[0] == 0x50, head[1] == 0x4B, head[2] == 3, head[3] == 4 else { throw ZipError.corrupt("bad local header for \(entry.path)") }
        var r = ByteReader(head, at: 26)
        let nameLen = UInt64(r.u16()), extraLen = UInt64(r.u16())
        let start = entry.localHeaderOffset + 30 + nameLen + extraLen
        guard entry.compressedSize < (UInt64(1) << 34) else { throw ZipError.unsupported("entry larger than 16 GB") }
        let raw = try read(at: start, count: Int(entry.compressedSize))
        let bytes: [UInt8]
        switch entry.method {
        case 0: bytes = raw
        case 8: bytes = try Self.inflate(raw, expectedSize: Int(entry.uncompressedSize))
        default: throw ZipError.unsupported("compression method \(entry.method) (\(entry.path))")
        }
        guard UInt64(bytes.count) == entry.uncompressedSize else { throw ZipError.corrupt("size mismatch in \(entry.path)") }
        guard CRC32.checksum(bytes) == entry.crc32 else { throw ZipError.checksum(entry.path) }
        return Data(bytes)
    }

    static func inflate(_ raw: [UInt8], expectedSize: Int) throws -> [UInt8] {
        #if canImport(Compression)
        if let out = appleInflate(raw, expectedSize: expectedSize) { return out }
        #endif
        return try Inflate.decompress(raw, expectedSize: expectedSize)
    }

    #if canImport(Compression)
    /// Raw DEFLATE through the Compression framework (`COMPRESSION_ZLIB` is headerless deflate).
    static func appleInflate(_ raw: [UInt8], expectedSize: Int) -> [UInt8]? {
        if expectedSize == 0 { return [] }
        var out = [UInt8](repeating: 0, count: expectedSize)
        let written = out.withUnsafeMutableBufferPointer { dst -> Int in
            raw.withUnsafeBufferPointer { src -> Int in
                guard let d = dst.baseAddress, let s = src.baseAddress else { return 0 }
                return compression_decode_buffer(d, expectedSize, s, raw.count, nil, COMPRESSION_ZLIB)
            }
        }
        return written == expectedSize ? out : nil
    }
    #endif

    /// Safe relative path for extraction (no absolute paths, no "..", no empty components).
    public static func sanitized(_ path: String) -> String? {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
            .filter { $0 != "." }
        guard !parts.isEmpty, !parts.contains("..") else { return nil }
        return parts.joined(separator: "/")
    }

    /// Extracts every entry below `directory`. Nested `.zip` files (Notion's "Export-…-Part-1.zip")
    /// are expanded in place into a folder of the same name. Returns the number of files written.
    @discardableResult
    public func extractAll(to directory: URL, expandNested: Bool = true, depth: Int = 0,
                           progress: ((Double) -> Void)? = nil) throws -> Int {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let totalBytes = max(1, entries.reduce(UInt64(0)) { $0 + $1.uncompressedSize })
        var doneBytes: UInt64 = 0
        var count = 0
        for entry in entries {
            guard let rel = Self.sanitized(entry.path) else { continue }
            if rel.hasPrefix("__MACOSX/") || rel.hasSuffix(".DS_Store") { continue }
            let dest = directory.appendingPathComponent(rel, isDirectory: entry.isDirectory)
            if entry.isDirectory {
                try fm.createDirectory(at: dest, withIntermediateDirectories: true)
                continue
            }
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try self.data(for: entry)
            try data.write(to: dest)
            count += 1
            doneBytes += entry.uncompressedSize
            progress?(Double(doneBytes) / Double(totalBytes))
            if expandNested, depth < 3, dest.pathExtension.lowercased() == "zip", Self.isZip(dest) {
                let folder = dest.deletingPathExtension()
                let inner = try ZipArchive(url: dest)
                count += try inner.extractAll(to: folder, expandNested: true, depth: depth + 1)
                try? fm.removeItem(at: dest)
            }
        }
        return count
    }
}

/// Little-endian cursor over a byte array.
struct ByteReader {
    let bytes: [UInt8]
    var pos: Int
    init(_ bytes: [UInt8], at pos: Int) { self.bytes = bytes; self.pos = pos }
    var remaining: Int { bytes.count - pos }
    mutating func u8() -> UInt8 { guard pos < bytes.count else { return 0 }; defer { pos += 1 }; return bytes[pos] }
    mutating func u16() -> UInt16 { UInt16(u8()) | UInt16(u8()) << 8 }
    mutating func u32() -> UInt32 { UInt32(u16()) | UInt32(u16()) << 16 }
    mutating func u64() -> UInt64 { UInt64(u32()) | UInt64(u32()) << 32 }
    mutating func bytes(_ n: Int) -> [UInt8] {
        let end = min(bytes.count, pos + max(0, n))
        defer { pos = end }
        return Array(bytes[pos..<end])
    }
    mutating func skip(_ n: Int) { pos = min(bytes.count, pos + max(0, n)) }
}

public enum CRC32 {
    static let table: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    public static func checksum(_ bytes: [UInt8]) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        bytes.withUnsafeBufferPointer { buf in
            table.withUnsafeBufferPointer { t in
                for b in buf { c = t[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
            }
        }
        return c ^ 0xFFFF_FFFF
    }
}

/// Raw DEFLATE decoder (RFC 1951): stored, fixed and dynamic Huffman blocks, table-driven.
public enum Inflate {
    public enum Failure: Error { case invalid(String) }

    static let lengthBase: [Int] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
    static let lengthExtra: [Int] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
    static let distBase: [Int] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
    static let distExtra: [Int] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
    static let clOrder: [Int] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

    /// Canonical Huffman code as a direct lookup table indexed by the next `bits` input bits.
    struct Huffman {
        var table: [UInt16]   // symbol << 4 | length (length 0 = unused slot)
        var bits: Int

        init(lengths: [UInt8]) throws {
            var maxLen = 0
            var counts = [Int](repeating: 0, count: 16)
            for l in lengths where l > 0 { counts[Int(l)] += 1; maxLen = max(maxLen, Int(l)) }
            bits = max(1, maxLen)
            table = [UInt16](repeating: 0, count: 1 << bits)
            guard maxLen > 0 else { return }
            // Over-subscribed codes are invalid; incomplete ones are allowed (single-code distance trees).
            var left = 1
            for len in 1...15 { left <<= 1; left -= counts[len]; if left < 0 { throw Failure.invalid("over-subscribed code") } }
            var next = [Int](repeating: 0, count: 16)
            var code = 0
            for len in 1...15 { code = (code + counts[len - 1]) << 1; next[len] = code }
            next[0] = 0
            for (sym, l8) in lengths.enumerated() where l8 > 0 {
                let len = Int(l8)
                let c = next[len]; next[len] += 1
                var rev = 0
                for i in 0..<len where c & (1 << i) != 0 { rev |= 1 << (len - 1 - i) }
                let entry = UInt16(sym << 4 | len)
                var idx = rev
                while idx < table.count { table[idx] = entry; idx += 1 << len }
            }
        }
    }

    struct BitReader {
        let input: [UInt8]
        var pos = 0
        var buf: UInt64 = 0
        var count = 0
        var overrun = 0

        init(_ input: [UInt8]) { self.input = input }

        @inline(__always) mutating func fill(_ n: Int) {
            while count < n {
                if pos < input.count { buf |= UInt64(input[pos]) << UInt64(count); pos += 1 } else { overrun += 1 }
                count += 8
            }
        }
        @inline(__always) mutating func take(_ n: Int) throws -> Int {
            if n == 0 { return 0 }
            fill(n)
            let v = Int(buf & ((1 << UInt64(n)) - 1))
            buf >>= UInt64(n); count -= n
            if overrun > 4 { throw Failure.invalid("unexpected end of data") }
            return v
        }
        @inline(__always) mutating func decode(_ h: Huffman) throws -> Int {
            fill(h.bits)
            let e = h.table[Int(buf & ((1 << UInt64(h.bits)) - 1))]
            let len = Int(e & 15)
            guard len > 0 else { throw Failure.invalid("bad Huffman code") }
            buf >>= UInt64(len); count -= len
            if overrun > 4 { throw Failure.invalid("unexpected end of data") }
            return Int(e >> 4)
        }
        mutating func alignToByte() { let drop = count % 8; buf >>= UInt64(drop); count -= drop }
    }

    static let fixedLit: Huffman = {
        var l = [UInt8](repeating: 8, count: 288)
        for i in 144..<256 { l[i] = 9 }
        for i in 256..<280 { l[i] = 7 }
        return try! Huffman(lengths: l)
    }()
    static let fixedDist: Huffman = try! Huffman(lengths: [UInt8](repeating: 5, count: 30))

    /// Growable output window; back-references copy forward byte by byte (overlaps allowed).
    struct Output {
        var buf: [UInt8]
        var n = 0
        init(capacity: Int) { buf = [UInt8](repeating: 0, count: max(capacity, 1024)) }
        @inline(__always) mutating func ensure(_ k: Int) {
            if n + k > buf.count { buf.append(contentsOf: repeatElement(0, count: max(buf.count, k))) }
        }
        @inline(__always) mutating func append(_ b: UInt8) { ensure(1); buf[n] = b; n += 1 }
        mutating func append(_ slice: ArraySlice<UInt8>) { ensure(slice.count); for b in slice { buf[n] = b; n += 1 } }
        @inline(__always) mutating func copy(distance d: Int, length len: Int) {
            ensure(len)
            var s = n - d
            for _ in 0..<len { buf[n] = buf[s]; n += 1; s += 1 }
        }
        mutating func finish() -> [UInt8] { buf.removeLast(buf.count - n); return buf }
    }

    public static func decompress(_ input: [UInt8], expectedSize: Int = 0) throws -> [UInt8] {
        var out = Output(capacity: expectedSize > 0 ? expectedSize : input.count * 3)
        var br = BitReader(input)
        var last = 0
        repeat {
            last = try br.take(1)
            let type = try br.take(2)
            switch type {
            case 0:
                br.alignToByte()
                let len = try br.take(16), nlen = try br.take(16)
                guard len == (~nlen & 0xFFFF) else { throw Failure.invalid("stored length mismatch") }
                // Bytes still in the bit buffer come first.
                var n = len
                while n > 0, br.count >= 8 { out.append(UInt8(try br.take(8))); n -= 1 }
                guard br.pos + n <= input.count else { throw Failure.invalid("stored block past end") }
                out.append(input[br.pos..<(br.pos + n)])
                br.pos += n
            case 1:
                try inflateBlock(&br, &out, fixedLit, fixedDist)
            case 2:
                let hlit = try br.take(5) + 257, hdist = try br.take(5) + 1, hclen = try br.take(4) + 4
                var cl = [UInt8](repeating: 0, count: 19)
                for i in 0..<hclen { cl[clOrder[i]] = UInt8(try br.take(3)) }
                let clh = try Huffman(lengths: cl)
                var lengths = [UInt8]()
                lengths.reserveCapacity(hlit + hdist)
                while lengths.count < hlit + hdist {
                    let sym = try br.decode(clh)
                    switch sym {
                    case 0...15: lengths.append(UInt8(sym))
                    case 16:
                        guard let prev = lengths.last else { throw Failure.invalid("repeat without previous length") }
                        for _ in 0..<(3 + (try br.take(2))) { lengths.append(prev) }
                    case 17: for _ in 0..<(3 + (try br.take(3))) { lengths.append(0) }
                    default: for _ in 0..<(11 + (try br.take(7))) { lengths.append(0) }
                    }
                }
                guard lengths.count == hlit + hdist, lengths[256] > 0 else { throw Failure.invalid("bad code lengths") }
                let lit = try Huffman(lengths: Array(lengths[0..<hlit]))
                let dist = try Huffman(lengths: Array(lengths[hlit...]))
                try inflateBlock(&br, &out, lit, dist)
            default:
                throw Failure.invalid("reserved block type")
            }
        } while last == 0
        return out.finish()
    }

    static func inflateBlock(_ br: inout BitReader, _ out: inout Output, _ lit: Huffman, _ dist: Huffman) throws {
        while true {
            let sym = try br.decode(lit)
            if sym < 256 { out.append(UInt8(sym)); continue }
            if sym == 256 { return }
            let li = sym - 257
            guard li < lengthBase.count else { throw Failure.invalid("bad length symbol") }
            let len = lengthBase[li] + (try br.take(lengthExtra[li]))
            let di = try br.decode(dist)
            guard di < distBase.count else { throw Failure.invalid("bad distance symbol") }
            let d = distBase[di] + (try br.take(distExtra[di]))
            guard d <= out.n else { throw Failure.invalid("distance too far back") }
            out.copy(distance: d, length: len)
        }
    }
}
