// BSD-260 Teil 3: OPML (Gliederungen aus Workflowy, Dynalist, OmniOutliner, Logseq, Feed-Listen) ⇄ Based. Rein.
// Import: eine Seite (Titel aus <head><title> bzw. Dateiname), jede <outline> ein Listenpunkt mit Kindern;
// `_complete="true"` (Workflowy) → erledigtes To-do, `_note` → eingerückter Absatz, `url`/`htmlUrl`/`xmlUrl` → Link.
// Export: eine Seite als Gliederung – Textblöcke werden <outline text>, Kinder verschachtelt, To-dos mit
// `_complete`, Links als `url`, Unterseiten als eigene Zweige (Titel).
import type { Block, BlockProps, WireRecord } from "../model/records.js";
import type { WorkspaceStore } from "../store/store.js";
import { keyBetween, keysBetween } from "../sortkeys.js";
import { emptyReport, makeBlock, makeRecordID, type ImportReport } from "./builder.js";
import { decodeEntities, trimSpaces } from "./html.js";
import { plain, PLAIN, runsOf, toRichText, type Run } from "./runs.js";

export interface OutlineNode {
  text: string;
  note: string | undefined;
  url: string | undefined;
  complete: boolean;
  children: OutlineNode[];
}

const attrs = (tag: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/([A-Za-z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out.set(m[1]!, decodeEntities(m[3] ?? m[4] ?? ""));
  return out;
};

/** OPML lesen: Titel und Gliederung. Wirft bei Dateien ohne <opml>/<body>. */
export function parseOPML(xml: string): { title: string | undefined; outlines: OutlineNode[] } {
  if (!/<opml\b/i.test(xml)) throw new Error("Not an OPML file (no <opml> element)");
  const titleRaw = /<head\b[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/head>/i.exec(xml)?.[1];
  const bodyStart = xml.search(/<body\b[^>]*>/i);
  const root: OutlineNode = { text: "", note: undefined, url: undefined, complete: false, children: [] };
  if (bodyStart < 0) return { title: titleRaw ? trimSpaces(decodeEntities(titleRaw)) : undefined, outlines: [] };
  const stack: OutlineNode[] = [root];
  const re = /<(\/?)outline\b([^>]*?)(\/?)>/gi;
  re.lastIndex = bodyStart;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1] === "/") { if (stack.length > 1) stack.pop(); continue; }
    const a = attrs(m[2]!);
    const node: OutlineNode = {
      text: a.get("text") ?? a.get("title") ?? "",
      note: a.get("_note") || undefined,
      url: a.get("url") || a.get("htmlUrl") || a.get("xmlUrl") || undefined,
      complete: (a.get("_complete") ?? "").toLowerCase() === "true",
      children: [],
    };
    stack[stack.length - 1]!.children.push(node);
    if (m[3] !== "/") stack.push(node);
  }
  return { title: titleRaw ? trimSpaces(decodeEntities(titleRaw)) || undefined : undefined, outlines: root.children };
}

