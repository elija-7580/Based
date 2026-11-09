import Foundation
import Testing
@testable import BasedBrain

/// BSD-35: the web client's script (based-server/WebApp.swift) escapes workspace values, drops unsafe link schemes
/// and keeps the token in sessionStorage unless the user chooses otherwise. The script runs in Node with DOM stubs
/// (skipped when Node isn't installed).
@Suite struct WebAppSecurityTests {
    static var webAppSource: String? {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/based-server/WebApp.swift")
        return try? String(contentsOf: url, encoding: .utf8)
    }

    static func script(_ swift: String) -> String? {
        guard let a = swift.range(of: "<script>\n"), let b = swift.range(of: "</script>", range: a.upperBound..<swift.endIndex) else { return nil }
        return String(swift[a.upperBound..<b.lowerBound])
    }

    @Test func pageHasOneScriptAndNoPlainTokenStorage() throws {
        let src = try #require(Self.webAppSource)
        let js = try #require(Self.script(src))
        let page = try #require(src.components(separatedBy: "static let html = #\"\"\"").last?.components(separatedBy: "\"\"\"#").first)
        #expect(page.components(separatedBy: "<script").count == 2, "only one script tag, which gets the CSP nonce")
        #expect(!js.contains("localStorage.setItem(\"based.token\", S.token)"))
        #expect(js.contains("sessionStorage.setItem(\"based.token\""))
        #expect(src.contains("script-src 'nonce-"))
    }

    #if os(macOS) || os(Linux)
    @Test func scriptEscapesValuesAndDropsJavascriptLinks() throws {
        guard let node = ShellEnvironment.which("node") else { return }
        let js = try #require(Self.webAppSource.flatMap(Self.script))
        let harness = #"""
        const vm = require("vm");
        const mk = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
        globalThis.sessionStorage = mk(); globalThis.localStorage = mk();
        globalThis.location = { pathname: "/app", hash: "" };
        const el = () => ({ innerHTML: "", appendChild() {}, querySelector() { return el(); }, querySelectorAll() { return []; }, dataset: {},
                            content: { get firstChild() { return el(); } } });
        globalThis.document = { getElementById: () => el(), createElement: () => el(), querySelector: () => null, activeElement: null };
        globalThis.history = { pushState() {} }; globalThis.window = { addEventListener() {} }; globalThis.CSS = { escape: s => s };
        globalThis.fetch = async () => ({ status: 401, ok: false });
        vm.runInThisContext(require("fs").readFileSync(process.argv[2], "utf8"));
        vm.runInThisContext(`
          const evil = '"><img src=x onerror=alert(1)>';
          const out = {
            js: rich([{ t: "x", m: { link: "javascript:alert(1)" } }]),
            tab: rich([{ t: "x", m: { link: "java\\tscript:alert(1)" } }]),
            https: rich([{ t: "x", m: { link: "https://e.com/?a=1" } }]),
            mention: rich([{ t: "", mention: { page: evil } }]),
            icon: icon({ props: { icon: { emoji: "<img src=x onerror=alert(1)>" } } }),
            page: render({ id: evil, type: "page", text: "T", props: {} }, 0),
            text: render({ id: evil, type: "text", text: "T", props: {} }, 0),
            uid: cell({ uniqueID: { _0: 5 } }, { idPrefix: "<b>x</b>" }),
            url: cell({ url: { _0: "javascript:alert(1)" } }, {}),
            num: cell({ number: { _0: "<i>" } }, {}),
            rel: cell({ relation: { _0: [evil] } }, {}),
            img: render({ id: "i", type: "image", props: { url: "javascript:alert(1)" } }, 0),
            dataimg: safeUrl("data:image/png;base64,AA", true), svg: safeUrl("data:image/svg+xml,<svg>", true),
            anchor: safeUrl("#x"), mail: safeUrl("mailto:a@b.c"),
          };
          Tok.set("abc", false); out.sess = sessionStorage.getItem("based.token"); out.local = localStorage.getItem("based.token");
          Tok.set("abc", true); out.local2 = localStorage.getItem("based.token");
          Tok.set("abc", false); out.local3 = localStorage.getItem("based.token");
          console.log(JSON.stringify(out));
        `);
        """#
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("webapp-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let h = dir.appendingPathComponent("harness.js"), s = dir.appendingPathComponent("app.js")
        try harness.write(to: h, atomically: true, encoding: .utf8)
        try js.write(to: s, atomically: true, encoding: .utf8)
        let data = try #require(ShellEnvironment.run(node, [h.path, s.path], timeout: 30, environment: ShellEnvironment.childEnvironment(), cwd: dir.path))
        let line = String(decoding: data, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? ""
        let o = try JSONValue.parse(Data(line.utf8))
        func v(_ k: String) -> String { o[k]?.string ?? "<missing \(k)>" }
        #expect(v("js").contains("href=\"#\"") && v("tab").contains("href=\"#\""))
        #expect(v("https").contains("href=\"https://e.com/?a=1\""))
        for k in ["mention", "icon", "page", "text", "uid", "num", "rel"] {
            #expect(!v(k).contains("<img") && !v(k).contains("<b>") && !v(k).contains("<i>"), "\(k): \(v(k))")
        }
        #expect(v("page").contains("&quot;&gt;&lt;img"))
        #expect(v("url").contains("href=\"#\"") && v("img").contains("src=\"#\""))
        #expect(v("dataimg").hasPrefix("data:image/png") && v("svg") == "#")
        #expect(v("anchor") == "#x" && v("mail") == "mailto:a@b.c")
        #expect(v("sess") == "abc")
        #expect(o["local"] == .null && v("local2") == "abc" && o["local3"] == .null)
    }
    #endif
}
