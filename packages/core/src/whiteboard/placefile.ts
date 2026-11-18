// Dateien aufs Board legen – eine Stelle für die Fläche (Ziehen, Einfügen, Auswahl) und für Agenten (draw_board):
// welche Objekte eine Datei wird (Bild, je PDF-Seite eines, Vorschau, Karte) und wie groß. Dazu das Erkennen von
// Art, Bildmaßen und PDF-Seiten aus den Bytes, damit ein Agent nur die Adresse nennen muss.
import { boardFileView } from "./files.js";

export interface BoardSize2 { w: number; h: number }

/** Eine abgelegte Datei: `ref` ist die Adresse im Dateispeicher (`based-asset:<sha256>`), nie der Inhalt. */
export interface BoardFileInfo {
  ref: string; name: string; mime: string; size: number;
  /** Bildmaße in px, wenn es ein Bild ist. */
  width?: number; height?: number;
  /** Seitenmaße (Punkt), wenn es ein PDF ist: jede Seite wird ein Objekt. */
  pages?: readonly { width: number; height: number }[];
}

export const FILE_CARD_SIZE: BoardSize2 = { w: 264, h: 72 };
export const PREVIEW_SIZES: Record<"text" | "html" | "video" | "audio", BoardSize2> = { text: { w: 440, h: 320 }, html: { w: 560, h: 400 }, video: { w: 480, h: 310 }, audio: { w: 360, h: 104 } };
export const PDF_PAGE_WIDTH = 560;
export const IMAGE_MAX_SIDE = 480;
/** Bild ohne bekannte Maße (etwa aus einem älteren Seitenblock): so groß, bis jemand es anpasst. */
export const IMAGE_UNKNOWN_SIZE: BoardSize2 = { w: 320, h: 240 };

export interface BoardFilePart { kind: "image" | "file"; size: BoardSize2; style: Record<string, string | number | boolean> }

/** Die Objekte, die eine Datei auf dem Board wird (ein PDF: eines je Seite). */
export function boardFileParts(f: BoardFileInfo): BoardFilePart[] {
  const view = boardFileView(f.name, f.mime);
  const base = { name: f.name, mime: f.mime, size: f.size };
  if (view === "image") {
    if ((f.width ?? 0) > 0 && (f.height ?? 0) > 0) {
      const k = Math.min(1, IMAGE_MAX_SIDE / Math.max(f.width!, f.height!));
      return [{ kind: "image", size: { w: Math.max(8, Math.round(f.width! * k)), h: Math.max(8, Math.round(f.height! * k)) }, style: base }];
    }
    return [{ kind: "image", size: IMAGE_UNKNOWN_SIZE, style: base }];
  }
  if (view === "pdf" && f.pages?.length) {
    return f.pages.map((p, i) => ({ kind: "file" as const, size: { w: PDF_PAGE_WIDTH, h: Math.max(8, Math.round((PDF_PAGE_WIDTH * p.height) / Math.max(1, p.width))) }, style: { ...base, view: "pdf", page: i + 1, pages: f.pages!.length } }));
  }
  if (view === "text" || view === "html" || view === "video" || view === "audio") return [{ kind: "file", size: PREVIEW_SIZES[view], style: { ...base, view } }];
  return [{ kind: "file", size: FILE_CARD_SIZE, style: base }];
}

// MARK: Erkennen aus den Bytes

/** Art nach den ersten Bytes (Bilder, PDF, gängige Medien); `undefined`: unbekannt. */
export function sniffMime(head: Uint8Array): string | undefined {
  const s = (o: number, t: string) => t.split("").every((c, k) => head[o + k] === c.charCodeAt(0));
  if (head[0] === 0x89 && s(1, "PNG")) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (s(0, "GIF8")) return "image/gif";
  if (s(0, "RIFF") && s(8, "WEBP")) return "image/webp";
  if (s(0, "%PDF")) return "application/pdf";
  if (s(4, "ftyp")) return s(8, "M4A") ? "audio/mp4" : s(8, "qt") ? "video/quicktime" : "video/mp4";
  if (s(0, "ID3") || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
  if (s(0, "OggS")) return "audio/ogg";
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  return undefined;
}

/** Bildmaße aus den ersten Bytes (PNG, JPEG, GIF, WebP); `undefined`, wenn sie dort nicht stehen. */
export function sniffImageSize(b: Uint8Array): { width: number; height: number } | undefined {
  const mime = sniffMime(b);
  const u16be = (o: number) => (b[o]! << 8) | b[o + 1]!;
  const u32be = (o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
  const u16le = (o: number) => b[o]! | (b[o + 1]! << 8);
  const ok = (w: number, h: number) => (w > 0 && h > 0 && w < 100_000 && h < 100_000 ? { width: w, height: h } : undefined);
  if (mime === "image/png" && b.length >= 24) return ok(u32be(16), u32be(20));
  if (mime === "image/gif" && b.length >= 10) return ok(u16le(6), u16le(8));
  if (mime === "image/webp" && b.length >= 30) {
    const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (kind === "VP8 ") return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (kind === "VP8L") { const v = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24); return ok((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1); }
    if (kind === "VP8X") return ok(1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)));
    return undefined;
  }
  if (mime === "image/jpeg") {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o += 1; continue; }
      const marker = b[o + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = u16be(o + 2);
      // SOF0–SOF15 ohne DHT (C4), JPG (C8), DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(u16be(o + 7), u16be(o + 5));
      o += 2 + len;
    }
  }
  return undefined;
}

/**
 * Seiten eines PDFs grob aus dem Text der Datei: Anzahl (`/Type /Page`, sonst das größte `/Count`) und das erste
 * `/MediaBox` für alle Seiten. Reicht für das Layout auf dem Board; die Fläche rendert jede Seite ohnehin selbst.
 * `undefined`: nicht erkennbar (dann wird das PDF eine Dateikarte).
 */
export function sniffPdfPages(bytes: Uint8Array): { width: number; height: number }[] | undefined {
  const text = latin1(bytes);
  let count = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  if (count === 0) for (const m of text.matchAll(/\/Count\s+(\d+)/g)) count = Math.max(count, Number(m[1]));
  if (count === 0 || count > 2000) return undefined;
  const box = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(text);
  const w = box ? Math.abs(Number(box[3]) - Number(box[1])) : 595, h = box ? Math.abs(Number(box[4]) - Number(box[2])) : 842;
  if (!(w > 0 && h > 0)) return undefined;
  return Array.from({ length: count }, () => ({ width: w, height: h }));
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}
