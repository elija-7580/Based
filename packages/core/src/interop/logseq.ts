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
  // Block-Properties, die nur Logseq braucht
  body = body.filter((l) => !/^\s*(- )?(id|collapsed)::/.test(l));
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
