// Roam Research: JSON-Export (eine Liste von Seiten mit verschachtelten Blöcken `string`/`uid`/`children`).
// Wird in Markdown-Notizen mit [[Wikilinks]] übersetzt, die der Vault-Import liest (Links → Erwähnungen).
import { ImportFiles } from "../files.js";
import { isObj, num, safeName, str, uniqueNamer, type Json } from "./table.js";

export function isRoamExport(v: Json | undefined): v is Record<string, Json>[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every((p) => isObj(p) && typeof p.title === "string")) return false;
  return v.some((p) => isObj(p) && (Array.isArray(p.children) ? p.children.some((c) => isObj(c) && typeof c.string === "string") : p["edit-time"] !== undefined || p["create-time"] !== undefined));
}

/** Roam-Schreibweisen → Markdown. `blocks`: Text je Block-UID (für `((uid))`). */
function roamInline(s: string, blocks: ReadonlyMap<string, string>, pages: ReadonlySet<string>, depth = 0): string {
  let out = s;
  out = out.replace(/\{\{\[?\[?embed\]?\]?:\s*\(\(\(?([\w-]+)\)?\)\)\s*\}\}/gi, (_m, id: string) => blocks.get(id) ?? "");
  out = out.replace(/\(\(([\w-]+)\)\)/g, (m, id: string) => {
    const t = blocks.get(id);
    return t === undefined ? m : depth < 3 ? roamInline(t, blocks, pages, depth + 1) : t;
  });
  out = out.replace(/\{\{\[?\[?(?:video|youtube|iframe|pdf)\]?\]?:\s*([^}\s]+)\s*\}\}/gi, "$1");
  out = out.replace(/\{\{\[?\[?(?:embed)\]?\]?:\s*(\[\[[^\]]+\]\])\s*\}\}/gi, "$1");
  // #[[Seite]] und #Seite sind in Roam Links auf Seiten
  out = out.replace(/#(\[\[[^\]\n]+\]\])/g, "$1");
  out = out.replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, (m, lead: string, tag: string) => (pages.has(tag.toLowerCase()) ? `${lead}[[${tag}]]` : m));
  out = out.replace(/\^\^(?=\S)([^\n]*?\S)\^\^/g, "==$1==");
  out = out.replace(/(^|[^\w_])__(?=\S)([^\n_]*?\S)__(?!\w)/g, "$1*$2*");
  // übrige Roam-Bausteine ({{table}}, {{query}} …) bleiben sichtbar, ohne Klammern
  out = out.replace(/\{\{\[?\[?([\w -]+)\]?\]?(?::\s*([^}]*))?\}\}/g, (_m, kind: string, arg: string | undefined) => (arg ? arg.trim() : `{${kind.trim()}}`));
  return out;
}

export function convertRoam(pages: Record<string, Json>[], name: string): { files: ImportFiles; note: string; titles: Map<string, string> } {
  const blocks = new Map<string, string>();
  const index = (list: Json | undefined, depth: number) => {
    if (!Array.isArray(list) || depth > 200) return;
    for (const b of list) {
      if (!isObj(b)) continue;
      const uid = str(b.uid), text = str(b.string);
      if (uid !== undefined && text !== undefined) blocks.set(uid, text.replace(/\{\{\[?\[?(TODO|DONE)\]?\]?\}\}\s*/g, ""));
      index(b.children, depth + 1);
    }
  };
  for (const p of pages) index(p.children, 0);

  const pageNames = new Set(pages.map((p) => (str(p.title) ?? "").toLowerCase()));
  const files = new ImportFiles();
  const titles = new Map<string, string>();
  const unique = uniqueNamer();
  const enc = new TextEncoder();
  const write = (list: Json | undefined, depth: number, lines: string[]) => {
    if (!Array.isArray(list) || depth > 200) return;
    for (const b of list) {
      if (!isObj(b)) continue;
      let text = str(b.string) ?? "";
      let marker = "- ";
      const todo = /^\s*\{\{\[?\[?(TODO|DONE)\]?\]?\}\}\s*/.exec(text);
      if (todo) { marker = todo[1] === "DONE" ? "- [x] " : "- [ ] "; text = text.slice(todo[0].length); }
      text = roamInline(text, blocks, pageNames);
      const indent = "    ".repeat(depth);
      const h = num(b.heading);
      const fence = /^```/.test(text.trim());
      if (fence) {
        // Code-Block in einem Block: als eigener Block unter einem leeren Punkt wäre unschön – direkt als Code
        lines.push(...text.split("\n").map((l) => indent + l));
      } else if (h !== undefined && h >= 1 && h <= 3 && depth === 0) {
        lines.push("#".repeat(h) + " " + text.replaceAll("\n", " "));
      } else {
        const [first, ...more] = text.split("\n");
        lines.push(indent + marker + (first ?? ""));
        for (const l of more) lines.push(indent + "  " + l);
      }
      // Kinder einer Überschrift stehen eingerückt darunter nicht richtig: flach weiter
      write(b.children, h !== undefined && depth === 0 && !fence ? 0 : depth + 1, lines);
    }
  };
  for (const p of pages) {
    const title = str(p.title) ?? "Untitled";
    const lines: string[] = [];
    write(p.children, 0, lines);
    const file = unique(safeName(title)) + ".md";
    titles.set(file, title);
    files.add(file, enc.encode(lines.join("\n") + "\n"));
  }
  return { files, titles, note: `Roam Research graph “${name}”: ${pages.length} pages` };
}
