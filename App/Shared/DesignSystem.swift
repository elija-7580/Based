import SwiftUI

/// Design tokens: one place for the spacing scale, type ramp, corner radii, control heights and interaction fills,
/// so new UI picks a value from here instead of inventing another 12.5 pt / 0.055 opacity.
/// Colour roles live in `Theme` (primary, secondary, accentBlue, gridLine, hoverFill …).
enum DS {
    /// 4-pt based spacing scale.
    enum Space {
        static let xxs: CGFloat = 2
        static let xs: CGFloat = 4
        static let sm: CGFloat = 6
        static let md: CGFloat = 8
        static let lg: CGFloat = 12
        static let xl: CGFloat = 16
        static let xxl: CGFloat = 24
    }

    /// Corner radii (all drawn with `.continuous`).
    enum Radius {
        static let small: CGFloat = 4     // menu rows, inline highlights
        static let control: CGFloat = 6   // buttons, chips, fields
        static let card: CGFloat = 8      // grouped rows, cards
        static let panel: CGFloat = 12    // popovers, floating panels
    }

    /// Interactive control heights.
    enum Control {
        static let compact: CGFloat = 24
        static let regular: CGFloat = 26
        static let comfortable: CGFloat = 28
        static let large: CGFloat = 32
    }

    /// Type ramp: caption / small / body / ui / title (+ semibold variants through `weight`).
    enum Text {
        static func caption(_ weight: Font.Weight = .regular) -> Font { .system(size: 11, weight: weight) }
        static func small(_ weight: Font.Weight = .regular) -> Font { .system(size: 12, weight: weight) }
        static func body(_ weight: Font.Weight = .regular) -> Font { .system(size: 13, weight: weight) }
        static func ui(_ weight: Font.Weight = .regular) -> Font { .system(size: 14, weight: weight) }
        static func title(_ weight: Font.Weight = .semibold) -> Font { .system(size: 17, weight: weight) }
    }

    /// Fill strength of `Theme.primary` laid over the page for interaction states.
    enum Fill {
        static let rest: Double = 0.045       // quiet container (segmented control track, chip menu)
        static let hover: Double = 0.065
        static let selected: Double = 0.1
        static let pressed: Double = 0.13
    }

    /// Standard animation durations.
    enum Motion {
        static let hover: Double = 0.1
        static let press: Double = 0.06
    }
}
