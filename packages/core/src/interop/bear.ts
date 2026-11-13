// BSD-260 Teil 9: Bear-Export (Markdown oder TextBundle) über den Obsidian-Import. Bear schreibt je Notiz entweder
// `Titel.md` (+ Ordner mit Anhängen) oder ein TextBundle `Titel.textbundle/` mit `text.md` (bzw. `text.markdown`),
// `info.json` und `assets/` (TextBundle-Spezifikation, textbundle.org). Eigenheiten (öffentliche Bear-Hilfe):
// - Hervorheben: `::Text::` (Bear-Markup) bzw. `==Text==` (Markdown-Modus, auch Obsidian) → gelb hinterlegt
// - `[[Notiz]]`-Links wie Obsidian; Tags `#tag`, `#mehrere wörter#`, `#a/b` bleiben Text.
// Reine Funktionen; die Integration steht in obsidian-import.ts.
import { basename, dirname, extname, stripExtension, type ImportFiles } from "./files.js";

const BUNDLE = /\.textbundle$/i;

/** Liegt die Datei als Text eines TextBundles vor (`…/X.textbundle/text.md`)? */
export function isBundleText(p: string): boolean {
  return BUNDLE.test(dirname(p)) && /^text\.(md|markdown)$/i.test(basename(p));
}

/** Eine Notiz-Datei: `.md` oder der Text eines TextBundles. */
export function isNoteFile(p: string): boolean {
  return extname(p).toLowerCase() === "md" || isBundleText(p);
}

export const isBundleDir = (p: string) => BUNDLE.test(p);

/** Titel einer Bundle-Notiz: Name des Bundles. */
export function bundleTitle(p: string): string {
  return stripExtension(basename(dirname(p)));
}

/** Enthält der Ordner einen Bear-Export (TextBundles oder Bear-`info.json`)? */
export function isBearExport(files: ImportFiles, root: string): boolean {
  return files.walk(root).some((f) => isBundleText(f) || (basename(f) === "info.json" && BUNDLE.test(dirname(f)) && /net\.shinyfrog\.bear/.test(files.readText(f) ?? "")));
}

/** `==x==` und (Bear) `::x::` → `<mark>x</mark>` (der Markdown-Leser macht daraus gelben Hintergrund). Ohne Inline-Code. */
export function highlightToMark(s: string, bear: boolean): string {
  let out = s.replace(/==(?=\S)([^=\n]*?\S)==/g, "<mark>$1</mark>");
  if (bear) out = out.replace(/::(?=\S)([^:\n]*?\S)::/g, "<mark>$1</mark>");
  return out;
}
