import Foundation

/// Pure-Swift ChaCha20-Poly1305 AEAD (RFC 8439). Used for end-to-end encryption of agent session transcripts so a relay
/// server (based-server / VPS) never sees plaintext — the same guarantee Happier gives. Portable: runs on Linux and Apple.
public enum ChaChaPoly {
    public struct Error: Swift.Error { public let message: String }

    @inline(__always) static func rotl(_ v: UInt32, _ n: UInt32) -> UInt32 { (v << n) | (v >> (32 - n)) }

    static func quarterRound(_ s: inout [UInt32], _ a: Int, _ b: Int, _ c: Int, _ d: Int) {
        s[a] &+= s[b]; s[d] ^= s[a]; s[d] = rotl(s[d], 16)
        s[c] &+= s[d]; s[b] ^= s[c]; s[b] = rotl(s[b], 12)
        s[a] &+= s[b]; s[d] ^= s[a]; s[d] = rotl(s[d], 8)
        s[c] &+= s[d]; s[b] ^= s[c]; s[b] = rotl(s[b], 7)
    }

    static func le32(_ d: [UInt8], _ i: Int) -> UInt32 {
        UInt32(d[i]) | UInt32(d[i + 1]) << 8 | UInt32(d[i + 2]) << 16 | UInt32(d[i + 3]) << 24
    }

