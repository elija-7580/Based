import Foundation

/// Small, fast syntax highlighter for code blocks: keywords, strings, comments, numbers, types and
/// function calls for the languages people actually paste into notes. Not a parser — a single left-to-right
/// scan, so it stays cheap while typing (~1 µs per character) and never fails on broken code.
public enum SyntaxHighlighter {
    public enum Kind: String, Sendable, Equatable { case keyword, string, comment, number, type, function, property }

    public struct Token: Sendable, Equatable {
        /// UTF-16 range (matches NSString / NSTextStorage).
        public var location: Int
        public var length: Int
        public var kind: Kind
        public init(_ location: Int, _ length: Int, _ kind: Kind) { self.location = location; self.length = length; self.kind = kind }
    }

    struct Grammar {
        var keywords: Set<String>
        var lineComments: [String]
        var blockComment: (String, String)?
        var stringQuotes: Set<Character> = ["\"", "'"]
        var capitalizedAreTypes = true
        var hashComment: Bool { lineComments.contains("#") }
    }

    static let cLike: Set<String> = ["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue",
                                     "return", "true", "false", "null", "new", "try", "catch", "finally", "throw", "class",
                                     "struct", "enum", "const", "static", "public", "private", "protected", "import", "void"]

    static func grammar(_ language: String?) -> Grammar? {
        switch (language ?? "").lowercased() {
        case "swift":
            return Grammar(keywords: cLike.union(["let", "var", "func", "guard", "in", "extension", "protocol", "self", "Self", "nil",
                                                  "init", "deinit", "where", "async", "await", "throws", "rethrows", "inout",
                                                  "some", "any", "as", "is", "defer", "fileprivate", "internal", "open", "final",
                                                  "override", "mutating", "weak", "unowned", "lazy", "typealias", "associatedtype",
                                                  "actor", "nonisolated", "repeat", "fallthrough", "subscript", "operator"]),
                           lineComments: ["//"], blockComment: ("/*", "*/"))
        case "javascript", "js", "typescript", "ts", "jsx", "tsx", "java", "kotlin", "c", "c++", "cpp", "c#", "csharp",
             "go", "rust", "dart", "scala", "php", "objective-c", "groovy", "graphql", "solidity":
            return Grammar(keywords: cLike.union(["let", "var", "function", "func", "fn", "def", "in", "of", "this", "super",
                                                  "extends", "implements", "interface", "type", "async", "await", "yield",
                                                  "export", "from", "as", "undefined", "typeof", "instanceof", "delete",
                                                  "package", "go", "defer", "chan", "map", "range", "select", "struct", "impl",
                                                  "trait", "mut", "pub", "use", "mod", "match", "loop", "where", "self", "Self",
                                                  "int", "long", "float", "double", "char", "bool", "boolean", "string", "auto",
                                                  "unsigned", "signed", "sizeof", "namespace", "using", "template", "typename",
                                                  "virtual", "override", "readonly", "abstract", "final", "val", "fun", "object",
                                                  "when", "nil", "None", "elif", "lambda"]),
                           lineComments: ["//"], blockComment: ("/*", "*/"), stringQuotes: ["\"", "'", "`"])
        case "python", "py":
            return Grammar(keywords: ["def", "class", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is",
                                      "return", "import", "from", "as", "with", "try", "except", "finally", "raise", "pass",
                                      "break", "continue", "lambda", "yield", "None", "True", "False", "global", "nonlocal",
                                      "assert", "del", "async", "await", "self", "match", "case"],
                           lineComments: ["#"], blockComment: nil)
        case "ruby", "rb", "elixir", "r":
            return Grammar(keywords: ["def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for",
                                      "in", "do", "return", "yield", "nil", "true", "false", "self", "require", "case", "when",
                                      "then", "begin", "rescue", "ensure", "and", "or", "not", "function", "NULL", "TRUE", "FALSE",
                                      "defmodule", "defp", "fn"],
                           lineComments: ["#"], blockComment: nil)
        case "bash", "shell", "sh", "zsh", "docker", "dockerfile", "makefile", "yaml", "yml", "toml", "nix":
            return Grammar(keywords: ["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac",
                                      "function", "return", "export", "local", "echo", "cd", "sudo", "true", "false",
                                      "FROM", "RUN", "CMD", "COPY", "ADD", "ENV", "WORKDIR", "EXPOSE", "ENTRYPOINT", "ARG"],
                           lineComments: ["#"], blockComment: nil, capitalizedAreTypes: false)
        case "sql":
            let kw = ["select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set", "delete",
                      "create", "table", "index", "drop", "alter", "join", "left", "right", "inner", "outer", "on", "group",
                      "by", "order", "having", "limit", "as", "distinct", "null", "is", "in", "primary", "key", "default",
                      "union", "all", "case", "when", "then", "else", "end", "with", "returning", "exists"]
            return Grammar(keywords: Set(kw + kw.map { $0.uppercased() }), lineComments: ["--"], blockComment: ("/*", "*/"),
                           capitalizedAreTypes: false)
        case "json":
            return Grammar(keywords: ["true", "false", "null"], lineComments: [], blockComment: nil, capitalizedAreTypes: false)
        case "css", "scss", "less":
            return Grammar(keywords: ["important", "media", "import", "from", "to", "and", "not"], lineComments: ["//"],
                           blockComment: ("/*", "*/"), capitalizedAreTypes: false)
        case "html", "xml", "markdown", "mermaid", "plain text", "", "diff":
            return nil
        default:
            return Grammar(keywords: cLike, lineComments: ["//", "#"], blockComment: ("/*", "*/"))
        }
    }

