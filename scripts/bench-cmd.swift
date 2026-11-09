// Sends one debug command URL to a Based benchmark instance: swift scripts/bench-cmd.swift "based://debug/open?id=…"
import Foundation
DistributedNotificationCenter.default().postNotificationName(.init("based.debug.url"), object: CommandLine.arguments[1], userInfo: nil, deliverImmediately: true)
