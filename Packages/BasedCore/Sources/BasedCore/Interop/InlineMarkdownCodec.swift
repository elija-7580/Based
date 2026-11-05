import Foundation

/// Converts RichText ⇄ inline Markdown.
public enum InlineMarkdownCodec {

    // MARK: Encode

    public static func encode(_ text: RichText, pageLink: (RecordID) -> (title: String, url: String)? = { _ in nil }) -> String {
        var out = ""
        for run in text.runs {
            if let eq = run.equation { out += "$\(eq)$"; continue }
            if let m = run.mention {
                switch m {
                case .page(let id):
                    if let l = pageLink(id) { out += "[\(escape(l.title))](\(l.url))" } else { out += run.text }
                case .date(let d): out += "@" + DateParsing.format(d)
                case .user(let u): out += "@" + u
                case .link(let u): out += "[\(escape(run.text))](\(u))"
                }
                continue
            }
            var s = run.marks.code ? run.text : escape(run.text)
            if s.isEmpty { continue }
            // keep surrounding whitespace outside the markers
            let lead = String(s.prefix { $0 == " " })
            let trail = String(s.reversed().prefix { $0 == " " })
            if lead.count == s.count { out += s; continue }
            s = String(s.dropFirst(lead.count).dropLast(trail.count))
            let m = run.marks
            if m.code { s = "`\(s)`" }
            if m.bold { s = "**\(s)**" }
            if m.italic { s = "*\(s)*" }
            if m.strikethrough { s = "~~\(s)~~" }
            if m.underline { s = "<u>\(s)</u>" }
            if let link = m.link { s = "[\(s)](\(link))" }
            out += lead + s + trail
        }
        return out
    }

    static func escape(_ s: String) -> String {
        var out = ""
        for c in s {
            if "*_`~[]\\$".contains(c) { out.append("\\") }
            out.append(c)
        }
        return out
    }

    // MARK: Decode

    /// Parses inline Markdown. `resolveLink` can turn a link target into a page mention.
    public static func decode(_ s: String, resolveLink: @escaping (String) -> RecordID? = { _ in nil }) -> RichText {
        var p = InlineParser(chars: Array(s), resolve: resolveLink)
        let runs = p.parse(until: nil, marks: .plain)
        return RichText(runs: runs).normalizedRuns()
    }
}

struct InlineParser {
    let chars: [Character]
    let resolve: (String) -> RecordID?
    var i = 0

    init(chars: [Character], resolve: @escaping (String) -> RecordID?) {
        self.chars = chars; self.resolve = resolve
    }

    func peek(_ s: String, at j: Int? = nil) -> Bool {
        let k = j ?? i
        let a = Array(s)
        guard k + a.count <= chars.count else { return false }
        return Array(chars[k..<(k + a.count)]) == a
    }

    /// Index of the closing delimiter, honouring escapes.
    func find(_ d: String, from j: Int) -> Int? {
        var k = j
        while k < chars.count {
            if chars[k] == "\\" { k += 2; continue }
            if peek(d, at: k) { return k }
            k += 1
        }
        return nil
    }

    mutating func parse(until end: String?, marks: Marks) -> [TextRun] {
        var runs: [TextRun] = []
        var buf = ""
        func flush() { if !buf.isEmpty { runs.append(TextRun(buf, marks: marks)); buf = "" } }
        while i < chars.count {
            if let end, peek(end) { break }
            let c = chars[i]
            if c == "\\", i + 1 < chars.count { buf.append(chars[i + 1]); i += 2; continue }
            if c == "`", let close = find("`", from: i + 1), close > i + 1 {
                flush()
                var m = marks; m.code = true
                runs.append(TextRun(String(chars[(i + 1)..<close]), marks: m))
                i = close + 1; continue
            }
            if c == "$", i + 1 < chars.count, chars[i + 1] != " ", let close = find("$", from: i + 1), close > i + 1 {
                flush()
                runs.append(TextRun("⁣", equation: String(chars[(i + 1)..<close])))
                i = close + 1; continue
            }
            let spans: [(String, (inout Marks) -> Void)] = [
                ("**", { $0.bold = true }), ("__", { $0.bold = true }), ("~~", { $0.strikethrough = true }),
                ("<u>", { $0.underline = true }), ("<b>", { $0.bold = true }), ("<i>", { $0.italic = true }),
                ("*", { $0.italic = true }), ("_", { $0.italic = true }), ("~", { $0.strikethrough = true }),
            ]
            var handled = false
            for (d, f) in spans where peek(d) {
                let closeD = d.hasPrefix("<") ? "</" + d.dropFirst() : d
                let start = i + d.count
                guard start < chars.count, chars[start] != " ", let close = find(closeD, from: start), close > start else { continue }
                if d == "_", i > 0, chars[i - 1].isLetter || chars[i - 1].isNumber { continue }
                flush()
                var m = marks; f(&m)
                i = start
                let inner = parse(until: closeD, marks: m)
                runs.append(contentsOf: inner)
                i = min(chars.count, i + closeD.count)
                handled = true
                break
            }
            if handled { continue }
            if c == "[", let mid = find("](", from: i + 1), let close = find(")", from: mid + 2) {
                flush()
                let label = String(chars[(i + 1)..<mid])
                let target = String(chars[(mid + 2)..<close]).trimmingCharacters(in: .whitespaces)
                if let page = resolve(target) {
                    runs.append(TextRun(label, mention: .page(page)))
                } else {
                    var m = marks; m.link = target
                    var sub = InlineParser(chars: Array(label), resolve: resolve)
                    runs.append(contentsOf: sub.parse(until: nil, marks: m))
                }
                i = close + 1; continue
            }
            if c == "<", peek("<br>") || peek("<br/>") {
                buf.append("\n"); i += peek("<br>") ? 4 : 5; continue
            }
            buf.append(c)
            i += 1
        }
        flush()
        return runs
    }
}

extension RichText {
    /// Merges adjacent runs with identical formatting.
    func normalizedRuns() -> RichText {
        var out: [TextRun] = []
        for r in runs where !r.text.isEmpty {
            if let last = out.last, last.marks == r.marks, last.mention == nil, r.mention == nil,
               last.equation == nil, r.equation == nil {
                out[out.count - 1].text += r.text
            } else {
                out.append(r)
            }
        }
        return RichText(runs: out)
    }
}