    /// Tokens for `code` in `language` (nil / unknown plain-text languages → none).
    public static func tokens(_ code: String, language: String?) -> [Token] {
        guard let g = grammar(language) else { return [] }
        let u = Array(code.utf16)
        let n = u.count
        var out: [Token] = []
        var i = 0

        func starts(_ s: String, at k: Int) -> Bool {
            let p = Array(s.utf16)
            guard k + p.count <= n else { return false }
            for j in 0..<p.count where u[k + j] != p[j] { return false }
            return true
        }
        func isIdentStart(_ c: UInt16) -> Bool { (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 || c == 36 || c == 64 }
        func isIdent(_ c: UInt16) -> Bool { isIdentStart(c) || (c >= 48 && c <= 57) }
        func isDigit(_ c: UInt16) -> Bool { c >= 48 && c <= 57 }

        let quotes = Set(g.stringQuotes.compactMap { $0.utf16.first })
        while i < n {
            let c = u[i]
            // Comments
            if let lc = g.lineComments.first(where: { starts($0, at: i) }) {
                // `#` in C-like grammars only at line start (preprocessor-ish) is fine to colour as comment too.
                _ = lc
                var j = i
                while j < n, u[j] != 10 { j += 1 }
                out.append(Token(i, j - i, .comment)); i = j; continue
            }
            if let (open, close) = g.blockComment, starts(open, at: i) {
                var j = i + open.utf16.count
                while j < n, !starts(close, at: j) { j += 1 }
                j = min(n, j + close.utf16.count)
                out.append(Token(i, j - i, .comment)); i = j; continue
            }
            // Strings (with escapes; unterminated strings end at the line end)
            if quotes.contains(c) {
                var j = i + 1
                while j < n, u[j] != c {
                    if u[j] == 92 { j += 2; continue }        // backslash
                    if u[j] == 10, c != 96 { break }          // newline ends ' and " strings (not `templates`)
                    j += 1
                }
                j = min(n, j + 1)
                out.append(Token(i, j - i, .string)); i = j; continue
            }
            // Numbers
            if isDigit(c), i == 0 || !isIdent(u[i - 1]) {
                var j = i + 1
                while j < n, isIdent(u[j]) || u[j] == 46 { j += 1 }    // 0x1F, 1_000, 3.14, 1e9
                out.append(Token(i, j - i, .number)); i = j; continue
            }
            // Identifiers
            if isIdentStart(c) {
                var j = i + 1
                while j < n, isIdent(u[j]) { j += 1 }
                let word = String(utf16CodeUnits: Array(u[i..<j]), count: j - i)
                var k = j
                while k < n, u[k] == 32 { k += 1 }
                if g.keywords.contains(word) || (c == 64 && word.count > 1) {
                    out.append(Token(i, j - i, .keyword))
                } else if k < n, u[k] == 40 {                       // name(
                    out.append(Token(i, j - i, .function))
                } else if g.capitalizedAreTypes, c >= 65, c <= 90, word.count > 1 {
                    out.append(Token(i, j - i, .type))
                } else if i > 0, u[i - 1] == 46 {                   // .property
                    out.append(Token(i, j - i, .property))
                }
                i = j; continue
            }
            i += 1
        }
        return out
    }
}