/** Text einer Gliederung: Outliner speichern oft etwas HTML (<b>, <i>, <a>) im Attribut – als Klartext lesen. */
function runsOfOutline(n: OutlineNode): Run[] {
  const text = decodeEntities(n.text.replace(/<[^>]+>/g, ""));
  if (n.url && /^https?:\/\//.test(n.url)) return [{ t: text || n.url, m: { link: n.url } }];
  return text === "" ? [] : [{ t: text, m: PLAIN }];
}

/** OPML als eine Seite unter `w` (vorläufiger Schlüssel nach `afterKey`). */
export function importOPML(xml: string, fallbackTitle: string, opts: { now?: (() => number) | undefined; userID?: string | null | undefined; afterKey?: string | undefined } = {}): { records: WireRecord[]; rootKeys: string[]; report: ImportReport } {
  const now = opts.now ?? (() => (Date.now() - 978_307_200_000) / 1000);
  const userID = opts.userID === undefined ? "me" : opts.userID;
  const { title, outlines } = parseOPML(xml);
  const records: WireRecord[] = [];
  const report = emptyReport();
  const pageID = makeRecordID();
  const key = keyBetween(opts.afterKey, undefined);
  records.push({ kind: "block", data: makeBlock({ id: pageID, type: "page", parent: "w", sk: key, text: title ?? fallbackTitle, createdBy: userID }, now()) });
  report.pages = 1;
  report.rootIDs.push(pageID);
  let items = 0;
  const put = (nodes: OutlineNode[], parent: string, keys: string[] = keysBetween(nodes.length, undefined, undefined)) => {
    nodes.forEach((n, i) => {
      const id = makeRecordID();
      items += 1;
      const props: BlockProps = n.complete ? { checked: true } : {};
      records.push({ kind: "block", data: makeBlock({ id, type: n.complete ? "todo" : "bulletedList", parent, sk: keys[i]!, text: toRichText(runsOfOutline(n)), props, createdBy: userID }, now()) });
      // Notiz als erstes Kind (Absatz), dann die Unterpunkte.
      const kk = keysBetween(n.children.length + (n.note ? 1 : 0), undefined, undefined);
      if (n.note) records.push({ kind: "block", data: makeBlock({ id: makeRecordID(), type: "text", parent: "b:" + id, sk: kk[0]!, text: n.note, createdBy: userID }, now()) });
      put(n.children, "b:" + id, n.note ? kk.slice(1) : kk);
    });
  };
  put(outlines, "b:" + pageID);
  report.warnings.push(`OPML “${title ?? fallbackTitle}”: ${items} items`);
  return { records, rootKeys: [key], report };
}

// MARK: Export

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("\n", "&#10;");
const linkOf = (b: Block): string | undefined => {
  for (const r of runsOf(b.text)) if (typeof r.m.link === "string" && /^https?:\/\//.test(r.m.link)) return r.m.link;
  const u = b.props?.url;
  return typeof u === "string" && /^https?:\/\//.test(u) ? u : undefined;
};
const SKIP = new Set(["divider", "tableOfContents", "breadcrumb", "columnList", "column", "databaseInline", "databasePage", "linkedDatabase"]);

/** Eine Seite als OPML 2.0. */
export function exportOPML(store: WorkspaceStore, pageID: string): { name: string; xml: string } {
  const page = store.blocks.get(pageID);
  if (!page) throw new Error("This page doesn't exist.");
  const title = plain(runsOf(page.text)) || "Untitled";
  const lines: string[] = [];
  const walk = (parent: string, depth: number) => {
    for (const id of store.children(parent)) {
      const b = store.blocks.get(id);
      if (!b) continue;
      if (b.type === "column" || b.type === "columnList") { walk("b:" + b.id, depth); continue; }
      if (SKIP.has(b.type)) continue;
      const text = b.type === "page" ? plain(runsOf(b.text)) || "Untitled" : plain(runsOf(b.text));
      const kids = store.children("b:" + b.id).length > 0;
      if (text.trim() === "" && !kids) continue;
      const at: string[] = [`text="${esc(text)}"`];
      if (b.type === "todo" && b.props?.checked) at.push(`_complete="true"`);
      const link = linkOf(b);
      if (link) at.push(`type="link"`, `url="${esc(link)}"`);
      const pad = "  ".repeat(depth + 2);
      if (kids) {
        lines.push(`${pad}<outline ${at.join(" ")}>`);
        walk("b:" + b.id, depth + 1);
        lines.push(`${pad}</outline>`);
      } else lines.push(`${pad}<outline ${at.join(" ")}/>`);
    }
  };
  walk("b:" + pageID, 0);
  const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">', "  <head>", `    <title>${esc(title)}</title>`, "  </head>", "  <body>", ...lines, "  </body>", "</opml>", ""].join("\n");
  const name = (title.replace(/[\\/:*?"<>|]/g, "-").trim() || "Untitled") + ".opml";
  return { name, xml };
}
