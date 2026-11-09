import Foundation
import Testing
@testable import BasedCore

/// Pass 16: protected pages, chosen Home page, HTML export, /html slash command.
@MainActor
struct Pass16Tests {
    func store() -> WorkspaceStore { WorkspaceStore(persistence: MemoryPersistence(), node: "test") }

    @Test func protectedPagesCantBeTrashedOrDeleted() {
        let s = store()
        let brain = s.createPage(title: "Agent Brain")
        let about = s.createPage(title: "About me", in: .block(brain))
        let other = s.createPage(title: "Notes")
        let holder = s.createPage(title: "Folder")
        s.protectedIDs = [brain, about]

        // Direct, bulk, block-level and permanent deletes all skip protected pages…
        #expect(s.trashPages([brain]).isEmpty)
        #expect(s.trashPages([about, other]) == [other])
        s.trash([about])
        s.deleteBlocks([about])
        s.deleteForever([brain])
        #expect(!s.isTrashed(brain) && !s.isTrashed(about) && s.blocks[brain] != nil)
        #expect(s.protectedAmong([brain, other]) == [brain])

        // …and a page that contains one can't go either (it would take the protected page along).
        s.movePages([brain], to: .page(holder))
        #expect(s.containsProtected(holder))
        #expect(s.trashPages([holder]).isEmpty)
        #expect(!s.isTrashed(about))
    }

    @Test func homePageFollowsTrashAndClears() {
        let s = store()
        let p = s.createPage(title: "Dashboard")
        #expect(s.homePageID == nil)
        s.setHomePage(p)
        #expect(s.homePageID == p && s.workspace.homePageID == p)
        s.trashPages([p])
        #expect(s.homePageID == nil, "a trashed Home page falls back to the chooser")
        s.restorePages([p])
        #expect(s.homePageID == p)
        s.setHomePage(nil)
        #expect(s.homePageID == nil)
        // Old workspace records (no homePageID) still decode.
        let old = try! JSONDecoder().decode(Workspace.self, from: JSONEncoder().encode(Workspace()))
        #expect(old.homePageID == nil)
    }

    @Test func htmlSlashCommandsExist() {
        #expect(SlashCommands.search("html").first?.action == .codeBlock(language: "html"))
        #expect(SlashCommands.search("mermaid").first?.action == .codeBlock(language: "mermaid"))
    }

    @Test func htmlExportRendersBlocks() {
        let s = store()
        let page = s.createPage(title: "Report <1>", icon: .emoji("📊"))
        var bold = RichText("Hello ")
        bold.runs.append(TextRun("world", marks: Marks(bold: true)))
        s.insertBlock(.heading1, text: "Intro", in: .block(page))
        s.insertBlock(.text, text: bold, in: .block(page))
        s.insertBlock(.bulletedList, text: "one", in: .block(page))
        s.insertBlock(.bulletedList, text: "two", in: .block(page))
        var todo = BlockProps(); todo.checked = true
        s.insertBlock(.todo, text: "done", props: todo, in: .block(page))
        var html = BlockProps(); html.language = "html"
        s.insertBlock(.code, text: "<b onclick=\"x()\">live</b>", props: html, in: .block(page))
        var mermaid = BlockProps(); mermaid.language = "mermaid"
        s.insertBlock(.code, text: "graph TD; A-->B", props: mermaid, in: .block(page))
        let sub = s.createPage(title: "Child", in: .block(page))

        let out = HTMLExporter(store: s).export(page: page)
        #expect(out.hasPrefix("<!doctype html>"))
        #expect(out.contains("<title>Report &lt;1&gt;</title>"))
        #expect(out.contains("<h1 class=\"title\">Report &lt;1&gt;</h1>"))
        #expect(out.contains("<h2>Intro</h2>"))
        #expect(out.contains("<p>Hello <strong>world</strong></p>"))
        #expect(out.contains("<ul>\n<li>one</li>\n<li>two</li>\n</ul>"), "consecutive bullets share one list")
        #expect(out.contains("type=\"checkbox\" disabled checked"))
        #expect(out.contains("<iframe sandbox=\"allow-scripts\""))
        #expect(out.contains("srcdoc=\"&lt;b onclick=&quot;x()&quot;&gt;live&lt;/b&gt;\""), "HTML source is attribute-escaped")
        #expect(out.contains("<pre class=\"mermaid\">graph TD; A--&gt;B</pre>"))
        #expect(out.contains("mermaid.esm.min.mjs"))
        #expect(out.contains("href=\"Child.html\""))
        _ = sub
    }

    @Test func htmlExportDatabaseTable() {
        let s = store()
        let c = s.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 2)
        let out = HTMLExporter(store: s).export(page: c.blockID)
        #expect(out.contains("<table class=\"database\">"))
        #expect(out.contains("<h4 class=\"db-title\">Tasks</h4>"))
    }
}
