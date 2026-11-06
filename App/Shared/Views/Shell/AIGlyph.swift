import SwiftUI

/// Based's own AI mark, drawn instead of the SF "sparkles" symbol: an orbit ring with a soft, organic
/// four-point spark at its centre and a small satellite dot. Strokes and fills follow `foregroundStyle`,
/// so it tints like an SF Symbol.
struct AIGlyph: View {
    var size: CGFloat = 16
    /// Colourful variant (empty states, the active chat button).
    var vivid = false

    var body: some View {
        ZStack {
            Circle()
                .trim(from: 0.08, to: 0.92)
                .stroke(style: StrokeStyle(lineWidth: max(1.2, size * 0.085), lineCap: .round))
                .rotationEffect(.degrees(-50))
                .opacity(vivid ? 0.55 : 0.75)
            AISpark()
                .frame(width: size * 0.56, height: size * 0.56)
            Circle()
                .frame(width: size * 0.17, height: size * 0.17)
                .offset(x: size * 0.31, y: -size * 0.31)
        }
        .frame(width: size, height: size)
        .foregroundStyle(vivid ? AnyShapeStyle(LinearGradient(colors: [Color(red: 0.55, green: 0.42, blue: 0.98), Color(red: 0.95, green: 0.45, blue: 0.55)],
                                                                startPoint: .topLeading, endPoint: .bottomTrailing))
                               : AnyShapeStyle(.foreground))
        .accessibilityHidden(true)
    }
}

/// Four-point spark with rounded tips and deep, smooth waist (not the sharp SF sparkle).
struct AISpark: Shape {
    func path(in r: CGRect) -> Path {
        let c = CGPoint(x: r.midX, y: r.midY)
        let rx = r.width / 2, ry = r.height / 2
        let waist: CGFloat = 0.16
        var p = Path()
        let tips = [CGPoint(x: c.x, y: c.y - ry), CGPoint(x: c.x + rx, y: c.y), CGPoint(x: c.x, y: c.y + ry), CGPoint(x: c.x - rx, y: c.y)]
        p.move(to: tips[0])
        for i in 0..<4 {
            let a = tips[i], b = tips[(i + 1) % 4]
            // Control point pulled towards the centre → concave sides.
            let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
            let ctrl = CGPoint(x: c.x + (mid.x - c.x) * waist, y: c.y + (mid.y - c.y) * waist)
            p.addQuadCurve(to: b, control: ctrl)
        }
        p.closeSubpath()
        return p
    }
}

/// SF Symbol by name, or Based's own glyphs for the names below.
struct SymbolImage: View {
    static let ai = "based.ai"
    let name: String
    var size: CGFloat = 15
    var weight: Font.Weight = .regular

    var body: some View {
        if name == Self.ai {
            AIGlyph(size: size * 1.12)
        } else {
            Image(systemName: name).font(.system(size: size, weight: weight))
        }
    }
}
