// BSD-260 Teil 8: Logseq-Graph (Ordner mit pages/ und journals/, oft logseq/config.edn). Logseq ist ein Outliner auf
// Markdown – der Obsidian-Import liest ihn, vorher werden die Logseq-Eigenheiten übersetzt (reine Funktionen):
// - Seiten-Properties `key:: value` in den ersten Zeilen → YAML-Frontmatter (`alias::` → `aliases`, zählen für Links)
// - Block-Properties `id::` und `collapsed::` fallen weg; `((uuid))` → Text des Blocks mit dieser id, sonst weg
// - Dateinamen: Namensräume `A___B.md` bzw. `A%2FB.md` → „A/B“; Journale `journals/2026_11_12.md` → „Nov 12th, 2026“
//   (Logseqs Standard-Titel, damit [[Nov 12th, 2026]] trifft)
// - `logseq/` (Einstellungen, Sicherungen) und `.recycle` werden nicht importiert.
import { basename, dirname, joinPath, normalizePath, stripExtension, type ImportFiles } from "./files.js";

const PROP = /^([A-Za-z0-9_-]+)::[ \t]*(.*)$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function isLogseqGraph(files: ImportFiles, root: string): boolean {
  const r = normalizePath(root);
  return files.isFile(joinPath(r, "logseq/config.edn")) || (files.isDirectory(joinPath(r, "pages")) && files.isDirectory(joinPath(r, "journals")));
}

/** Pfade, die nicht zum Inhalt gehören. */
export const logseqSkip = (rel: string) => rel === "logseq" || rel.startsWith("logseq/") || rel.split("/").includes(".recycle");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ordinal = (d: number) => d + (d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th");

/** Seitentitel aus dem Dateipfad (relativ zum Graph). */
export function logseqTitle(rel: string): string {
  const name = basename(stripExtension(rel));
  const j = /^(\d{4})_(\d{2})_(\d{2})$/.exec(name);
  if (j && dirname(rel).split("/").includes("journals")) {
    const m = Number(j[2]), d = Number(j[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${MONTHS[m - 1]} ${ordinal(d)}, ${j[1]}`;
  }
  let t = name.replace(/___/g, "/");
  try { t = decodeURIComponent(t); } catch { /* Name bleibt */ }
  return t;
}

/** Block-Texte nach `id::` (für `((uuid))`): die Zeile des Blocks vor der id. */
export function logseqBlockIDs(text: string, into = new Map<string, string>()): Map<string, string> {
  const lines = text.split(/\r?\n/);
  let lastBlock = "";
  for (const line of lines) {
    const b = /^\s*- (.*)$/.exec(line);
    if (b) { lastBlock = b[1]!; continue; }
    const p = /^\s*id::\s*(\S+)\s*$/.exec(line);
    if (p && UUID.test(p[1]!)) into.set(p[1]!.toLowerCase(), lastBlock);
  }
  return into;
}

const TASK = /^(\s*- )(TODO|DOING|NOW|LATER|WAITING|WAIT|IN-PROGRESS|DONE|CANCELED|CANCELLED)\s+(.*)$/;
const ADMONITION: Record<string, string> = { NOTE: "note", TIP: "tip", IMPORTANT: "important", WARNING: "warning", CAUTION: "caution", PINNED: "important" };

/** Logseq-Schreibweisen je Zeile: Aufgaben-Marken, Zitat-/Hinweis-Blöcke (#+BEGIN_…), Bildgrößen, Hervorhebung. */
function logseqBlocks(lines: string[]): string[] {
  const out: string[] = [];
  let fence = false;
  /** offener #+BEGIN-Block: Präfix der Zeilen und ob die erste Inhaltszeile noch aussteht */
  let open: { prefix: string; kind: string; first: boolean } | undefined;
  for (const raw of lines) {
    if (/^\s*(- )?(```|~~~)/.test(raw)) fence = !fence;
    if (fence) { out.push(raw); continue; }
    let l = raw;
    const begin = /^(\s*)(- )?#\+BEGIN_([A-Z]+)\s*$/i.exec(l);
    if (begin && !open) {
      const kind = begin[3]!.toUpperCase();
      if (kind === "SRC" || kind === "EXAMPLE" || kind === "EXPORT") { out.push(l); continue; }
      // der Block steht an der Stelle seines Punkts (gleiche Einrückung)
      open = { prefix: begin[1]!, kind, first: true };
      continue;
    }
    if (open) {
      // Leerzeile danach: zwei Blöcke hintereinander bleiben zwei
      if (/^\s*#\+END_[A-Z]+\s*$/i.test(l)) { open = undefined; out.push(""); continue; }
      const text = l.trim();
      const head = open.first && ADMONITION[open.kind] !== undefined ? `> [!${ADMONITION[open.kind]}]\n${open.prefix}> ` : "> ";
      out.push(open.prefix + head + text);
      open.first = false;
      continue;
    }
    const t = TASK.exec(l);
    if (t) l = `${t[1]}[${t[2] === "DONE" ? "x" : t[2] === "CANCELED" || t[2] === "CANCELLED" ? "-" : " "}] ${t[3]}`;
    // Größenangabe hinter Bildern: ![x](y){:height 200, :width 300}
    l = l.replace(/(\]\([^)\n]*\))\{:[^}\n]*\}/g, "$1");
    // ^^Hervorheben^^ → ==Hervorheben== (liest der Vault-Import)
    l = l.replace(/\^\^(?=\S)([^\n]*?\S)\^\^/g, "==$1==");
    // {{embed [[Seite]]}} / {{embed ((id))}} → der Verweis selbst
    l = l.replace(/\{\{embed\s+(\[\[[^\]\n]+\]\]|\(\([0-9a-f-]{36}\)\))\s*\}\}/gi, "$1");
    out.push(l);
  }
  return out;
}

