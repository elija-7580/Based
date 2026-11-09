import Foundation
import Testing
@testable import BasedBrain

/// BSD-131: widget taps open the matching view (based://inbox, based://home); everything else is left to the
/// other link handlers (capture routes, page links).
struct AppDestinationTests {
    @Test func parsesInboxAndHomeOnly() {
        #expect(AppDestination(url: URL(string: "based://inbox")!) == .inbox)
        #expect(AppDestination(url: URL(string: "BASED://Home/")!) == .home)
        #expect(AppDestination(url: AppDestination.inbox.url) == .inbox && AppDestination(url: AppDestination.home.url) == .home)
        for s in ["based://inbox/123", "https://inbox", "based://capture", "based://page/abc", "based://homes", "based:inbox"] {
            #expect(AppDestination(url: URL(string: s)!) == nil, "\(s)")
        }
        // Not swallowed by the capture routes either way.
        #expect(CaptureRoute(url: URL(string: "based://inbox")!) == nil)
    }
}
