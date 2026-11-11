import Testing
@testable import BasedCore

struct PageLinkTests {
    let id = "1fe618c1-167e-80f8-946e-c1a7918dfc28"

    @Test func parsesEveryForm() {
        #expect(PageLink.id(from: "based://page/\(id)") == id)
        #expect(PageLink.id(from: "based://\(id)") == id)
        #expect(PageLink.id(from: "https://sync.example.com/app#\(id)") == id)
        #expect(PageLink.id(from: "1fe618c1167e80f8946ec1a7918dfc28") == id)
        #expect(PageLink.id(from: "https://www.notion.so/Elij-s-Second-Brain-1fe618c1167e80f8946ec1a7918dfc28") == id)
        #expect(PageLink.id(from: PageLink.url(id)) == id)
    }

    @Test func formats() {
        #expect(PageLink.markdown(id, title: "Tasks") == "[Tasks](based://page/\(id))")
        #expect(PageLink.web(id, server: "https://x.dev/") == "https://x.dev/app#\(id)")
    }
}
