// BSD-163 / BSD-61: Workspace-Antworten mit Quellen. Antwortet ein Agent aus den Seiten des Nutzers, zitiert er
// inline `[[block:<id>]]` bzw. `[[page:<id>]]` (IDs aus `search` und `read_page_blocks`). Das Transkript behält die
// Marker; beim Anzeigen werden sie nummerierte Links (¹ ² …) mit einer Liste „Sources“ (Seitentitel, zitierter
// Text). Ein Link öffnet die Seite und springt zum Block. Unbekannte IDs fallen weg; ein beim Streamen
// abgeschnittener Marker am Ende bleibt verborgen, bis sein Rest kommt. Port von Swift `Citations`.

export interface Citation {
  number: number;
  pageID: string;
  /** Fehlt, wenn die ganze Seite zitiert ist. */
  blockID?: string;
  title: string;
  snippet: string;
}

export interface CitedText {
  /** Markdown mit nummerierten Links statt Markern und der Quellenliste am Ende. */
  markdown: string;
  citations: Citation[];
}

export interface CitationMarker {
  kind: "block" | "page";
  id: string;
}

export const CITATION_INSTRUCTION = "When your answer uses the user's pages, cite each statement right after it with [[block:<block id>]] (or [[page:<page id>]] for a whole page), using ids from search results or read_page_blocks. Cite only ids you actually read; no source list of your own — Based shows the sources.";

const PATTERN = /\s?\[\[(block|page):\s*([A-Za-z0-9_-]{1,64})\s*\]\]/g;

export function citationMarkers(text: string): CitationMarker[] {
  return [...text.matchAll(PATTERN)].map((m) => ({ kind: m[1] as "block" | "page", id: m[2]! }));
}

/** Verbirgt einen Marker, der noch gestreamt wird („… [[blo“, „[[block:12ab“), am Ende von `text`. */
export function streamingSafe(text: string): string {
  const open = text.lastIndexOf("[[");
  if (open < 0) return text.endsWith("[") ? text.slice(0, -1) : text;
  const tail = text.slice(open);
  if (tail.includes("]]")) return text.endsWith("[") ? text.slice(0, -1) : text;
  const inner = tail.slice(2);
  const looks = "block:".startsWith(inner.slice(0, 6)) || "page:".startsWith(inner.slice(0, 5)) || inner.startsWith("block:") || inner.startsWith("page:");
  return looks ? text.slice(0, open).replace(/\s+$/, "") : text;
}

const SUPERSCRIPTS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];
export const superscript = (n: number) => [...String(n)].map((d) => SUPERSCRIPTS[Number(d)]).join("");

/** Standard-Link einer Quelle (die Web-App fängt ihn ab und springt zum Block). */
export const citationLink = (page: string, block?: string) => `based-cite:${page}${block ? "/" + block : ""}`;

/** `based-cite:<page>[/<block>]` → Seite und Block. */
export function citationTarget(href: string): { pageID: string; blockID?: string } | undefined {
  const m = /^based-cite:([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(href);
  if (!m) return undefined;
  return m[2] ? { pageID: m[1]!, blockID: m[2] } : { pageID: m[1]! };
}

export type CitationResolver = (kind: "block" | "page", id: string) => Omit<Citation, "number"> | undefined;

const escapeLinkText = (s: string) => s.replace(/[[\]]/g, (c) => "\\" + c);

/** Marker durch nummerierte Links ersetzen und die Quellen anhängen; dieselbe Quelle behält ihre Nummer. */
export function renderCitations(text: string, resolve: CitationResolver, opts: { streaming?: boolean; link?: (page: string, block?: string) => string } = {}): CitedText {
  const source = opts.streaming ? streamingSafe(text) : text;
  if (!source.includes("[[")) return { markdown: source, citations: [] };
  const link = opts.link ?? citationLink;
  const cites: Citation[] = [];
  const numbers = new Map<string, number>();
  const markdown = source.replace(PATTERN, (_all, kind: "block" | "page", id: string) => {
    const c = resolve(kind, id);
    if (!c) return "";
    const key = c.pageID + "/" + (c.blockID ?? "");
    let n = numbers.get(key);
    if (n === undefined) {
      n = cites.length + 1;
      numbers.set(key, n);
      cites.push({ ...c, number: n });
    }
    const cur = cites[n - 1]!;
    return `[${superscript(n)}](${link(cur.pageID, cur.blockID)})`;
  });
  if (cites.length === 0) return { markdown, citations: [] };
  const list = cites.map((c) => `${c.number}. [${escapeLinkText(c.title || "Untitled")}](${link(c.pageID, c.blockID)})${c.snippet ? " — " + c.snippet : ""}`).join("\n");
  return { markdown: `${markdown}\n\n**Sources**\n\n${list}`, citations: cites };
}
