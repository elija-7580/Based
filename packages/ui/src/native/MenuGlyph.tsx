// Icon aus dem Satz der App in React-Menüs fremder Bausteine (Blockmenü des Editors): gleiche Icons wie die
// Based-Menüs, ohne dass das Paket die Icon-Datei der App kennt (setMenuIcons in installNativeFree).
import { useLayoutEffect, useRef } from "react";
import { menuIcon } from "./menu.js";

export function MenuGlyph({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const svg = menuIcon(name);
    if (!el || !svg) return;
    el.replaceChildren(svg);
  }, [name]);
  return <span ref={ref} className="nf-glyph" aria-hidden="true" />;
}
