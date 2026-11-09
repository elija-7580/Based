import Foundation

/// BSD-156 (ADR 0011): Golden Fixtures für Import und Export – Notion-HTML-Export (aus `NotionHTMLImportTests`,
/// Ordner und ZIP), Notion-Markdown/CSV, Markdown-Parser und Inline-Codec, CSV, Reimport-Schutz (BSD-32),
/// Markdown/HTML/Workspace-Export (BSD-67) und das Workspace-Archiv mit Import-Herkunft (BSD-26).
///
/// Datei-Eingaben stehen als `{path, text}` bzw. `{path, base64}`; die Fixture schreibt sie in einen temporären
/// Ordner (nur relative Pfade erscheinen im Ergebnis). Was in Swift vom Zeitpunkt abhängt, wird normalisiert:
/// Zeitstempel ab Laufbeginn → `"now"`, Stempel entfallen. Dateien kommen in einen Asset-Speicher mit
/// inhaltsabhängigen IDs (`ImportIDs.derived("asset", name, base64)`), damit IDs und Fingerabdrücke stabil sind.
/// Zufällige IDs (Markdown/CSV-Import) werden kanonisch umbenannt (`canonical`).
@MainActor
public enum ImportFixtures {
    typealias C = CoreFixtures
    typealias S = StoreFixtures

    // MARK: Hilfen

    /// Asset-Speicher mit stabilen IDs (für Fixtures; Swift-App: `FileAssetStore`).
    final class FixtureAssets: AssetStore {
        var files: [String: Data] = [:]
        func importFile(at url: URL) throws -> AssetRef {
            try importData(Data(contentsOf: url), name: url.lastPathComponent, mime: FileAssetStore.mime(for: url.pathExtension))
        }
        func importData(_ data: Data, name: String, mime: String?) throws -> AssetRef {
            let n = name.isEmpty ? "file" : name
            let ref = AssetRef(id: ImportIDs.derived("asset", n, data.base64EncodedString()), name: n, size: data.count,
                               mime: mime ?? FileAssetStore.mime(for: (n as NSString).pathExtension))
            files[ref.id] = data
            return ref
        }
        func url(for asset: AssetRef) -> URL? { nil }
        func contains(_ asset: AssetRef) -> Bool { files[asset.id] != nil }
    }

    typealias File = (path: String, data: Data)

    static func text(_ path: String, _ s: String) -> File { (path, Data(s.utf8)) }

    static func filesJSON(_ files: [File]) -> JSONValue {
        .array(files.map { f in
            if let s = String(data: f.data, encoding: .utf8), Data(s.utf8) == f.data, !f.path.lowercased().hasSuffix(".zip") {
                return ["path": .string(f.path), "text": .string(s)]
            }
            return ["path": .string(f.path), "base64": .string(f.data.base64EncodedString())]
        })
    }

