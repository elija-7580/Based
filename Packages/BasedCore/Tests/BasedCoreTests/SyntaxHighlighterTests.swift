import Foundation
import Testing
@testable import BasedCore

struct SyntaxHighlighterTests {
    func kinds(_ code: String, _ lang: String) -> [(String, SyntaxHighlighter.Kind)] {
        let ns = code as NSString
        return SyntaxHighlighter.tokens(code, language: lang).map { (ns.substring(with: NSRange(location: $0.location, length: $0.length)), $0.kind) }
    }

    @Test func swiftBasics() {
        let k = kinds("let x = 1 // one\nfunc go(a: Int) -> String { return \"hi\\\"\" }", "swift")
        #expect(k.contains { $0 == ("let", .keyword) })
        #expect(k.contains { $0 == ("1", .number) })
        #expect(k.contains { $0 == ("// one", .comment) })
        #expect(k.contains { $0 == ("func", .keyword) })
        #expect(k.contains { $0 == ("go", .function) })
        #expect(k.contains { $0 == ("Int", .type) })
        #expect(k.contains { $0 == ("\"hi\\\"\"", .string) })
        #expect(!k.contains { $0.0 == "x" })
    }

    @Test func pythonAndBlockComments() {
        let p = kinds("def f(x):\n    # note\n    return None", "python")
        #expect(p.map(\.1) == [.keyword, .function, .comment, .keyword, .keyword])
        let js = kinds("/* a\n b */ const s = `t\n${x}`; obj.prop", "javascript")
        #expect(js.first?.1 == .comment)
        #expect(js.contains { $0 == ("`t\n${x}`", .string) })
        #expect(js.contains { $0 == ("prop", .property) })
    }

    @Test func plainAndBrokenCode() {
        #expect(SyntaxHighlighter.tokens("anything", language: "plain text").isEmpty)
        #expect(SyntaxHighlighter.tokens("anything", language: nil).isEmpty)
        // Unterminated string / comment never crashes and stays inside the text.
        for code in ["\"open", "/* open", "x = 'a\nb'", "😀 let y = \"é\""] {
            let t = SyntaxHighlighter.tokens(code, language: "swift")
            #expect(t.allSatisfy { $0.location + $0.length <= (code as NSString).length })
        }
        let sql = kinds("SELECT name FROM users -- all", "sql")
        #expect(sql.map(\.1) == [.keyword, .keyword, .comment])
    }
}
