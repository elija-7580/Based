// Einfügen im Editor: Was tun mit dem Inhalt der Zwischenablage? Reine Entscheidung (ohne DOM), damit sie testbar
// ist. HTML hat Vorrang (BSD-176); reiner Text, der wie Markdown aussieht oder mehrere Zeilen hat, geht durch den
// Markdown-Parser (interop/markdown.ts); „Paste as plain text“ (⇧⌘V) bleibt immer Klartext.
import { MarkdownImporter } from "../interop/markdown.js";

const INLINE_PATTERNS: RegExp[] = [
  /\*\*[^\s*][^*]*\*\*/, // **fett**
  /(^|[^\p{L}\p{N}_])__[^\s_][^_]*__(?![\p{L}\p{N}])/u, // __fett__
  /~~[^\s~][^~]*~~/, // ~~durchgestrichen~~
  /`[^`\n]+`/, // `code`
  /!?\[[^\]\n]*\]\([^)\s]+\)/, // [Link](ziel), ![Bild](ziel)
  /(^|[\s(])\*[^\s*][^*\n]*[^\s*]\*(?=$|[\s).,;:!?])/, // *kursiv*
  /(^|[\s(])_[^\s_][^_\n]*[^\s_]_(?=$|[\s).,;:!?])/, // _kursiv_
];

/** Eine einzelne Zeile, die für sich ein Markdown-Block ist (Überschrift, Liste, Zitat, Trenner, Tabelle, Code-Zaun). */
export function isMarkdownBlockLine(line: string): boolean {
  const t = line.trim();
  if (t === "") return false;
  if (MarkdownImporter.heading(t)) return true;
  if (/^#{5,6} /.test(t)) return true;
  if (MarkdownImporter.listItem(t)) return true;
  if (/^(```|~~~)/.test(t)) return true;
  if (/^> ?\S/.test(t)) return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return true;
  if (/^\|.*\|$/.test(t)) return true;
  if (/^\$\$.+\$\$$/.test(t)) return true;
  return false;
}

/** Enthält die Zeile Inline-Markdown (fett, kursiv, Code, Link, Bild)? */
export function hasInlineMarkdown(line: string): boolean {
  return INLINE_PATTERNS.some((p) => p.test(line));
}

/**
 * Soll reiner Text als Markdown eingefügt werden? Ja bei mehreren Zeilen (jede Zeile wird ein Block, auch ohne
 * Markdown-Zeichen) und bei einer Zeile mit Block- oder Inline-Markdown. Eine nackte URL oder ein Satz ohne
 * Markdown bleibt Klartext (der Editor fügt ihn an der Schreibmarke ein).
 */
export function looksLikeMarkdown(text: string): boolean {
  const s = text.replaceAll("\r\n", "\n").replace(/^\n+|\n+$/g, "");
  if (s.trim() === "") return false;
  if (s.includes("\n")) return true;
  if (/^\s*(https?|mailto|based):\S+\s*$/i.test(s)) return false;
  return isMarkdownBlockLine(s) || hasInlineMarkdown(s);
}

export type PasteKind = "html" | "markdown" | "plain";

export interface PasteInput {
  /** `text/html` der Zwischenablage (leer/fehlend = keines). */
  html?: string | undefined;
  /** `text/plain`. */
  text?: string | undefined;
  /** „Paste as plain text“ (⇧⌘V / Ctrl+Shift+V). */
  plainOnly?: boolean | undefined;
  /** Schreibmarke steht in einem Code-Block: dort wird nie umgewandelt. */
  inCode?: boolean | undefined;
}

/** Wie eingefügt wird: HTML vor Markdown vor Klartext. */
export function pasteKind(input: PasteInput): PasteKind {
  if (input.plainOnly || input.inCode) return "plain";
  if (input.html !== undefined && input.html.trim() !== "") return "html";
  return looksLikeMarkdown(input.text ?? "") ? "markdown" : "plain";
}