    /// Schreibt Dateien in einen frischen temporären Ordner.
    static func materialize(_ files: [File]) -> URL {
        // Fester Ordnername „in“: Notion-HTML-Dateien ohne ID bekommen eine ID aus Datei- und Ordnername.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("based-fx-" + UUID().uuidString, isDirectory: true)
            .appendingPathComponent("in", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for f in files {
            let u = f.path.split(separator: "/").reduce(root) { $0.appendingPathComponent(String($1)) }
            try? FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? f.data.write(to: u)
        }
        return root
    }

    /// ZIP (gespeichert, feste Zeit) aus Dateien.
    static func zip(_ files: [File]) -> Data {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("based-fx-" + UUID().uuidString + ".zip")
        defer { try? FileManager.default.removeItem(at: u) }
        guard let w = try? ZipWriter(url: u, date: Date(timeIntervalSince1970: 1_700_000_000)) else { return Data() }
        for f in files { try? w.add(path: f.path, data: f.data) }
        try? w.finish()
        return (try? Data(contentsOf: u)) ?? Data()
    }

    static func reportJSON(_ r: ImportReport) -> JSONValue {
        ["pages": .number(Double(r.pages)), "databases": .number(Double(r.databases)), "rows": .number(Double(r.rows)),
         "assets": .number(Double(r.assets)), "warnings": .array(r.warnings.map(JSONValue.string)),
         "rootIDs": .array(r.rootIDs.map(JSONValue.string)), "keptLocalChanges": .number(Double(r.keptLocalChanges)),
         "keptLocalAdditions": .number(Double(r.keptLocalAdditions))]
    }

    /// Alle Records außer dem Workspace, sortiert (Art, ID); ohne Stempel; Zeiten ab `since` → "now".
    static func dump(_ store: WorkspaceStore, since: Date) -> JSONValue {
        let limit = since.timeIntervalSinceReferenceDate - 1
        func norm(_ v: JSONValue, key: String?) -> JSONValue {
            switch v {
            case .object(let o):
                var out: [String: JSONValue] = [:]
                for (k, x) in o where k != "stamp" { out[k] = norm(x, key: k) }
                return .object(out)
            case .array(let a): return .array(a.map { norm($0, key: nil) })
            case .number(let n):
                if let key, ["createdAt", "updatedAt", "trashedAt"].contains(key), n >= limit { return "now" }
                return v
            default: return v
            }
        }
        let rank: [RecordKind: Int] = [.database: 0, .view: 1, .block: 2]
        let records = store.allRecords().filter { $0.key.kind != .workspace }
            .sorted { (rank[$0.key.kind] ?? 9, $0.key.id) < (rank[$1.key.kind] ?? 9, $1.key.id) }
        return .array(records.map { norm(S.line($0), key: nil) })
    }

    /// Gibt zufälligen IDs kanonische Namen (Baum-Reihenfolge ab dem Workspace): Blöcke `b1…`, Datenbanken `db1…`,
    /// Ansichten `v1…`, Properties `p1…` (außer "title"), Optionen `o1…`, Status-Gruppen `g1…`. Ersetzt Werte,
    /// Schlüssel und Eltern-Verweise (`b:`/`d:`).
    static func canonical(_ store: WorkspaceStore, _ json: JSONValue) -> JSONValue {
        var map: [String: String] = [:]
        var n = (b: 0, db: 0, v: 0, p: 0, o: 0, g: 0)
        func visit(_ parent: ParentRef) {
            for id in store.children(of: parent) {
                guard let b = store.blocks[id] else { continue }
                n.b += 1; map[id] = "b\(n.b)"
                visit(.block(id))
                if let dbID = b.props.databaseID, let db = store.databases[dbID], db.blockID == id, map[dbID] == nil {
                    n.db += 1; map[dbID] = "db\(n.db)"
                    for p in db.properties where p.id != Database.titlePropertyID {
                        n.p += 1; map[p.id] = "p\(n.p)"
                        for o in p.options ?? [] { n.o += 1; map[o.id] = "o\(n.o)" }
                        for g in p.statusGroups ?? [] { n.g += 1; map[g.id] = "g\(n.g)" }
                    }
                    let views = store.views.values.filter { $0.databaseID == dbID }.sorted { ($0.sortKey, $0.name, $0.blockID) < ($1.sortKey, $1.name, $1.blockID) }
                    for v in views { n.v += 1; map[v.id] = "v\(n.v)" }
                    visit(.database(dbID))
                }
            }
        }
        visit(.workspace)
        func rename(_ s: String) -> String {
            if let m = map[s] { return m }
            for prefix in ["b:", "d:"] where s.hasPrefix(prefix) {
                if let m = map[String(s.dropFirst(2))] { return prefix + m }
            }
            return s
        }
        func walk(_ v: JSONValue) -> JSONValue {
            switch v {
            case .string(let s): return .string(rename(s))
            case .array(let a): return .array(a.map(walk))
            case .object(let o):
                var out: [String: JSONValue] = [:]
                for (k, x) in o { out[rename(k)] = walk(x) }
                return .object(out)
            default: return v
            }
        }
        // Nach dem Umbenennen neu sortieren (Art, neue ID).
        guard case .array(let list) = walk(json) else { return json }
        func key(_ r: JSONValue) -> (String, String) {
            guard case .object(let o) = r, case .string(let k)? = o["kind"], case .object(let d)? = o["data"], case .string(let id)? = d["id"] else { return ("", "") }
            return (k, id)
        }
        return .array(list.sorted { key($0) < key($1) })
    }

    /// Fälle `{op, …, result}` → Eingabe ohne `result`, Ausgabe = Liste der Ergebnisse.
    static func splitCase(_ name: String, _ items: [JSONValue]) -> JSONValue {
        let inputs: [JSONValue] = items.map { v in
            guard case .object(var o) = v else { return v }
            o["result"] = nil
            return .object(o)
        }
        return C.testCase(name, ["op": "helpers", "items": .array(inputs)], .array(items.map { $0["result"] ?? .null }))
    }

    // MARK: Notion-HTML (NotionHTMLImportTests)

    static let home = "11111111111111111111111111111111", tasks = "22222222222222222222222222222222",
               people = "33333333333333333333333333333333", rowA = "44444444444444444444444444444444",
               rowB = "55555555555555555555555555555555", ada = "66666666666666666666666666666666",
               sub = "77777777777777777777777777777777"
    static func dashed(_ h: String) -> String { ImportIDs.notion(h)! }

    static func notionPage(_ id: String, _ header: String, _ body: String, cls: String = "page sans") -> String {
        """
        <html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>x</title><style>body{}</style></head><body>\
        <article id="\(dashed(id))" class="\(cls)"><header>\(header)</header><div class="page-body">\(body)</div></article>\
        <span class="sans" style="font-size:14px;padding-top:2em"></span></body></html>
        """
    }

    /// Der Export aus `NotionHTMLImportTests.makeExport()`.
    static func notionExport() -> [File] {
        let homeBody = """
        <p id="a0000000-0000-4000-8000-000000000001" class="">Plain <strong>bold</strong> <em>it</em> <span style="border-bottom:0.05em solid">under</span> \
        <del>gone</del> <code>x()</code> <mark class="highlight-red">red</mark> <mark class="highlight-blue_background">blue bg</mark> \
        <a href="https://example.com">link</a> <a href="Home%20\(home)/Sub%20\(sub).html">Sub</a> <span class="user">@Ada Lovelace</span> \
        <time>@May 4, 2024</time> <span class="notion-text-equation-token"><span class="katex"><annotation encoding="application/x-tex">x^2</annotation></span></span></p>
        <p id="a0000000-0000-4000-8000-000000000002" class="block-color-purple">Purple line<br/>second line</p>
        <figure class="block-color-gray_background callout" style="white-space:pre-wrap;display:flex" id="a0000000-0000-4000-8000-000000000003">\
        <div style="font-size:1.5em"><span class="icon">💡</span></div><div style="width:100%">Callout <strong>text</strong></div></figure>
        <ul id="a0000000-0000-4000-8000-000000000004" class="toggle"><li><details open=""><summary style="font-weight:600;font-size:1.5em;line-height:1.3;margin:0">Toggle heading</summary>\
        <div class="indented"><p id="a0000000-0000-4000-8000-000000000005" class="">Hidden child</p></div></details></li></ul>
        <ol type="1" id="a0000000-0000-4000-8000-000000000006" class="numbered-list" start="1"><li>First</li></ol>\
        <ol type="1" id="a0000000-0000-4000-8000-000000000007" class="numbered-list" start="2"><li>Second<ul id="a0000000-0000-4000-8000-000000000008" class="bulleted-list"><li style="list-style-type:disc">Nested</li></ul></li></ol>
        <ul id="a0000000-0000-4000-8000-000000000009" class="to-do-list"><li><div class="checkbox checkbox-on"></div> <span class="to-do-children-checked">Shipped</span></li></ul>
        <blockquote id="a0000000-0000-4000-8000-000000000010" class="block-color-brown">Quote</blockquote><hr id="a0000000-0000-4000-8000-000000000011"/>
        <figure id="a0000000-0000-4000-8000-000000000012" class="equation"><div class="equation-container"><span class="katex-display"><span class="katex">\
        <span class="katex-mathml"><math><semantics><mrow></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span></span></span></div></figure>
        <div id="a0000000-0000-4000-8000-000000000013" class="column-list"><div id="a0000000-0000-4000-8000-000000000014" style="width:25%" class="column">\
        <p id="a0000000-0000-4000-8000-000000000015" class="">Left</p></div><div id="a0000000-0000-4000-8000-000000000016" style="width:75%" class="column">\
        <figure id="a0000000-0000-4000-8000-000000000017" class="image"><a href="Home%20\(home)/diagram.png"><img style="width:320px" src="Home%20\(home)/diagram.png"/></a><figcaption>The diagram</figcaption></figure></div></div>
        <figure id="a0000000-0000-4000-8000-000000000018"><a href="https://swift.org" class="bookmark source"><div class="bookmark-info"><div class="bookmark-text">\
        <div class="bookmark-title">Swift</div><div class="bookmark-description">The language</div></div><div class="bookmark-href">https://swift.org</div></div>\
        <img src="https://swift.org/og.png" class="bookmark-image"/></a></figure>
        <figure id="a0000000-0000-4000-8000-000000000019"><div class="source"><a href="Home%20\(home)/report.pdf">report.pdf</a></div></figure>
        <table id="a0000000-0000-4000-8000-000000000020" class="simple-table"><thead class="simple-table-header"><tr id="a0000000-0000-4000-8000-000000000021">\
        <th id="x1" class="simple-table-header-color simple-table-header">Key</th><th id="x2" class="simple-table-header-color simple-table-header">Value</th></tr></thead>\
        <tbody><tr id="a0000000-0000-4000-8000-000000000022"><td id="y1" class="">a</td><td id="y2" class=""><strong>1</strong></td></tr></tbody></table>
        <nav id="a0000000-0000-4000-8000-000000000023" class="block-color-gray table_of_contents"><div class="table_of_contents-item table_of_contents-indent-0">\
        <a class="table_of_contents-link" href="#a0000000-0000-4000-8000-000000000004">Toggle heading</a></div></nav>
        <pre id="a0000000-0000-4000-8000-000000000024" class="code code-wrap"><code class="language-JavaScript" style="white-space:pre-wrap">const a = 1;
        if (a &lt; 2) { log() }</code></pre>
        <figure id="a0000000-0000-4000-8000-000000000025" class="link-to-page"><a href="Home%20\(home)/Sub%20\(sub).html"><span class="icon">📄</span>Sub</a></figure>
        <figure id="a0000000-0000-4000-8000-000000000026" class="link-to-page"><a href="People%20\(people).html"><span class="icon">👥</span>People</a></figure>
        <div id="a0000000-0000-4000-8000-000000000027" class="collection-content"><h4 class="collection-title">Tasks</h4><table class="collection-content">\
        <thead><tr><th><span class="icon property-icon"><svg role="graphics-symbol" class="typesTitle"><path d=""></path></svg></span>Name</th>\
        <th><span class="icon property-icon"><svg class="typesStatus"></svg></span>Status</th><th><span class="icon property-icon"><svg class="typesMultipleSelect"></svg></span>Tags</th>\
        <th><span class="icon property-icon"><svg class="typesDate"></svg></span>Due</th><th><span class="icon property-icon"><svg class="typesNumber"></svg></span>Budget</th>\
        <th><span class="icon property-icon"><svg class="typesCheckbox"></svg></span>Done</th><th><span class="icon property-icon"><svg class="typesRelation"></svg></span>Owner</th></tr></thead><tbody>\
        <tr id="\(dashed(rowA))"><td class="cell-title"><a href="Home%20\(home)/Tasks%20\(tasks)/Write%20docs%20\(rowA).html"><span class="icon">📝</span>Write docs</a></td>\
        <td class="cell-AbCd"><span class="status-value select-value-color-green"><div class="status-dot status-dot-color-green"></div>Done</span></td>\
        <td class="cell-EfGh"><span class="selected-value select-value-color-blue">docs</span><span class="selected-value select-value-color-pink">urgent</span></td>\
        <td class="cell-IjKl"><time>@May 1, 2024</time></td><td class="cell-MnOp">$1,200.50</td><td class="cell-QrSt"><div class="checkbox checkbox-on"></div></td>\
        <td class="cell-UvWx"><a href="People%20\(people)/Ada%20\(ada).html">Ada</a></td></tr>\
        <tr id="\(dashed(rowB))"><td class="cell-title"><a href="Home%20\(home)/Tasks%20\(tasks)/Plan%20\(rowB).html">Plan</a></td>\
        <td class="cell-AbCd"><span class="status-value select-value-color-blue"><div class="status-dot status-dot-color-blue"></div>In progress</span></td>\
        <td class="cell-EfGh"><span class="selected-value select-value-color-blue">docs</span></td><td class="cell-IjKl"></td><td class="cell-MnOp">$80.00</td>\
        <td class="cell-QrSt"><div class="checkbox checkbox-off"></div></td><td class="cell-UvWx"></td></tr></tbody></table></div>
        <div class="mystery-widget" id="a0000000-0000-4000-8000-000000000028"><marquee>Fancy</marquee></div>
        """
        let homeHeader = """
            <img class="page-cover-image" src="https://www.notion.so/images/page-cover/gradients_8.png" style="object-position:center 40%"/>\
            <div class="page-header-icon page-header-icon-with-cover"><span class="icon">🏠</span></div><h1 class="page-title">Home</h1><p class="page-description"></p>
            """
        let rowAHeader = """
            <div class="page-header-icon undefined"><span class="icon">📝</span></div><h1 class="page-title">Write docs</h1><table class="properties"><tbody>\
            <tr class="property-row property-row-status"><th>Status</th><td><span class="status-value select-value-color-green">Done</span></td></tr>\
            <tr class="property-row property-row-multi_select"><th>Tags</th><td><span class="selected-value select-value-color-blue">docs</span><span class="selected-value select-value-color-pink">urgent</span></td></tr>\
            <tr class="property-row property-row-date"><th>Due</th><td><time>@May 1, 2024</time></td></tr>\
            <tr class="property-row property-row-number"><th>Budget</th><td>$1,200.50</td></tr>\
            <tr class="property-row property-row-checkbox"><th>Done</th><td><div class="checkbox checkbox-on"></div></td></tr>\
            <tr class="property-row property-row-relation"><th>Owner</th><td><a href="../../People%20\(people)/Ada%20\(ada).html">Ada</a></td></tr>\
            <tr class="property-row property-row-created_time"><th>Created</th><td>March 3, 2024 9:15 AM</td></tr>\
            <tr class="property-row property-row-auto_increment_id"><th>ID</th><td>TASK-7</td></tr>\
            <tr class="property-row property-row-formula"><th>Score</th><td>42</td></tr></tbody></table>
            """
        let peopleHTML = """
        <html><body><article id="\(dashed(people))" class="page sans"><header><div class="page-header-icon undefined"><span class="icon">👥</span></div>\
        <h1 class="page-title">People</h1><p class="page-description">Everyone on the team</p></header><table class="collection-content"><thead><tr>\
        <th><span class="icon property-icon"><svg class="typesTitle"></svg></span>Name</th><th><span class="icon property-icon"><svg class="typesEmail"></svg></span>Email</th></tr></thead>\
        <tbody><tr id="\(dashed(ada))"><td class="cell-title"><a href="People%20\(people)/Ada%20\(ada).html">Ada</a></td><td class="cell-Em"><a href="mailto:ada@example.com" class="email-value">ada@example.com</a></td></tr></tbody></table></article></body></html>
        """
        return [
            text("Home \(home).html", notionPage(home, homeHeader, homeBody, cls: "page serif")),
            ("Home \(home)/diagram.png", Data([0x89, 0x50, 0x4E, 0x47, 1, 2, 3])),
            text("Home \(home)/report.pdf", "pdf"),
            text("Home \(home)/Sub \(sub).html", notionPage(sub, "<h1 class=\"page-title\">Sub</h1>", "<p>Sub body</p>")),
            text("Home \(home)/Tasks \(tasks)/Write docs \(rowA).html", notionPage(rowA, rowAHeader, "<p id=\"b0000000-0000-4000-8000-000000000001\">Row body text</p>")),
            text("People \(people).html", peopleHTML),
        ]
    }

    static let wiki = "88888888888888888888888888888888", elsewhere = "99999999999999999999999999999999",
               zeta = "cccccccccccccccccccccccccccccccc", zetaRow = "dddddddddddddddddddddddddddddddd",
               loose = "77777777777777777777777777777770", inv1 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeee1", inv2 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeee2"

    /// Sonderfälle: Notion-Links, eingebettete Daten, Medien, Listen mit Absätzen, Überschriften-Toggles, Definitionen,
    /// Mermaid, Spalten mit calc(), Callout mit Bild-Icon, verlinkte Datenbank (später importiert), Properties ohne
    /// Zeilenseiten, Relation ohne Ziel, nicht verlinkte Unterseite, index.html.
    static func notionExtraExport() -> [File] {
        func bid(_ n: Int) -> String { String(format: "f0000000-0000-4000-8000-%012d", n) }
        let body = """
        <figure id="\(bid(1))" class="link-to-page"><a href="https://www.notion.so/team/Elsewhere-\(elsewhere)">Elsewhere</a></figure>
        <p id="\(bid(2))">See <a href="https://www.notion.so/Elsewhere-\(elsewhere)?pvs=4">Elsewhere</a>, <a href="#\(bid(1))">anchor</a>, \
        <a href="mailto:x@example.com">mail</a>, <span class="highlight-teal_background">teal</span> <sub>sub</sub> <kbd>⌘K</kbd> \
        <a href="Wiki%20\(wiki)/Loose%20\(loose).html">Loose page title</a> <a href="Wiki%20\(wiki)/Loose%20\(loose).html">Other words</a></p>
        <figure id="\(bid(3))" class="image"><img src="data:image/png;base64,iVBORw0KGgo="/></figure>
        <figure id="\(bid(4))"><div class="source"><a href="https://www.youtube.com/watch?v=abc">https://www.youtube.com/watch?v=abc</a></div></figure>
        <figure id="\(bid(5))"><div class="source"><a href="Wiki%20\(wiki)/song.mp3">song.mp3</a></div></figure>
        <figure id="\(bid(6))"><div class="source"><a href="https://example.com/doc">Doc</a></div><figcaption>A <em>caption</em></figcaption></figure>
        <figure id="\(bid(7))"><div class="source"><a href="Wiki%20\(wiki)/missing.zip">The archive</a></div></figure>
        <ul id="\(bid(8))" class="bulleted-list"><li><p>Para in li</p><p>second para</p></li></ul>
        <ul id="\(bid(9))" class="toggle"><li><details open=""><summary><h3>H3 toggle</h3></summary><p id="\(bid(10))">inside</p></details></li></ul>
        <details id="\(bid(11))"><summary>Plain toggle</summary><div class="indented"><p id="\(bid(12))">kid</p></div></details>
        <dl><dt>Term</dt><dd>Definition</dd></dl>
        <nav id="\(bid(13))" class="breadcrumb">Wiki</nav>
        <iframe id="\(bid(14))" src="https://maps.example.com/embed"></iframe>
        <pre id="\(bid(15))" class="code"><code class="language-Mermaid">graph TD; A--&gt;B
        </code></pre>
        <pre id="\(bid(16))" class="code"><code class="language-Plain_Text">x</code></pre>
        <pre id="\(bid(17))" class="code"><code class="language-Shell">ls -la</code></pre>
        <img id="\(bid(18))" src="https://example.com/x.png" width="200"/>
        <div id="\(bid(19))" class="column-list"><div id="\(bid(20))" style="width:calc((100% - 46px) * 0.5)" class="column"><p>One</p></div>\
        <div id="\(bid(21))" style="width:calc((100% - 46px) * 0.5)" class="column"><p>Two</p></div></div>
        <p id="\(bid(22))"></p>
        <blockquote id="\(bid(23))">Quote head<p>nested para</p></blockquote>
        <figure id="\(bid(24))" class="callout"><div><img class="icon" src="Wiki%20\(wiki)/icon.png"/></div><div><p>Callout para</p><ul><li>item</li></ul></div></figure>
        <div id="\(bid(25))" class="collection-content"><h4 class="collection-title">Inventory</h4><table class="collection-content"><thead><tr>\
        <th><span class="icon property-icon"><svg class="typesTitle"></svg></span>Name</th>\
        <th><span class="icon property-icon"><svg class="typesSelect"></svg></span>Category</th>\
        <th><span class="icon property-icon"><svg class="typesUrl"></svg></span>Link</th>\
        <th><span class="icon property-icon"><svg class="typesPhoneNumber"></svg></span>Phone</th>\
        <th><span class="icon property-icon"><svg class="typesPerson"></svg></span>Who</th>\
        <th><span class="icon property-icon"><svg class="typesFile"></svg></span>Files</th>\
        <th><span class="icon property-icon"><svg class="typesCreatedBy"></svg></span>Made by</th>\
        <th><span class="icon property-icon"><svg class="typesLastEditedTime"></svg></span>Edited</th>\
        <th><span class="icon property-icon"><svg class="typesFormula"></svg></span>Calc</th>\
        <th><span class="icon property-icon"><svg class="typesRollup"></svg></span>Sum</th>\
        <th><span class="icon property-icon"><svg class="typesRelation"></svg></span>Related</th>\
        <th>Share</th><th>Notes</th><th>Flag</th><th>Kinds</th></tr></thead><tbody>\
        <tr id="\(dashed(inv1))"><td class="cell-title"><a href="https://www.notion.so/Item-\(inv1)">Chair</a></td>\
        <td class="cell-a"><span class="selected-value select-value-color-orange">Furniture</span></td>\
        <td class="cell-b"><a href="https://example.com/chair" class="url-value">example.com/chair</a></td>\
        <td class="cell-c"><a href="tel:+49 30 1234" class="phone-value">+49 30 1234</a></td>\
        <td class="cell-d"><span class="user">@Grace Hopper</span><span class="user">@Alan</span></td>\
        <td class="cell-e"><a href="Wiki%20\(wiki)/icon.png">icon.png</a><a href="https://example.com/spec.pdf">Spec</a></td>\
        <td class="cell-f"><span class="user">@Grace Hopper</span></td>\
        <td class="cell-g">May 2, 2024 3:00 PM</td><td class="cell-h">12</td><td class="cell-i">a, b</td>\
        <td class="cell-j"><a href="Other%20\(elsewhere)/Thing%2011111111111111111111111111111112.html">Thing</a></td>\
        <td class="cell-k">25%</td><td class="cell-l">Plain <strong>notes</strong></td><td class="cell-m"><div class="checkbox checkbox-on"></div></td>\
        <td class="cell-n"><span class="selected-value select-value-color-red">x</span><span class="selected-value select-value-color-gray">y</span></td></tr>\
        <tr id="\(dashed(inv2))"><td class="cell-title"><a href="https://www.notion.so/Item-\(inv2)">Lamp</a></td>\
        <td class="cell-a"><span class="selected-value select-value-color-orange">Furniture</span></td><td class="cell-b"></td><td class="cell-c"></td>\
        <td class="cell-d"></td><td class="cell-e">a.txt, b.txt</td><td class="cell-f"></td><td class="cell-g"></td><td class="cell-h">7.5</td><td class="cell-i"></td>\
        <td class="cell-j"></td><td class="cell-k">5%</td><td class="cell-l"></td><td class="cell-m"><div class="checkbox checkbox-off"></div></td>\
        <td class="cell-n"><span class="selected-value select-value-color-red">x</span></td></tr></tbody></table></div>
        <div id="\(bid(26))" class="collection-content"><h4 class="collection-title">Zeta view</h4><table class="collection-content"><thead><tr>\
        <th><span class="icon property-icon"><svg class="typesTitle"></svg></span>Name</th><th>Stage</th></tr></thead><tbody>\
        <tr id="\(dashed(zetaRow))"><td class="cell-title"><a href="Zeta%20\(zeta)/Row%20\(zetaRow).html">Row</a></td><td class="cell-s">Alpha</td></tr></tbody></table></div>
        """
        let zetaHTML = """
        <html><body><article id="\(dashed(zeta))" class="page sans full-width small-text"><header><h1 class="page-title">Zeta</h1></header>\
        <div class="page-body"><table class="collection-content"><thead><tr><th><span class="icon property-icon"><svg class="typesTitle"></svg></span>Name</th>\
        <th><span class="icon property-icon"><svg class="typesStatus"></svg></span>Stage</th><th>Priority</th></tr></thead><tbody>\
        <tr id="\(dashed(zetaRow))"><td class="cell-title"><a href="Zeta%20\(zeta)/Row%20\(zetaRow).html"><img class="icon" src="Zeta%20\(zeta)/row.png"/>Row</a></td>\
        <td class="cell-s"><span class="status-value select-value-color-gray">Alpha</span></td><td class="cell-p">High</td></tr></tbody></table></div></article></body></html>
        """
        let zetaRowHTML = notionPage(zetaRow, """
            <h1 class="page-title">Row</h1><table class="properties"><tbody>\
            <tr class="property-row property-row-status"><th>Stage</th><td><span class="status-value select-value-color-gray">Alpha</span></td></tr>\
            <tr class="property-row property-row-select"><th>Priority</th><td><span class="selected-value select-value-color-red">High</span></td></tr>\
            <tr class="property-row property-row-created_by"><th>Owner</th><td><span class="user">@Ada</span></td></tr>\
            <tr class="property-row property-row-unique_id"><th>Ref</th><td>Z-3</td></tr>\
            <tr class="property-row"><th>Hidden extra</th><td>value</td></tr></tbody></table>
            """, "<p>Row content</p>")
        return [
            text("index.html", "<html><body><a href=\"Wiki%20\(wiki).html\">Wiki</a></body></html>"),
            text("Wiki \(wiki).html", notionPage(wiki, "<div class=\"page-header-icon\"><img class=\"icon\" src=\"Wiki%20\(wiki)/icon.png\"/></div><h1 class=\"page-title\">Wiki</h1>", body, cls: "page mono")),
            text("Wiki \(wiki)/icon.png", "PNG-ICON"),
            text("Wiki \(wiki)/song.mp3", "MP3"),
            text("Wiki \(wiki)/Loose \(loose).html", notionPage(loose, "<h1 class=\"page-title\">Loose page title</h1>", "<p>Nobody links me</p>")),
            text("Zeta \(zeta).html", zetaHTML),
            text("Zeta \(zeta)/row.png", "ROW-PNG"),
            text("Zeta \(zeta)/Row \(zetaRow).html", zetaRowHTML),
        ]
    }

    static func genericHTML() -> [File] {
        [text("notes.html", """
        <!doctype html><html><head><title>My notes</title></head><body>
          <h1>Intro</h1>
          <p>Some
             <b>text</b> here</p>
          <ul><li>one</li><li>two</li></ul>
          <svg width="10" height="10"><circle r="4"/></svg>
          <section><p>In a section</p><span>loose span</span></section>
          <div class="mystery">plain <i>words</i></div>
          <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>
          <video src="clip.mp4"></video>
        </body></html>
        """)]
    }

    /// Import in einen leeren Store (bzw. `store`), Ergebnis: Records + Bericht.
    static func importCase(_ name: String, _ files: [File], items: [String], store existing: WorkspaceStore? = nil, canonical canon: Bool = false) -> JSONValue {
        let start = Date()
        let root = materialize(files)
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let store = existing ?? WorkspaceStore(persistence: MemoryPersistence(), node: "fx")
        let assets = FixtureAssets()
        let urls = items.map { $0.isEmpty ? root : root.appendingPathComponent($0) }
        var out: [String: JSONValue] = [:]
        do {
            let r = try NotionImporter(store: store, assets: assets).importItems(urls)
            out["report"] = reportJSON(r)
        } catch {
            out["error"] = .string(String(describing: error))
        }
        let d = dump(store, since: start)
        out["records"] = canon ? canonical(store, d) : d
        if canon, case .array(let ids)? = (out["report"]?.object?["rootIDs"]) {
            // Wurzel-IDs sind zufällig: nur ihre Anzahl zählt.
            var r = out["report"]!.object!
            r["rootIDs"] = .number(Double(ids.count))
            out["report"] = .object(r)
        }
        out["assets"] = .array(assets.files.keys.sorted().map { .string($0) })
        return C.testCase(name, ["files": filesJSON(files), "items": .array(items.map(JSONValue.string)), "canonical": .bool(canon)], .object(out))
    }

    public static func notionHTML() -> JSONValue {
        var cases: [JSONValue] = []
        cases.append(importCase("Notion-HTML-Export (NotionHTMLImportTests)", notionExport(), items: [""]))
        cases.append(importCase("Notion-HTML-Export: Sonderfälle", notionExtraExport(), items: [""]))
        cases.append(importCase("Einzelne HTML-Seite mit Ordner", notionExport(), items: ["Home \(home).html"]))
        cases.append(importCase("Generisches HTML", genericHTML(), items: ["notes.html"]))
        // ZIP mit verschachteltem Teil-Archiv (Notion: Export-…-Part-1.zip)
        let inner = zip(notionExport())
        cases.append(importCase("ZIP mit verschachteltem Teil-Archiv", [("Export-abc.zip", zip([("Export-abc-Part-1.zip", inner)]))], items: ["Export-abc.zip"]))
        // Reimport (NotionHTMLImportTests.reimportUpdatesInPlace): Schritte auf demselben Store.
        do {
            let start = Date()
            let root = materialize(notionExport())
            defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
            let store = WorkspaceStore(persistence: MemoryPersistence(), node: "fx")
            var steps: [JSONValue] = []
            func snapshot(_ r: ImportReport?) {
                var o: [String: JSONValue] = ["blockCount": .number(Double(store.blocks.count)),
                                              "homeTitle": .string(store.blocks[dashed(home)]?.text.plainText ?? ""),
                                              "local": .string(store.blocks["local-1"]?.text.plainText ?? "-")]
                if let r { o["report"] = reportJSON(r) }
                steps.append(.object(o))
            }
            snapshot(try? NotionImporter(store: store, assets: FixtureAssets()).importItems([root]))
            store.transact("edit") { tx in tx.update(dashed(home)) { $0.text = RichText("Renamed") } }
            store.transact("add") { tx in tx.put(Block(id: "local-1", type: .text, parent: .block(dashed(home)), sortKey: "zz", text: "stale")) }
            snapshot(nil)
            snapshot(try? NotionImporter(store: store, assets: FixtureAssets()).importItems([root]))
            store.transact("undo rename") { tx in tx.update(dashed(home)) { $0.text = RichText("Home") } }
            snapshot(try? NotionImporter(store: store, assets: FixtureAssets()).importItems([root]))
            cases.append(C.testCase("Reimport: lokale Änderungen bleiben (BSD-32)",
                                    ["files": filesJSON(notionExport()), "steps": ["import", "edit home → Renamed, add local-1 (sk zz)", "import", "edit home → Home", "import"]],
                                    ["steps": .array(steps), "records": dump(store, since: start)]))
        }
        // ImportIDs & Hilfen
        var ids: [JSONValue] = []
        for raw in ["1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D", "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d", "xyz", "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6"] {
            ids.append(["op": "notion", "raw": .string(raw), "result": ImportIDs.notion(raw).map(JSONValue.string) ?? .null])
        }
        for name in ["Project Plan 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.html", "https://www.notion.so/team/Plan-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?v=ffffffffffffffffffffffffffffffff",
                     "Plan%201a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.html", "a 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d b 11111111111111111111111111111111", "no id here.html",
                     "two 11111111111111111111111111111111 then 22222222222222222222222222222222.html", "too long 111111111111111111111111111111111.html"] {
            ids.append(["op": "notionID", "raw": .string(name), "result": ImportIDs.notionID(inName: name).map(JSONValue.string) ?? .null])
        }
        for parts in [["a", "b"], ["ab"], ["html-file", "Home.html", "root"], [""], ["Ünïcødé", "🚀", "x"]] {
            ids.append(["op": "derived", "parts": .array(parts.map(JSONValue.string)), "result": .string(ImportIDs.derived(parts))])
        }
        for w in ["50%", "calc((100% - 46px) * 0.5)", "calc((100% - 92px) * 0.3333)", "200px"] {
            ids.append(["op": "columnRatio", "raw": .string(w), "result": NotionHTMLImporter.columnRatio(w).map(JSONValue.number) ?? .null])
        }
        for t in ["Project Plan 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", "Tasks 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d_all.csv", "Notes.md", "  Plain  "] {
            ids.append(["op": "cleanTitle", "raw": .string(t), "result": .string(NotionImporter.cleanTitle(t))])
        }
        cases.append(splitCase("ImportIDs und Hilfen", ids))
        return C.file("import", cases, meta: ["note": .string("Import über NotionImporter.importItems in einen leeren Store (node fx, userID me) mit Asset-Speicher (ID = ImportIDs.derived(\"asset\", name, base64)). records: alle Records außer Workspace, sortiert (database, view, block; id), ohne stamp; Zeiten ab Laufbeginn = \"now\". canonical: zufällige IDs umbenannt (siehe ImportFixtures.canonical).")])
    }

    // MARK: Markdown, CSV, Notion-Markdown-Export

    static let markdownSamples: [(String, String)] = [
        ("Absätze und Überschriften", "# H1\n## H2\n### H3\n#### H4\nText with **bold**, *it*, ~~del~~, `code`, <u>under</u>\n\nSecond paragraph<br>line two"),
        ("Listen", "- a\n- b\n    - nested\n        - deeper\n* star\n+ plus\n• dot\n1. one\n2) two\n- [ ] open\n- [x] done\n* [X] DONE\n- [ ]\n-\n10. ten"),
        ("Code und Gleichung", "```Swift\nlet x = 1\n  indented\n```\n```\nplain\n```\n$$\nE=mc^2\n$$\n$$a+b$$"),
        ("Toggle und Callout (Notion)", "<details>\n<summary>Toggle **title**</summary>\n\nInside\n\n<details><summary>Inner</summary>\ndeep\n</details>\n</details>\n<aside>\n💡 Callout text\nmore\n</aside>\n<aside>No icon</aside>"),
        ("Tabelle", "| A | B |\n| --- | :-: |\n| 1 | **2** |\n| x \\| y | |\n| only |"),
        ("Zitat und Hinweise", "> quoted\n> lines\n\n> [!NOTE] Note text\n> more\n\n> [!warning]\n> careful\n\n> [!unknown] x"),
        ("Bilder und Links", "![Alt](images/pic%201.png)\n![](https://example.com/a.png)\n[Sub page](Sub%20Page%20abc.md)\n[a](x) and [b](y)\n[link](https://example.com)"),
        ("Einrückung und Trenner", "para\n    indented child\n---\n***\n___\n  - indented list\n      - child"),
        ("Leer", ""),
        ("Einrückung nach Code (Swift: Code-Block fällt weg)", "```\nx\n```\n    indented after code\nnext"),
    ]

    static let inlineSamples: [String] = [
        "plain", "**bold** and *it* and _it2_ and __b2__", "snake_case_name", "a * b * c", "`code with *stars*`", "~~strike~~ ~one~",
        "<u>under</u> <b>b</b> <i>i</i>", "$x^2$ and $ not math$", "\\*escaped\\* \\[x\\]", "[label **bold**](https://e.com) [page](Page.md)",
        "line<br>break<br/>end", "**unclosed", "[broken](", "nested **bold *and it***", "emoji 🚀 **ü**",
    ]

    static func importedJSON(_ b: ImportedBlock) -> JSONValue {
        var o: [String: JSONValue] = ["type": .string(b.type.rawValue), "text": C.json(b.text), "children": .array(b.children.map(importedJSON))]
        if b.props != BlockProps() { o["props"] = C.json(b.props) }
        if let l = b.linkTarget { o["linkTarget"] = .string(l) }
        return .object(o)
    }

    static func notionMarkdownExport() -> [File] {
        let h = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", t = "aaaabbbbccccddddeeeeffff00001111"
        return [
            text("Projects \(h).md", "# Projects\n\nIntro with **bold** and a [link](https://example.com).\n\n[Sub Page](Projects%20\(h)/Sub%20Page%20\(h).md)\n\n[Tasks](Projects%20\(h)/Tasks%20\(t).csv)\n\n![image.png](Projects%20\(h)/image.png)\n\n- [x] done item\n- open item\n\n<aside>\n🚀 Ship it\n</aside>\n"),
            text("Projects \(h)/Sub Page \(h).md", "# Sub Page\n\nSub content linking back to [Projects](../Projects%20\(h).md).\n"),
            text("Projects \(h)/Tasks \(t).csv", "Name,Status,Points,Done,Due,Tags,Site\nWrite docs,Doing,3,Yes,\"May 1, 2024\",\"docs, urgent\",https://a.example\nPlan,Done,\"1,000\",No,,docs,https://b.example\n"),
            text("Projects \(h)/Tasks \(t)_all.csv", "Name,Status,Points,Done,Due,Tags,Site\nWrite docs,Doing,3,Yes,\"May 1, 2024\",\"docs, urgent\",https://a.example\nPlan,Done,\"1,000\",No,,docs,https://b.example\nExtra,Doing,2,No,,urgent,https://c.example\n"),
            text("Projects \(h)/Tasks \(t)/Write docs \(h).md", "# Write docs\n\nStatus: Doing\nPoints: 3\n\nRow body with details.\n"),
            ("Projects \(h)/image.png", Data([0x89, 0x50, 0x4E, 0x47, 9, 9])),
            text("Projects \(h)/Orphan \(h).md", "# 📌 Orphan\n\nNot linked from anywhere.\n"),
            text("Readme.txt", "Just text\n\n## Heading"),
            text("data.json", "{}"),
            ("photo.jpg", Data([1, 2, 3])),
        ]
    }

    public static func markdown() -> JSONValue {
        var cases: [JSONValue] = []
        let resolveLink: (String) -> RecordID? = { $0 == "Page.md" || $0 == "Sub%20Page%20abc.md" ? "page-1" : nil }
        let resolveAsset: (String) -> (url: String?, asset: AssetRef?) = { src in
            src.hasPrefix("images/") ? (url: nil, asset: AssetRef(id: "asset-1", name: (src as NSString).lastPathComponent)) : (url: src, asset: nil)
        }
        let importer = MarkdownImporter(resolveLink: resolveLink, resolveAsset: resolveAsset)
        for (name, md) in markdownSamples {
            let (title, body) = MarkdownImporter.splitTitle(md)
            cases.append(C.testCase("parse: " + name, ["op": "parse", "markdown": .string(md)],
                                    ["blocks": .array(importer.parse(md).map(importedJSON)),
                                     "splitTitle": ["title": title.map(JSONValue.string) ?? .null, "body": .string(body)]]))
        }
        var inline: [JSONValue] = [], inlineIn: [JSONValue] = []
        for s in inlineSamples {
            let rt = InlineMarkdownCodec.decode(s, resolveLink: resolveLink)
            inlineIn.append(["source": .string(s)])
            inline.append(["decoded": C.json(rt),
                           "reencoded": .string(InlineMarkdownCodec.encode(rt, pageLink: { id in id == "page-1" ? ("Page", "Page.md") : nil }))])
        }
        // Encode aus RichText mit allen Läufen
        let rich = RichText(runs: [TextRun("plain "), TextRun(" bold ", marks: { var m = Marks.plain; m.bold = true; return m }()),
                                   TextRun("all", marks: { var m = Marks.plain; m.bold = true; m.italic = true; m.strikethrough = true; m.underline = true; m.code = true; m.link = "https://x.y"; return m }()),
                                   TextRun("Page", mention: .page("page-1")), TextRun("Gone", mention: .page("page-2")), TextRun("@ada", mention: .user("ada")),
                                   TextRun("x", equation: "x^2"), TextRun("lnk", mention: .link("https://l.ink")), TextRun("   "), TextRun("*_`~[]\\$")])
        inlineIn.append(["rich": C.json(rich)])
        inline.append(["reencoded": .string(InlineMarkdownCodec.encode(rich, pageLink: { id in id == "page-1" ? ("Page", "Page.md") : nil }))])
        cases.append(C.testCase("Inline-Markdown", ["op": "inline", "items": .array(inlineIn)], .array(inline)))
        // CSV
        var csv: [JSONValue] = []
        for s in ["a,b,c\n1,2,3\n", "\u{FEFF}\"x, y\",\"say \"\"hi\"\"\"\r\nz,\"multi\nline\"\n\n", "single", "a,,b\n,\n", "trailing,\"open"] {
            csv.append(["op": "decode", "text": .string(s), "result": .array(CSV.decode(s).map { .array($0.map(JSONValue.string)) })])
        }
        csv.append(["op": "encode", "rows": [["a", "b,c", "d\"e"], ["line\nbreak", ""]], "result": .string(CSV.encode([["a", "b,c", "d\"e"], ["line\nbreak", ""]]))])
        let columns: [(String, [String])] = [("Status", ["x"]), ("Done", ["Yes", "No", ""]), ("Points", ["1,000", "2.5"]), ("Due", ["May 1, 2024", "2024-05-02"]),
                                             ("Site", ["https://a", "http://b"]), ("Mail", ["a@b.c", "d@e.f"]), ("Tags", ["a, b", "a"]), ("Kind", ["x", "x", "y", "x"]),
                                             ("Notes", ["long text one", "long text two"]), ("Tag list", ["solo"]), ("Link", ["[A](A.md)", "b"]), ("Empty", ["", " "])]
        for (name, col) in columns {
            csv.append(["op": "inferType", "name": .string(name), "column": .array(col.map(JSONValue.string)), "result": .string(NotionImporter.inferType(name: name, col).rawValue)])
        }
        cases.append(splitCase("CSV", csv))
        // Notion-Markdown/CSV-Export: Ordner und ZIP
        cases.append(importCase("Notion-Markdown-Export (Ordner)", notionMarkdownExport(), items: [""], canonical: true))
        let inner = zip(notionMarkdownExport())
        cases.append(importCase("Notion-Markdown-Export (ZIP mit Teil-Archiv)", [("Export-md.zip", zip([("Export-md-Part-1.zip", inner)]))], items: ["Export-md.zip"], canonical: true))
        cases.append(importCase("Einzelne Markdown- und CSV-Dateien", notionMarkdownExport(),
                                items: ["Projects 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d/Sub Page 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.md", "Readme.txt", "data.json",
                                        "Projects 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d/Tasks aaaabbbbccccddddeeeeffff00001111.csv"], canonical: true))
        return C.file("import", cases, meta: ["note": .string("parse: MarkdownImporter (Links Page.md und Sub%20Page%20abc.md → page-1, Bilder unter images/ → Asset asset-1); ImportedBlock ohne id. Notion-Markdown: NotionImporter.importItems, kanonische IDs.")])
    }

    // MARK: Reimport-Schutz (ReimportProtectionTests, BSD-32)

    public static func reimport() -> JSONValue {
        let page = "11111111-0000-0000-0000-000000000001", sub = "11111111-0000-0000-0000-000000000002"
        func id(_ n: Int) -> RecordID { "22222222-0000-0000-0000-" + String(format: "%012d", n) }
        func source(_ texts: [Int: String], subPage: Bool, nested: [Int: [Int: String]], nestedPage: Int?) -> ImportBuilder {
            let b = ImportBuilder()
            b.add(Block(id: page, type: .page, parent: .workspace, sortKey: "", text: "Notes", createdAt: S.t0), root: true)
            for n in texts.keys.sorted() {
                b.append(.text, in: .block(page), id: id(n), text: RichText(texts[n]!), createdAt: S.t0)
                for (m, t) in (nested[n] ?? [:]).sorted(by: { $0.key < $1.key }) {
                    b.append(.text, in: .block(id(n)), id: id(m), text: RichText(t), createdAt: S.t0)
                }
                if nestedPage == n { b.append(.page, in: .block(id(n)), id: sub, text: "Inside", createdAt: S.t0) }
                b.markComplete(.block(id(n)))
            }
            if subPage { b.append(.page, in: .block(page), id: sub, text: "Sub", createdAt: S.t0) }
            b.markComplete(.block(page))
            return b
        }
        enum Op { case commit([Int: String], sub: Bool, nested: [Int: [Int: String]], nestedPage: Int?), setText(Int, String), insert(String, parent: Int?, text: String), strip([Int]), undo }
        let scenarios: [(String, [Op])] = [
            ("unverändert wird überschrieben", [.commit([1: "a", 2: "b"], sub: true, nested: [:], nestedPage: nil), .commit([1: "a2", 2: "b2"], sub: true, nested: [:], nestedPage: nil)]),
            ("lokal geänderter Block bleibt", [.commit([1: "a", 2: "b"], sub: true, nested: [:], nestedPage: nil), .setText(1, "edited in Based"),
                                               .commit([1: "changed in Notion", 2: "b2"], sub: true, nested: [:], nestedPage: nil),
                                               .commit([1: "again", 2: "b3"], sub: true, nested: [:], nestedPage: nil)]),
            ("lokal hinzugefügte Blöcke bleiben", [.commit([1: "a"], sub: true, nested: [:], nestedPage: nil), .insert("mine", parent: nil, text: "my own note"),
                                                   .insert("child", parent: 1, text: "nested note"), .commit([1: "a2"], sub: true, nested: [:], nestedPage: nil)]),
            ("in Notion gelöscht: nur unverändert weg", [.commit([1: "a", 2: "b", 3: "c", 4: "d"], sub: true, nested: [4: [5: "inside d"]], nestedPage: nil),
                                                         .setText(2, "edited b"), .insert("note", parent: 4, text: "mine"),
                                                         .commit([1: "a"], sub: false, nested: [:], nestedPage: nil)]),
            ("entfernter Block rettet Unterseite in den Papierkorb", [.commit([1: "a", 2: "toggle"], sub: false, nested: [:], nestedPage: 2),
                                                                      .commit([1: "a"], sub: false, nested: [:], nestedPage: nil)]),
            ("ältere Importe ohne Fingerabdruck", [.commit([1: "a", 2: "b"], sub: true, nested: [:], nestedPage: nil), .strip([1, 2]),
                                                   .commit([1: "a2"], sub: true, nested: [:], nestedPage: nil)]),
            ("Reimport ist ein Undo-Schritt", [.commit([1: "a"], sub: true, nested: [:], nestedPage: nil), .commit([1: "a2"], sub: true, nested: [:], nestedPage: nil), .undo]),
        ]
        var cases: [JSONValue] = []
        for (name, ops) in scenarios {
            let start = Date()
            let s = WorkspaceStore(persistence: MemoryPersistence(), node: "fx")
            var inSteps: [JSONValue] = [], outSteps: [JSONValue] = []
            for op in ops {
                var result: JSONValue = .null
                switch op {
                case .commit(let texts, let subPage, let nested, let nestedPage):
                    let r = s.commitImport(source(texts, subPage: subPage, nested: nested, nestedPage: nestedPage))
                    result = reportJSON(r)
                    func obj(_ d: [Int: String]) -> JSONValue { .object(Dictionary(uniqueKeysWithValues: d.map { (String($0.key), JSONValue.string($0.value)) })) }
                    inSteps.append(["op": "commit", "texts": obj(texts), "subPage": .bool(subPage),
                                    "nested": .object(Dictionary(uniqueKeysWithValues: nested.map { (String($0.key), obj($0.value)) })),
                                    "nestedPage": nestedPage.map { .number(Double($0)) } ?? .null])
                case .setText(let n, let t):
                    s.setText(id(n), RichText(t)); inSteps.append(["op": "setText", "n": .number(Double(n)), "text": .string(t)])
                case .insert(let lid, let parent, let t):
                    let p: ParentRef = parent.map { .block(id($0)) } ?? .block(page)
                    s.transact("Insert") { tx in tx.put(Block(id: lid, type: .text, parent: p, sortKey: "zz", text: RichText(t))) }
                    inSteps.append(["op": "insert", "id": .string(lid), "parent": parent.map { .number(Double($0)) } ?? .null, "text": .string(t)])
                case .strip(let ns):
                    s.transact("strip", undoable: false) { tx in for n in ns { tx.update(id(n)) { $0.extra[Block.importFingerprintKey] = nil } } }
                    inSteps.append(["op": "strip", "ns": .array(ns.map { .number(Double($0)) })])
                case .undo:
                    s.undo(); inSteps.append(["op": "undo"])
                }
                outSteps.append(["result": result, "records": dump(s, since: start)])
            }
            cases.append(C.testCase(name, .array(inSteps), .array(outSteps)))
        }
        // Fingerabdrücke einzelner Blöcke (VersionHistory.encode + hash, Swift-JSON mit "\/").
        var blocks: [JSONValue] = [], prints: [JSONValue] = []
        for r in (try? RecordFixtures.corpus()) ?? [] {
            guard case .block(let b) = r else { continue }
            blocks.append(S.line(r)); prints.append(.string(b.contentFingerprint))
        }
        cases.append(C.testCase("Fingerabdrücke (Record-Korpus)", ["op": "fingerprints", "records": .array(blocks)], .array(prints)))
        return C.file("reimport", cases, meta: ["note": .string("ImportBuilder (createdBy me) + commitImport in einen leeren Store (node fx). Seite \(page), Blöcke 22222222-0000-0000-0000-<n>, Unterseite \(sub). insert: Block mit fester id, sk zz, über transact. records wie im Modul import.")])
    }

    // MARK: Export (Markdown, HTML, Workspace)

    static func exportWorkspace() -> (records: [Record], assets: [String: Data]) {
        var out = S.queryWorkspace()
        let t0 = S.t0
        func b(_ id: String, _ type: BlockType, _ text: RichText, parent: ParentRef, sk: String, props: BlockProps = BlockProps()) {
            var x = Block(id: id, type: type, parent: parent, sortKey: sk, text: text, props: props, createdAt: t0, createdBy: "user-1")
            x.updatedAt = t0; x.stamp = Stamp(millis: 3, counter: 0, node: "fx"); out.append(.block(x))
        }
        func asset(_ id: String, _ name: String) -> AssetRef { AssetRef(id: id, name: name, size: 5, mime: FileAssetStore.mime(for: (name as NSString).pathExtension)) }
        var img = BlockProps(); img.asset = asset("as-a", "photo.png"); img.caption = "A photo"
        var img2 = BlockProps(); img2.asset = asset("as-b", "photo.png")
        var pdf = BlockProps(); pdf.asset = asset("as-c", "Plan.pdf")
        var missing = BlockProps(); missing.asset = asset("as-missing", "gone.mov")
        var link = BlockProps(); link.linkTarget = "x-notes-3"
        var icon = BlockProps(); icon.icon = .emoji("🧭")
        b("x-trip", .page, "Trip", parent: .workspace, sk: "b0", props: icon)
        b("x-trip-1", .text, RichText(runs: [TextRun("See "), TextRun("Day 1", mention: .page("x-day")), TextRun(" and "), TextRun("Notes", mention: .page("x-notes-3"))]), parent: .block("x-trip"), sk: "a0")
        b("x-trip-2", .image, "", parent: .block("x-trip"), sk: "a1", props: img)
        b("x-day", .page, "Day 1", parent: .block("x-trip"), sk: "a2")
        b("x-day-1", .image, "", parent: .block("x-day"), sk: "a0", props: img2)
        b("x-day-2", .file, "", parent: .block("x-day"), sk: "a1", props: pdf)
        b("x-day-3", .video, "", parent: .block("x-day"), sk: "a2", props: missing)
        b("x-notes-1", .page, "Notes", parent: .workspace, sk: "b1")
        b("x-notes-1a", .linkToPage, "", parent: .block("x-notes-1"), sk: "a0", props: link)
        b("x-notes-2", .page, "notes", parent: .workspace, sk: "b2")
        b("x-child-2", .page, "Child", parent: .block("x-notes-2"), sk: "a0")
        b("x-notes-3", .page, "Notes", parent: .workspace, sk: "b3")
        b("x-child-3", .page, "Child", parent: .block("x-notes-3"), sk: "a0")
        b("x-assets", .page, "assets", parent: .workspace, sk: "b4")
        b("x-slash", .page, "A/B: C?", parent: .workspace, sk: "b5")
        var v = DatabaseView(id: "v-tasks-table", databaseID: "tasks", blockID: "tasks-block", name: "Table", type: .table, sortKey: "a0")
        v.createdAt = t0; v.updatedAt = t0; v.stamp = Stamp(millis: 4, counter: 0, node: "fx")
        v.sorts = [SortRule(propertyID: "points", ascending: false)]
        v.properties = [ViewProperty(id: "points", visible: true), ViewProperty(id: "title", visible: true), ViewProperty(id: "kind", visible: false), ViewProperty(id: "due", visible: true)]
        out.append(.view(v))
        let assets: [String: Data] = ["as-a": Data("PNG-A".utf8), "as-b": Data("PNG-B".utf8), "as-c": Data("PDF".utf8)]
        return (out, assets)
    }

    public static func export() -> JSONValue {
        var cases: [JSONValue] = []
        let corpus = (try? RecordFixtures.corpus()) ?? []
        let cstore = WorkspaceStore(persistence: MemoryPersistence(corpus), node: "fx")
        let md = MarkdownExporter(store: cstore)
        for id in ["p-root", "p-asset", "row-1", "row-2"] {
            cases.append(C.testCase("Markdown: \(id)", ["op": "markdown", "set": "corpus", "page": .string(id)], .string(md.export(page: id))))
        }
        let (records, files) = exportWorkspace()
        let store = WorkspaceStore(persistence: MemoryPersistence(records), node: "fx")
        let emd = MarkdownExporter(store: store)
        for id in ["home", "x-trip"] {
            cases.append(C.testCase("Markdown: \(id)", ["op": "markdown", "set": "export", "page": .string(id)], .string(emd.export(page: id))))
        }
        for (db, view) in [("tasks", nil), ("projects", nil), ("tasks", Optional("v-tasks-table"))] as [(String, String?)] {
            cases.append(C.testCase("CSV: \(db) \(view ?? "-")", ["op": "csv", "set": "export", "database": .string(db), "view": view.map(JSONValue.string) ?? .null],
                                    .string(emd.csv(database: db, viewID: view))))
        }
        var html = HTMLExporter(store: cstore)
        html.headingOffset = 1
        for id in ["p-root", "row-1"] {
            cases.append(C.testCase("HTML-Seite: \(id)", ["op": "html", "set": "corpus", "page": .string(id)], .string(html.export(page: id))))
        }
        // Workspace-Export (BSD-67): Plan mit eindeutigen Dateinamen, relativen Links und Dateien.
        final class Assets: AssetStore {
            let files: [String: Data]
            let dir: URL
            init(_ files: [String: Data]) {
                self.files = files
                dir = FileManager.default.temporaryDirectory.appendingPathComponent("based-fx-assets")
            }
            func importFile(at url: URL) throws -> AssetRef { throw CocoaError(.featureUnsupported) }
            func importData(_ data: Data, name: String, mime: String?) throws -> AssetRef { throw CocoaError(.featureUnsupported) }
            func url(for asset: AssetRef) -> URL? { files[asset.id] != nil ? dir.appendingPathComponent(asset.id) : nil }
            func contains(_ asset: AssetRef) -> Bool { files[asset.id] != nil }
        }
        let exporter = WorkspaceExporter(store: store, assets: Assets(files))
        for format in [WorkspaceExporter.Format.markdown, .html] {
            let plan = exporter.plan(store.topLevelPages(), format: format)
            cases.append(C.testCase("Workspace-Export \(format.rawValue)", ["op": "plan", "set": "export", "format": .string(format.rawValue)], [
                "directories": .array(plan.directories.map(JSONValue.string)),
                "files": .array(plan.files.map { ["path": .string($0.path), "contents": .string($0.contents)] }),
                "assets": .array(plan.assets.map { ["path": .string($0.path), "name": .string($0.name), "page": .string($0.page), "available": .bool($0.source != nil)] }),
            ]))
        }
        var helpers: [JSONValue] = []
        for t in ["Notes", "A/B: C?", "", "  ", "x\ny|z*\"<>\\", String(repeating: "long ", count: 40)] {
            helpers.append(["op": "fileName", "raw": .string(t), "result": .string(MarkdownExporter.fileName(t))])
        }
        for (dir, path) in [("", "a.md"), ("A", "A/B/x.md"), ("A/B", "A/C/x.md"), ("A/B", "assets/p.png"), ("A", "A.md")] {
            helpers.append(["op": "relative", "dir": .string(dir), "path": .string(path), "result": .string(ExportPlan.relative(from: dir, to: path))])
        }
        for p in ["Notes (2).md", "A b/C#d?.md", "ü/ä ö.html", "100%.md"] {
            helpers.append(["op": "encode", "raw": .string(p), "result": .string(ExportPlan.encode(p))])
        }
        cases.append(splitCase("Export-Hilfen", helpers))
        return C.file("export", cases, meta: [
            "records": .array(corpus.map(S.line)), "exportRecords": .array(records.map(S.line)),
            "assetFiles": .array(files.keys.sorted().map(JSONValue.string)),
            "note": "Markdown/CSV/HTML über RecordFixtures.corpus (set corpus) bzw. Abfrage-Workspace + Export-Seiten (set export). Workspace-Export: alle Seiten der obersten Ebene; available = Datei im Asset-Speicher vorhanden (assetFiles).",
        ])
    }

    // MARK: Workspace-Archiv (BSD-26, BSD-67)

    public static func archive() -> JSONValue {
        var cases: [JSONValue] = []
        let corpus = (try? RecordFixtures.corpus()) ?? []
        let store = WorkspaceStore(persistence: MemoryPersistence(corpus), node: "fx")
        /// Zeilen als JSON (Schlüsselreihenfolge egal); exportedAt der Kopfzeile = EXPORTED.
        func normalizedHeader(_ data: Data) -> [JSONValue] {
            let lines = String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            return lines.enumerated().map { i, l in
                guard let v = try? JSONValue.parse(Data(l.utf8)) else { return .string(l) }
                if i == 0, case .object(var o) = v { o["exportedAt"] = "EXPORTED"; return .object(o) }
                return v
            }
        }
        if let v1 = try? WorkspaceArchive.write(store) {
            cases.append(C.testCase("schreiben v1 (.based.jsonl)", ["op": "write", "version": 1], .array(normalizedHeader(v1))))
        }
        if let pkg = try? WorkspaceArchive.package(store, assets: nil) {
            cases.append(C.testCase("Paket v2 (.based.zip)", ["op": "package"], [
                "records": .array(normalizedHeader(pkg.records)),
                // Reihenfolge in Swift: Schlüsselreihenfolge von JSONSerialization (nicht stabil) → sortiert.
                "assets": .array(pkg.assets.map { WorkspaceArchive.entryPath(for: $0.ref) }.sorted().map(JSONValue.string)),
            ]))
        }
        let refs = WorkspaceArchive.assetRefs(in: corpus)
        cases.append(C.testCase("assetRefs (nach ID sortiert)", ["op": "assetRefs"], .array(refs.sorted { $0.id < $1.id }.map { C.json($0) })))
        var entries: [JSONValue] = []
        for p in ["assets/abc-1/photo.png", "assets/abc/../x", "assets/a b/x.png", "assets/abc/", "assets/abc/.", "assets/abc/..", "workspace.jsonl",
                  "assets/abc/sub/x.png", "assets/a_b-C9/na\\me", "/assets/a/b", "assets/ä/x.png"] {
            entries.append(["op": "assetRef", "path": .string(p), "result": WorkspaceArchive.assetRef(forEntry: p).map { C.json($0) } ?? .null])
        }
        cases.append(splitCase("assetRef(forEntry:)", entries))
        var sanitized: [JSONValue] = []
        for p in ["../../etc/passwd", "/a/./b", "a//b/", "./", "a/../b", "ok/file.txt", "__MACOSX/x"] {
            sanitized.append(["op": "sanitized", "path": .string(p), "result": ZipArchive.sanitized(p).map(JSONValue.string) ?? .null])
        }
        cases.append(splitCase("ZipArchive.sanitized", sanitized))
        // Lesen: Kopfzeile, kaputte Zeilen, neuere Version, kein Archiv
        let good = (try? WorkspaceArchive.write(store)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        let lines = good.split(separator: "\n").map(String.init)
        let header0 = lines[0].replacingOccurrences(of: #""exportedAt":"[^"]*""#, with: #""exportedAt":"2024-01-01T00:00:00Z""#, options: .regularExpression)
        let someRecords = corpus.prefix(4).compactMap { try? RecordFixtures.line($0) }
        let damaged = ([header0, "{not json", #"{"kind":"gadget","data":{}}"#, #"{"kind":"block","data":{"id":"x"}}"#] + someRecords).joined(separator: "\n")
        let newer = #"{"exportedAt":"2024-01-01T00:00:00Z","format":"based-archive","records":0,"version":3}"#
        for (name, text) in [("beschädigt", damaged), ("neuere Version", newer), ("kein Archiv", "hello\nworld")] {
            var out: [String: JSONValue] = [:]
            do {
                let r = try WorkspaceArchive.read(Data(text.utf8))
                out["records"] = .array(r.records.map { .string($0.key.kind.rawValue + ":" + $0.key.id) })
                out["skipped"] = .number(Double(r.skipped))
                out["version"] = r.header.map { .number(Double($0.version)) } ?? .null
            } catch {
                out["error"] = .string(String(describing: error))
            }
            cases.append(C.testCase("lesen: " + name, ["op": "read", "text": .string(text)], .object(out)))
        }
        // Import: in einen leeren und in einen gefüllten Workspace (Herkunft .import: Stempel bleiben, kein Undo).
        for (name, prefill) in [("in leeren Workspace", false), ("in gefüllten Workspace", true)] {
            let dst = WorkspaceStore(persistence: MemoryPersistence(), node: "dst")
            dst.clock.wallClock = { 1_000 }
            if prefill {
                dst.transact("prefill") { tx in
                    var w = dst.workspace; w.name = ""; w.favorites = ["mine"]; tx.put(w)
                    tx.put(Block(id: "mine", type: .page, parent: .workspace, sortKey: "a0", text: "Mine", createdAt: S.t0))
                    var newer = Block(id: "p-url", type: .page, parent: .workspace, sortKey: "a1", text: "Local newer", createdAt: S.t0)
                    newer.updatedAt = S.t0
                    tx.put(newer)
                }
                // p-url lokal mit sehr neuem Stempel: bleibt.
                if var b = dst.blocks["p-url"] {
                    b.stamp = Stamp(millis: 9_999_999_999_999, counter: 0, node: "dst")
                    dst.applyRemote([.block(b)])
                }
            }
            let undo = dst.canUndo
            var origins: [String] = []
            let token = dst.observe { origins.append($0.origin == .import ? "import" : $0.origin == .local ? "local" : "other") }
            var out: [String: JSONValue] = [:]
            do {
                let r = try WorkspaceArchive.importArchive(Data(good.utf8), into: dst)
                out["result"] = ["imported": .number(Double(r.imported)), "keptNewer": .number(Double(r.keptNewer)), "skipped": .number(Double(r.skipped))]
            } catch { out["error"] = .string(String(describing: error)) }
            token.cancel()
            var w = C.json(dst.workspace)
            if case .object(var o) = w { o["stamp"] = nil; o["createdAt"] = nil; o["updatedAt"] = nil; o["id"] = nil; w = .object(o) }
            out["workspace"] = w
            out["origins"] = .array(origins.map(JSONValue.string))
            out["canUndoChanged"] = .bool(dst.canUndo != undo)
            out["stampsKept"] = .bool(corpus.allSatisfy { r in
                guard case .block(let b) = r, b.id != "p-url" || !prefill else { return true }
                return dst.blocks[b.id]?.stamp == b.stamp
            })
            out["blocks"] = .number(Double(dst.blocks.count))
            out["pUrlTitle"] = .string(dst.blocks["p-url"]?.text.plainText ?? "")
            cases.append(C.testCase("importieren: " + name, ["op": "import", "prefill": .bool(prefill)], .object(out)))
        }
        return C.file("archive", cases, meta: ["records": .array(corpus.map(S.line)),
                                                "note": "WorkspaceArchive über RecordFixtures.corpus (Store node fx). exportedAt der Kopfzeile = EXPORTED. Import: Ziel-Store node dst; prefill: Workspace ohne Namen mit Favorit mine, Seite mine, p-url lokal neuer."])
    }
}
