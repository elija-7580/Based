import SwiftUI
open class AVPlayer: NSObject, @unchecked Sendable { public override init() {}; public init(url: URL) {}; open func play() {}; open func pause() {}; open var volume: Float = 1 }
public struct VideoPlayer<VideoOverlay: View>: _PrimitiveView { public init(player: AVPlayer?) where VideoOverlay == EmptyView {}; public init(player: AVPlayer?, @ViewBuilder videoOverlay: () -> VideoOverlay) {} }
