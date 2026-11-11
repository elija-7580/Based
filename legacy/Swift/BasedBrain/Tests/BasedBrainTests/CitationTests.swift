import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-61: answers from the workspace with sources — markers, streaming, invalid ids, tools.
@MainActor
struct CitationTests {
    private func lookup(_ kind: String, _ id: String) -> Citation? {
        switch id {
        case "b1": return Citation(number: 0, pageID: "p1", blockID: "b1", title: "Sync v2", snippet: "Deletes are tombstones.")
        case "b2": return Citation(number: 0, pageID: "p1", blockID: "b2", title: "Sync v2", snippet: "Pull is paged.")
        case "p9": return Citation(number: 0, pageID: "p9", blockID: nil, title: "ADR [10]", snippet: "")
        default: return nil
        }
    }

    @Test func markersBecomeNumberedLinksWithSources() {
        let text = "Deletes are kept as tombstones [[block:b1]]. Pulls are paged [[block:b2]], see also [[page:p9]]. Again [[block:b1]]. Gone [[block:zz]]."
        let r = Citations.render(text, resolve: lookup)
        #expect(r.citations.map(\.number) == [1, 2, 3])
        #expect(r.citations.map(\.blockID) == ["b1", "b2", nil])
        #expect(r.markdown.hasPrefix("Deletes are kept as tombstones[¹](based://page/p1?block=b1). Pulls are paged[²](based://page/p1?block=b2), see also[³](based://page/p9)."))
        #expect(r.markdown.contains("Again[¹](based://page/p1?block=b1)."), "same source keeps its number")
        #expect(r.markdown.contains("Gone."), "unknown id dropped")
        #expect(!r.markdown.contains("[[") && !r.markdown.contains("zz"))
        #expect(r.markdown.contains("**Sources**\n\n1. [Sync v2](based://page/p1?block=b1) — Deletes are tombstones.\n2. [Sync v2](based://page/p1?block=b2) — Pull is paged.\n3. [ADR [10\\]](based://page/p9)"))
        // Nothing cited → text unchanged, no Sources.
        #expect(Citations.render("Plain answer.", resolve: lookup) == CitedText(markdown: "Plain answer.", citations: []))
        #expect(Citations.render("Only bad [[block:x]].", resolve: lookup).markdown == "Only bad.")
        #expect(Citations.superscript(12) == "¹²")
        #expect(Citations.markers(in: "a [[block: b1 ]] b [[page:p9]]").map(\.id) == ["b1", "p9"])
    }

    @Test func markersSplitAcrossStreamingChunksAreNeverShownRaw() {
        let full = "Sync v2 uses tombstones [[block:b1]] and paged pulls [[block:b2]]."
        var builder = ChatTurnBuilder()
        // Chunks cut inside "[[", inside "block:" and inside the id.
        let chunks = ["Sync v2 uses tombstones [", "[blo", "ck:b", "1]] and paged pulls [[block:", "b2]", "]."]
        var seen = ""
        for c in chunks {
            builder.apply(.textDelta(c))
            let shown = Citations.render(builder.text, streaming: true, resolve: lookup).markdown
            #expect(!shown.contains("[["), "partial marker shown: \(shown)")
            #expect(!shown.hasSuffix("["))
            seen = shown
        }
        #expect(seen.contains("[²](based://page/p1?block=b2)"))
        builder.apply(.text(full))
        let final = Citations.render(builder.text, resolve: lookup)
        #expect(final == Citations.render(full, resolve: lookup))
        #expect(final.citations.count == 2)
        // A plain "[" or "[[" that is not a marker stays.
        #expect(Citations.streamingSafe("an array a[") == "an array a")
        #expect(Citations.streamingSafe("wiki [[Home") == "wiki [[Home")
        #expect(Citations.streamingSafe("done [[page:p") == "done")
        #expect(Citations.streamingSafe("x [[block:b1]] y") == "x [[block:b1]] y")
    }

    @Test func workspaceLookupDropsTrashedAndUnknownIDs() {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let page = store.createPage(title: RichText("Sync v2"), in: .workspace)
        let kept = store.insertBlock(.text, text: "Deletes are kept as tombstones for 90 days.", in: .block(page))
        let gone = store.insertBlock(.text, text: "Old rule.", in: .block(page))
        store.trash([gone])
        let answer = "Tombstones stay 90 days [[block:\(kept)]]. Old [[block:\(gone)]]. Made up [[block:nope]]. Page [[page:\(page)]]."
        let r = Citations.render(answer, store: store)
        #expect(r.citations.count == 2)
        #expect(r.citations[0] == Citation(number: 1, pageID: page, blockID: kept, title: "Sync v2", snippet: "Deletes are kept as tombstones for 90 days."))
        #expect(r.citations[1].pageID == page && r.citations[1].blockID == nil)
        #expect(!r.markdown.contains(gone) && !r.markdown.contains("nope"))
        // The link opens the page (any Based link handler) and names the block.
        let url = URL(string: Citations.link(page: page, block: kept))!
        #expect(PageLink.id(from: url.absoluteString) == page)
        #expect(Citations.target(of: url)! == (page, kept))
        #expect(Citations.target(of: URL(string: PageLink.url(page))!)! == (page, nil))
        #expect(Citations.target(of: URL(string: "https://example.com")!) == nil)
    }

    @Test func toolsHandOutBlockIDsAndThePromptAsksForCitations() {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let page = store.createPage(title: RichText("Sync v2"), in: .workspace)
        let first = store.insertBlock(.text, text: "Deletes are tombstones.", in: .block(page))
        let second = store.insertBlock(.text, text: "Pulls are paged by sequence.", in: .block(page))
        let tools = AgentTools(store: store, brain: brain)
        let hit = tools.call("search", ["query": "tombstones"])
        #expect(hit.text.contains("[block: \(first)]"), "\(hit.text)")
        let plain = tools.call("read_page", ["page_id": .string(page)])
        #expect(!plain.text.contains("[block:"))
        let cited = tools.call("read_page", ["page_id": .string(page), "block_ids": true])
        #expect(cited.text.contains("[block:\(first)]\nDeletes are tombstones."))
        #expect(cited.text.contains("[block:\(second)]\nPulls are paged by sequence."))
        #expect(tools.specs.first { $0.name == "read_page" }?.description.contains("block_ids") == true)
        #expect(ChatRouting.systemPrompt(for: .cli(ChatEngineSpec(kind: .claudeCode)), context: "").contains("[[block:"))
    }
}
