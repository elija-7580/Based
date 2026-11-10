// Astryx-Theme „Based Default“. Die Abbildung Based-Token → Astryx-Token steht (getestet) in
// @based/design-tokens/astryx; hier wird sie nur an defineTheme gereicht. Laufzeit-Theme statt `astryx theme build`:
// die App ist eine reine Client-App, und so gibt es keine generierte Datei, die von tokens.json abweichen kann.
// Kein fonts.css, keine fremden Icons – Based lädt nichts von fremden Servern.
import { defineTheme, type DefinedTheme, type DefineThemeInput } from "@astryxdesign/core/theme";
import { astryxThemeSpec, type Density } from "@based/design-tokens/astryx";
import { basedIconRegistry } from "./astryxIcons.js";

const build = (density: Density): DefinedTheme => {
  const spec = astryxThemeSpec({ density });
  return defineTheme({ name: spec.name, tokens: spec.tokens as NonNullable<DefineThemeInput["tokens"]>, motion: spec.motion, components: spec.components, icons: basedIconRegistry });
};

/** Je Dichte ein Theme (Steuerhöhen stehen fest im Theme); Hell/Dunkel schaltet `<Theme mode>`. */
export const astryxThemes: Record<Density, DefinedTheme> = { comfortable: build("comfortable"), compact: build("compact") };
export const astryxTheme = astryxThemes.comfortable;
