import Foundation

/// Small line diff (LCS) used to show agent file edits like Claude Code: `-` removed, `+` added, ` ` context.
public enum LineDiff {
    public enum Op: Equatable, Sendable { case same(String), removed(String), added(String) }

    /// Line operations turning `old` into `new`. Large inputs fall back to "all removed, all added".
    public static func ops(old: String, new: String) -> [Op] {
        let a = old.isEmpty ? [] : old.components(separatedBy: "\n")
        let b = new.isEmpty ? [] : new.components(separatedBy: "\n")
        // Common prefix / suffix first: edits are usually small regions of big strings.
        var pre = 0
        while pre < a.count, pre < b.count, a[pre] == b[pre] { pre += 1 }
        var suf = 0
        while suf < a.count - pre, suf < b.count - pre, a[a.count - 1 - suf] == b[b.count - 1 - suf] { suf += 1 }
        let ma = Array(a[pre..<(a.count - suf)]), mb = Array(b[pre..<(b.count - suf)])
        var out: [Op] = a[0..<pre].map { .same($0) }
        if ma.count * mb.count > 2_000_000 {
            out += ma.map { .removed($0) } + mb.map { .added($0) }
        } else {
            // LCS table on the middle part.
            let n = ma.count, m = mb.count
            var t = [[Int]](repeating: [Int](repeating: 0, count: m + 1), count: n + 1)
            if n > 0 && m > 0 {
                for i in stride(from: n - 1, through: 0, by: -1) {
                    for j in stride(from: m - 1, through: 0, by: -1) {
                        t[i][j] = ma[i] == mb[j] ? t[i + 1][j + 1] + 1 : max(t[i + 1][j], t[i][j + 1])
                    }
                }
            }
            var i = 0, j = 0
            while i < n || j < m {
                if i < n, j < m, ma[i] == mb[j] { out.append(.same(ma[i])); i += 1; j += 1 }
                else if i < n, j == m || t[i + 1][j] >= t[i][j + 1] { out.append(.removed(ma[i])); i += 1 }
                else { out.append(.added(mb[j])); j += 1 }
            }
        }
        out += a[(a.count - suf)...].map { .same($0) }
        return out
    }

    public static func counts(_ ops: [Op]) -> (added: Int, removed: Int) {
        ops.reduce(into: (0, 0)) { r, o in
            switch o { case .added: r.0 += 1; case .removed: r.1 += 1; case .same: break }
        }
    }

    /// Unified diff body (hunks with `@@ -a,b +c,d @@` headers) keeping `context` lines around changes.
    /// - Parameter firstLine: file line number of the snippet's first line (edits are snippets of a larger file).
    public static func unified(old: String, new: String, context: Int = 3, firstLine: Int = 1) -> String {
        let all = ops(old: old, new: new)
        let changed = all.indices.filter { if case .same = all[$0] { return false }; return true }
        guard !changed.isEmpty else { return "" }
        // Group change indices into hunks.
        var hunks: [ClosedRange<Int>] = []
        for i in changed {
            let lo = max(0, i - context), hi = min(all.count - 1, i + context)
            if let last = hunks.last, lo <= last.upperBound + 1 { hunks[hunks.count - 1] = last.lowerBound...max(last.upperBound, hi) }
            else { hunks.append(lo...hi) }
        }
        // Line numbers before each op.
        var oldLine = [Int](repeating: 0, count: all.count), newLine = oldLine
        var o = max(1, firstLine), n = max(1, firstLine)
        for (k, op) in all.enumerated() {
            oldLine[k] = o; newLine[k] = n
            switch op { case .same: o += 1; n += 1; case .removed: o += 1; case .added: n += 1 }
        }
        var lines: [String] = []
        for h in hunks {
            let slice = all[h]
            let oc = slice.filter { if case .added = $0 { return false }; return true }.count
            let nc = slice.filter { if case .removed = $0 { return false }; return true }.count
            lines.append("@@ -\(oldLine[h.lowerBound]),\(oc) +\(newLine[h.lowerBound]),\(nc) @@")
            for op in slice {
                switch op {
                case .same(let s): lines.append(" " + s)
                case .removed(let s): lines.append("-" + s)
                case .added(let s): lines.append("+" + s)
                }
            }
        }
        return lines.joined(separator: "\n")
    }

    /// 1-based line in `file` where `snippet` starts (nil when the file can't be read or doesn't contain it).
    public static func firstLine(of snippet: String, inFile path: String, maxBytes: Int = 4_000_000) -> Int? {
        guard !snippet.isEmpty, path.hasPrefix("/"),
              let attrs = try? FileManager.default.attributesOfItem(atPath: path), (attrs[.size] as? Int ?? .max) <= maxBytes,
              let text = try? String(contentsOfFile: path, encoding: .utf8),
              let r = text.range(of: snippet) else { return nil }
        return text[..<r.lowerBound].reduce(1) { $1 == "\n" ? $0 + 1 : $0 }
    }

    /// Parsed unified-diff line for display: kind, old/new line number and text.
    public struct Line: Equatable, Sendable, Identifiable {
        public enum Kind: Sendable { case hunk, same, added, removed }
        public var id: Int
        public var kind: Kind
        public var oldNumber: Int?
        public var newNumber: Int?
        public var text: String
    }

    public static func parse(_ unified: String) -> [Line] {
        var out: [Line] = []
        var o = 0, n = 0
        for raw in unified.components(separatedBy: "\n") {
            if raw.hasPrefix("@@") {
                // @@ -a,b +c,d @@
                let parts = raw.split(separator: " ")
                if parts.count >= 3 {
                    o = Int(parts[1].dropFirst().split(separator: ",").first ?? "") ?? 1
                    n = Int(parts[2].dropFirst().split(separator: ",").first ?? "") ?? 1
                }
                out.append(Line(id: out.count, kind: .hunk, text: raw))
                continue
            }
            guard let first = raw.first else { continue }
            let text = String(raw.dropFirst())
            switch first {
            case "+": out.append(Line(id: out.count, kind: .added, newNumber: n, text: text)); n += 1
            case "-": out.append(Line(id: out.count, kind: .removed, oldNumber: o, text: text)); o += 1
            default: out.append(Line(id: out.count, kind: .same, oldNumber: o, newNumber: n, text: text)); o += 1; n += 1
            }
        }
        return out
    }
}
