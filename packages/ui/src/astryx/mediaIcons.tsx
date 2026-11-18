// BSD-447: Icons des BasedMediaPlayer – 24er-Raster, 2-px-Strich, aktiv (Abspielen) gefüllt. @based/ui hat keinen
// Zugriff auf apps/web/src/icons.tsx, deshalb ein eigener kleiner Satz (wie packages/editor/src/ui/icons.tsx).
// Auch das Häkchen im Menü der Filter-Pille (BasedPicker) und die Lupe der Suchfelder kommen von hier.
import type { SVGProps } from "react";
export const Glyph = ({ d, filled, size = 18 }: { d: string; filled?: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
export const PLAY = "M7 4.5v15l12-7.5z";
export const PAUSE = "M8 5v14M16 5v14";
export const SOUND = "M4 9.5h3.5L12 5v14l-4.5-4.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11";
export const MUTED = "M4 9.5h3.5L12 5v14l-4.5-4.5H4zM16 9.5l5 5M21 9.5l-5 5";
export const EXPAND = "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5";
export const CHECK = "M5 12.5l4.5 4.5L19 7.5";
export const SEARCH = "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.6-4.6";
/** Lupe für Suchfelder (BasedField `type="search"`); Größe 1em – Astryx setzt sie über die Schriftgröße des Felds. */
export const SearchGlyph = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d={SEARCH} /></svg>
);
