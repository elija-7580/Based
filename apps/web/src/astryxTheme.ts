// Astryx-Theme für Based Next. Bewusst von Hand statt über `astryx theme add` erzeugt: das generierte Modul lädt
// `@astryxdesign/theme-neutral/fonts.css`, und das holt die Schrift von fonts.googleapis.com. Based lädt nichts
// von fremden Servern (E2E „Gleichungen rendern offline“ prüft das), die Schrift kommt aus den Based-Tokens.
// Nächster Schritt: eigenes Theme „Based Default“ mit defineTheme aus @based/design-tokens (docs/design/astryx.md).
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import "@astryxdesign/theme-neutral/theme.css";

export const astryxTheme = neutralTheme;
