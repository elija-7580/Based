import SwiftUI

/// Stand-in for page blocks that aren't built yet (progressive page build in `BlockList`): quiet grey text lines
/// like Notion's loading state, with a slow pulse. Draws at most a screenful or two of bars; the rest of the
/// estimated height is empty space, so a very long page doesn't create thousands of views.
struct BlockSkeleton: View {
    let height: CGFloat
    @State private var dim = false

    /// Bar widths (fractions of the column), repeating — reads like paragraphs of different lengths.
    private static let widths: [CGFloat] = [0.92, 0.78, 0.86, 0.45, 0.0, 0.34, 0.9, 0.82, 0.6, 0.0, 0.88, 0.7]
    private static let step: CGFloat = 30

    var body: some View {
        let bars = max(1, min(48, Int(height / Self.step)))
        GeometryReader { g in
            VStack(alignment: .leading, spacing: 0) {
                ForEach(0..<bars, id: \.self) { i in
                    let w = Self.widths[i % Self.widths.count]
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(Theme.primary.opacity(w == 0 ? 0 : 0.06))
                        .frame(width: max(0, g.size.width * w), height: 12)
                        .frame(height: Self.step, alignment: .center)
                }
            }
        }
        .frame(height: max(Self.step, height), alignment: .top)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(dim ? 0.55 : 1)
        .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: dim)
        .onAppear { dim = true }
        .allowsHitTesting(false)
        .accessibilityLabel("Loading")
    }
}