const yamlValue = (v: string) => (/^[\w ./-]*$/.test(v) && v.trim() === v && v !== "" ? v : JSON.stringify(v));

/** Logseq-Markdown → Markdown, wie es der Obsidian-Import liest. */
export function logseqToMarkdown(text: string, blocks: ReadonlyMap<string, string> = new Map()): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Seiten-Properties: zusammenhängend am Anfang (auch als erster Block „- key:: v“ ohne weiteren Text)
  const props: [string, string][] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const m = PROP.exec(raw.replace(/^- /, "").trim());
    if (!m || (raw.startsWith("- ") && props.length > 0)) break;
    props.push([m[1]!.toLowerCase(), m[2]!]);
    i++;
  }
  let body = lines.slice(i);
  // Block-Properties, die nur Logseq braucht. Steht die Property in der Zeile des Punkts („- collapsed:: true“, der
  // Text folgt eingerückt), bleibt der Punkt und bekommt die nächste Zeile als Text.
  const kept: string[] = [];
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    const own = /^(\s*)- (?:id|collapsed)::/.exec(l);
    if (own) {
      const next = body[k + 1];
      if (next !== undefined && /^\s+\S/.test(next) && !/^\s*- /.test(next) && !/^\s*(?:id|collapsed)::/.test(next)) { kept.push(own[1]! + "- " + next.trim()); k++; }
      continue;
    }
    if (/^\s*(id|collapsed)::/.test(l)) continue;
    kept.push(l);
  }
  body = logseqBlocks(kept);
  let out = body.join("\n").replace(/\(\(([0-9a-f-]{36})\)\)/gi, (_m, id: string) => blocks.get(id.toLowerCase()) ?? "");
  // leere Aufzählungspunkte (nur „-“) weg
  out = out.replace(/^\s*-\s*$/gm, "");
  if (props.length === 0) return out;
  const yaml = props.map(([k, v]) => {
    if (k === "alias" || k === "aliases" || k === "tags") {
      const list = v.split(",").map((x) => x.trim().replace(/^\[\[(.*)\]\]$/, "$1").replace(/^#/, "")).filter(Boolean);
      return `${k === "alias" ? "aliases" : k}: [${list.map(yamlValue).join(", ")}]`;
    }
    return `${k}: ${yamlValue(v)}`;
  }).join("\n");
  return `---\n${yaml}\n---\n${out.replace(/^\n+/, "")}`;
}