    public static func block(key: [UInt8], counter: UInt32, nonce: [UInt8]) -> [UInt8] {
        var s: [UInt32] = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]
        for i in 0..<8 { s.append(le32(key, i * 4)) }
        s.append(counter)
        for i in 0..<3 { s.append(le32(nonce, i * 4)) }
        var w = s
        for _ in 0..<10 {
            quarterRound(&w, 0, 4, 8, 12); quarterRound(&w, 1, 5, 9, 13); quarterRound(&w, 2, 6, 10, 14); quarterRound(&w, 3, 7, 11, 15)
            quarterRound(&w, 0, 5, 10, 15); quarterRound(&w, 1, 6, 11, 12); quarterRound(&w, 2, 7, 8, 13); quarterRound(&w, 3, 4, 9, 14)
        }
        var out: [UInt8] = []; out.reserveCapacity(64)
        for i in 0..<16 { let v = w[i] &+ s[i]; out += [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8(v >> 24)] }
        return out
    }

    public static func chacha20(key: [UInt8], counter: UInt32, nonce: [UInt8], _ data: [UInt8]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: data.count)
        var ctr = counter
        var i = 0
        while i < data.count {
            let ks = block(key: key, counter: ctr, nonce: nonce)
            let n = min(64, data.count - i)
            for j in 0..<n { out[i + j] = data[i + j] ^ ks[j] }
            i += n; ctr &+= 1
        }
        return out
    }

    // Poly1305 using 5×26-bit limbs would be faster; 130-bit math with UInt64 pairs is simpler and adequate here.
    static func poly1305(key: [UInt8], _ msg: [UInt8]) -> [UInt8] {
        // r clamped
        var r = [UInt8](key[0..<16]); r[3] &= 15; r[7] &= 15; r[11] &= 15; r[15] &= 15; r[4] &= 252; r[8] &= 252; r[12] &= 252
        let rN = bigFrom(r), sN = bigFrom([UInt8](key[16..<32]))
        let p = Big(limbs: [0xFFFFFFFFFFFFFFFB, 0xFFFFFFFFFFFFFFFF, 0x3]) // 2^130 - 5
        var acc = Big(limbs: [0, 0, 0])
        var i = 0
        while i < msg.count {
            let n = min(16, msg.count - i)
            var chunk = [UInt8](msg[i..<i + n]); chunk.append(1)
            acc = Big.add(acc, bigFrom(chunk))
            acc = Big.mulmod(acc, rN, p)
            i += n
        }
        acc = Big.add(acc, sN)
        return acc.bytes16()
    }

    static func bigFrom(_ b: [UInt8]) -> Big {
        var limbs: [UInt64] = [0, 0, 0]
        for (i, byte) in b.enumerated() where i < 24 { limbs[i / 8] |= UInt64(byte) << (UInt64(i % 8) * 8) }
        return Big(limbs: limbs)
    }

    /// 192-bit little-endian integer helper (enough for 130-bit field arithmetic with headroom).
    struct Big {
        var limbs: [UInt64] // 3 limbs little endian
        static func add(_ a: Big, _ b: Big) -> Big {
            var r = [UInt64](repeating: 0, count: 3); var carry: UInt64 = 0
            for i in 0..<3 { let (s1, c1) = a.limbs[i].addingReportingOverflow(b.limbs[i]); let (s2, c2) = s1.addingReportingOverflow(carry); r[i] = s2; carry = (c1 ? 1 : 0) + (c2 ? 1 : 0) }
            return Big(limbs: r)
        }
        /// (a*b) mod p where p = 2^130-5, inputs < 2^131.
        static func mulmod(_ a: Big, _ b: Big, _ p: Big) -> Big {
            // schoolbook 3x3 limbs → 6 limbs
            var prod = [UInt64](repeating: 0, count: 6)
            for i in 0..<3 { var carry: UInt64 = 0
                for j in 0..<3 {
                    let (hi, lo) = a.limbs[i].multipliedFullWidth(by: b.limbs[j])
                    let (s1, c1) = prod[i + j].addingReportingOverflow(lo); let (s2, c2) = s1.addingReportingOverflow(carry)
                    prod[i + j] = s2; carry = hi &+ (c1 ? 1 : 0) &+ (c2 ? 1 : 0)
                }
                prod[i + 3] = carry
            }
            // reduce: x = lo130 + hi * 5 where hi = x >> 130
            func reduce(_ x: [UInt64]) -> [UInt64] {
                // split at bit 130: lo = x & (2^130-1), hi = x >> 130
                var lo = [x[0], x[1], x[2] & 0x3]
                var hi = [UInt64](repeating: 0, count: 6)
                // shift right by 130 = 2 limbs + 2 bits
                for i in 0..<4 { let cur = x[i + 2] >> 2; let next = i + 3 < 6 ? x[i + 3] << 62 : 0; hi[i] = cur | next }
                // hi*5
                var h5 = [UInt64](repeating: 0, count: 6); var carry: UInt64 = 0
                for i in 0..<6 { let (h, l) = hi[i].multipliedFullWidth(by: 5); let (s, c) = l.addingReportingOverflow(carry); h5[i] = s; carry = h &+ (c ? 1 : 0) }
                // lo + h5
                var r = [UInt64](repeating: 0, count: 6); carry = 0
                for i in 0..<6 { let a = i < 3 ? lo[i] : 0; let (s1, c1) = a.addingReportingOverflow(h5[i]); let (s2, c2) = s1.addingReportingOverflow(carry); r[i] = s2; carry = (c1 ? 1 : 0) + (c2 ? 1 : 0) }
                lo = [r[0], r[1], r[2]]
                return r
            }
            var r = reduce(prod); r = reduce(r)
            var out = Big(limbs: [r[0], r[1], r[2]])
            // final conditional subtract of p (at most twice)
            for _ in 0..<2 { if !out.less(p) { out = out.sub(p) } }
            return out
        }
        func less(_ o: Big) -> Bool { for i in (0..<3).reversed() { if limbs[i] != o.limbs[i] { return limbs[i] < o.limbs[i] } }; return false }
        func sub(_ o: Big) -> Big {
            var r = [UInt64](repeating: 0, count: 3); var borrow: UInt64 = 0
            for i in 0..<3 { let (d1, b1) = limbs[i].subtractingReportingOverflow(o.limbs[i]); let (d2, b2) = d1.subtractingReportingOverflow(borrow); r[i] = d2; borrow = (b1 ? 1 : 0) + (b2 ? 1 : 0) }
            return Big(limbs: r)
        }
        func bytes16() -> [UInt8] { var out: [UInt8] = []; for i in 0..<2 { for j in 0..<8 { out.append(UInt8((limbs[i] >> (UInt64(j) * 8)) & 0xff)) } }; return out }
    }

    static func pad16(_ n: Int) -> [UInt8] { let r = n % 16; return r == 0 ? [] : [UInt8](repeating: 0, count: 16 - r) }
    static func le64(_ n: Int) -> [UInt8] { (0..<8).map { UInt8((UInt64(n) >> (UInt64($0) * 8)) & 0xff) } }

    static func tag(key: [UInt8], nonce: [UInt8], aad: [UInt8], ciphertext: [UInt8]) -> [UInt8] {
        let polyKey = [UInt8](block(key: key, counter: 0, nonce: nonce)[0..<32])
        let mac = aad + pad16(aad.count) + ciphertext + pad16(ciphertext.count) + le64(aad.count) + le64(ciphertext.count)
        return poly1305(key: polyKey, mac)
    }

    /// Returns nonce(12) || ciphertext || tag(16)
    public static func seal(_ plaintext: [UInt8], key: [UInt8], nonce: [UInt8]? = nil, aad: [UInt8] = []) throws -> [UInt8] {
        guard key.count == 32 else { throw Error(message: "key must be 32 bytes") }
        let n = nonce ?? (0..<12).map { _ in UInt8.random(in: 0...255) }
        guard n.count == 12 else { throw Error(message: "nonce must be 12 bytes") }
        let ct = chacha20(key: key, counter: 1, nonce: n, plaintext)
        return n + ct + tag(key: key, nonce: n, aad: aad, ciphertext: ct)
    }

    public static func open(_ sealed: [UInt8], key: [UInt8], aad: [UInt8] = []) throws -> [UInt8] {
        guard key.count == 32, sealed.count >= 28 else { throw Error(message: "bad input") }
        let n = [UInt8](sealed[0..<12]), ct = [UInt8](sealed[12..<(sealed.count - 16)]), t = [UInt8](sealed[(sealed.count - 16)...])
        let expect = tag(key: key, nonce: n, aad: aad, ciphertext: ct)
        var diff: UInt8 = 0; for i in 0..<16 { diff |= expect[i] ^ t[i] }
        guard diff == 0 else { throw Error(message: "authentication failed") }
        return chacha20(key: key, counter: 1, nonce: n, ct)
    }
}

/// Symmetric cipher for session transcripts; key lives in the Keychain (app) or a file (server) and is shared between
/// the user's devices via the pairing code shown in Settings, never via the relay.
public struct SessionCipher: Sendable {
    public let key: [UInt8]
    public init(key: [UInt8]) { self.key = key }
    public init?(base64 s: String) { guard let d = Data(base64Encoded: s), d.count == 32 else { return nil }; key = [UInt8](d) }
    public static func generate() -> SessionCipher { SessionCipher(key: (0..<32).map { _ in UInt8.random(in: 0...255) }) }
    public var base64: String { Data(key).base64EncodedString() }
    public func seal(_ text: String) throws -> String { Data(try ChaChaPoly.seal([UInt8](text.utf8), key: key)).base64EncodedString() }
    public func open(_ b64: String) throws -> String {
        guard let d = Data(base64Encoded: b64) else { throw ChaChaPoly.Error(message: "bad base64") }
        return String(decoding: try ChaChaPoly.open([UInt8](d), key: key), as: UTF8.self)
    }
}
