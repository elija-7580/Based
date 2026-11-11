// BSD-260 Teil 1: Obsidian-Vault importieren (Ordner oder ZIP mit `.obsidian/`). Rein, ohne DOM.
// - Ordner → Seiten (eine Notiz mit dem Namen des Ordners wird dessen Seite: „Folder Note“), Notizen → Seiten;
//   Titel = Dateiname (wie in Obsidian); eine erste „# Titel“-Zeile mit demselben Namen fällt weg.
// - [[Wikilinks]] (mit |Alias, #Überschrift, ^Block, Pfad) → Erwähnungen; Auflösung wie Obsidian: Pfad, sonst Name
//   im selben Ordner, sonst kürzester Pfad; `aliases` aus dem Frontmatter zählen mit. Unaufgelöst: Text bleibt.
// - ![[Einbettungen]]: Bilder, PDF, Audio, Video, andere Dateien als Datei-Blöcke (Datei in den Speicher); eingebettete
//   Notizen als Erwähnung. Standard-Markdown-Links und -Bilder auf Vault-Dateien ebenso.
// - Frontmatter (YAML) bleibt erhalten: als „Properties“-Codeblock (yaml) oben auf der Seite – Seiten außerhalb von
//   Datenbanken haben in Based keine Properties.
// - %%Kommentare%% und ^Block-IDs fallen weg; Callouts (> [!note]) liest der Markdown-Parser.
// - .obsidian/, .trash/, Punkt-Dateien und .canvas werden übersprungen (Canvas mit Hinweis).
import type { BlockProps, WireRecord } from "../model/records.js";
import { keyBetween, keysBetween } from "../sortkeys.js";
import { AssetRejected, emptyReport, importAssetFrom, makeBlock, makeRecordID, mimeFor, type AssetRef, type AssetSink, type ImportReport } from "./builder.js";
import { basename, comparePaths, dirname, extname, joinPath, normalizePath, stripExtension, type ImportFiles } from "./files.js";
import { trimSpaces } from "./html.js";
import { MarkdownImporter, type MarkdownBlock } from "./markdown.js";
import { PLAIN, toRichText } from "./runs.js";
import { ImportCancelled } from "./zip.js";

export interface ObsidianImportOptions {
  assets?: AssetSink | undefined;
  now?: (() => number) | undefined;
  userID?: string | null | undefined;
  isCancelled?: (() => boolean) | undefined;
  progress?: ((fraction: number) => void) | undefined;
}

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "heic"]);
const VIDEO = new Set(["mp4", "m4v", "mov", "webm", "ogv", "mkv"]);
const AUDIO = new Set(["mp3", "m4a", "wav", "ogg", "flac", "aac", "webm", "3gp"]);
const NOTE_LINK = "obsidian-note:";
const ASSET_LINK = "obsidian-file:";

const hidden = (p: string) => p.split("/").some((s) => s.startsWith("."));

/** Liegt unter `path` ein Obsidian-Vault? Gibt den Vault-Ordner zurück (der Ordner mit `.obsidian/`, sonst `path`, wenn
 *  seine Notizen [[Wikilinks]] enthalten). */
export function findObsidianVault(files: ImportFiles, path: string): string | undefined {
  const root = normalizePath(path);
  let best: string | undefined;
  for (const f of files.walk(root)) {
    const i = f.split("/").indexOf(".obsidian");
    if (i < 0) continue;
    const vault = f.split("/").slice(0, i).join("/");
    if (best === undefined || vault.length < best.length) best = vault;
  }
  if (best === undefined && (files.isDirectory(joinPath(root, ".obsidian")))) best = root;
  if (best !== undefined) return best;
  // Ohne `.obsidian/` (Browser lassen Punkt-Ordner beim Ordner-Wählen oft weg; Logseq/Foam): Markdown mit [[Wikilinks]]
  // und kein HTML-Export.
  const all = files.walk(root).filter((f) => !hidden(f));
  if (all.some((f) => ["html", "htm"].includes(extname(f).toLowerCase()))) return undefined;
  const md = all.filter((f) => extname(f).toLowerCase() === "md").slice(0, 200);
  return md.some((f) => /!?\[\[[^\]\n]+\]\]/.test(files.readText(f) ?? "")) ? root : undefined;
}

/** Einfaches YAML-Frontmatter abtrennen (`---` … `---` am Anfang). */
export function splitFrontmatter(md: string): { yaml: string | undefined; body: string } {
  const text = md.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  if (!text.startsWith("---\n")) return { yaml: undefined, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { yaml: undefined, body: text };
  const after = text.indexOf("\n", end + 4);
  const closing = text.slice(end + 1, after < 0 ? undefined : after);
  if (trimSpaces(closing) !== "---") return { yaml: undefined, body: text };
  return { yaml: text.slice(4, end), body: after < 0 ? "" : text.slice(after + 1) };
}

/** `aliases` (Liste oder Einzelwert) aus einfachem YAML. */
export function yamlList(yaml: string, key: string): string[] {
  const lines = yaml.split("\n");
  const out: string[] = [];
  const unquote = (s: string) => trimSpaces(s).replace(/^["']|["']$/g, "");
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^${key}\\s*:\\s*(.*)$`, "i").exec(lines[i]!);
    if (!m) continue;
    const v = trimSpaces(m[1]!);
    if (v.startsWith("[") && v.endsWith("]")) return v.slice(1, -1).split(",").map(unquote).filter((s) => s !== "");
    if (v !== "") return [unquote(v)];
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s+(.*)$/.exec(lines[j]!);
      if (!item) break;
      out.push(unquote(item[1]!));
    }
    return out.filter((s) => s !== "");
  }
  return out;
}

/** Ein Ziel wie `Folder/Note#Heading|Alias` zerlegen. */
export function parseWikiTarget(inner: string): { target: string; alias: string | undefined; heading: string | undefined } {
  const bar = inner.indexOf("|");
  const head = bar < 0 ? inner : inner.slice(0, bar);
  const alias = bar < 0 ? undefined : trimSpaces(inner.slice(bar + 1));
  const hash = head.indexOf("#");
  const target = trimSpaces(hash < 0 ? head : head.slice(0, hash));
  const heading = hash < 0 ? undefined : trimSpaces(head.slice(hash + 1).replace(/^\^/, ""));
  return { target, alias: alias === "" ? undefined : alias, heading: heading === "" ? undefined : heading };
}

/** Text außerhalb von Inline-Code bearbeiten (`code` bleibt unberührt). */
function outsideCode(line: string, f: (s: string) => string): string {
  const parts = line.split(/(`+[^`]*`+)/);
  return parts.map((p, i) => (i % 2 === 1 ? p : f(p))).join("");
}

export class ObsidianImporter {
  private records: WireRecord[] = [];
  private report = emptyReport();
  private readonly now: () => number;
  private readonly userID: string | null;
  /** Notiz-Pfad (ohne .md, klein) und Name/Alias (klein) → Notiz-Pfade. */
  private byPath = new Map<string, string>();
  private byName = new Map<string, string[]>();
  /** Datei-Name (klein) → Pfade (Anhänge). */
  private filesByName = new Map<string, string[]>();
  private ids = new Map<string, string>();
  private assetCache = new Map<string, AssetRef>();
  private folderNotes = new Set<string>();
  private done = 0;
  private total = 1;

  constructor(private readonly files: ImportFiles, private readonly vault: string, private readonly opts: ObsidianImportOptions = {}) {
    this.now = opts.now ?? (() => (Date.now() - 978_307_200_000) / 1000);
    this.userID = opts.userID === undefined ? "me" : opts.userID;
  }

  private rel(p: string): string {
    return this.vault === "" ? p : p.slice(this.vault.length + 1);
  }

  private index() {
    const all = this.files.walk(this.vault).filter((p) => !hidden(this.rel(p)));
    for (const p of all) {
      const ext = extname(p).toLowerCase();
      if (ext === "md") {
        const id = makeRecordID();
        this.ids.set(p, id);
        this.byPath.set(stripExtension(this.rel(p)).toLowerCase(), p);
        const name = basename(stripExtension(p)).toLowerCase();
        this.byName.set(name, [...(this.byName.get(name) ?? []), p]);
        const fm = splitFrontmatter(this.files.readText(p) ?? "").yaml;
        if (fm) for (const a of [...yamlList(fm, "aliases"), ...yamlList(fm, "alias")]) {
          const k = a.toLowerCase();
          this.byName.set(k, [...(this.byName.get(k) ?? []), p]);
        }
      } else {
        const n = basename(p).toLowerCase();
        this.filesByName.set(n, [...(this.filesByName.get(n) ?? []), p]);
      }
    }
    this.total = Math.max(1, this.ids.size);
  }

  /** Obsidian-Auflösung: Pfad (relativ zum Vault oder zur Notiz), sonst Name – gleicher Ordner, dann kürzester Pfad. */
  private pick(candidates: string[] | undefined, from: string): string | undefined {
    if (!candidates || candidates.length === 0) return undefined;
    const same = candidates.find((c) => dirname(c) === dirname(from));
    if (same) return same;
    return [...candidates].sort((a, b) => a.split("/").length - b.split("/").length || comparePaths(a, b))[0];
  }

  resolveNote(target: string, from: string): string | undefined {
    const t = target.replace(/\.md$/i, "");
    if (t === "") return undefined;
    if (t.includes("/")) {
      const viaVault = this.byPath.get(normalizePath(t).toLowerCase());
      if (viaVault) return viaVault;
      const relative = normalizePath(joinPath(dirname(from), t));
      return this.byPath.get(stripExtension(this.rel(relative + ".md")).toLowerCase());
    }
    return this.pick(this.byName.get(t.toLowerCase()), from);
  }

  resolveFile(target: string, from: string): string | undefined {
    if (target.includes("/")) {
      for (const c of [joinPath(this.vault, target), joinPath(dirname(from), target)]) {
        const n = normalizePath(c);
        if (this.files.isFile(n)) return n;
      }
    }
    return this.pick(this.filesByName.get(basename(target).toLowerCase()), from);
  }

  /** Wikilinks, Einbettungen, Kommentare, Block-IDs → Standard-Markdown mit internen Zielen. */
  rewrite(body: string, from: string): string {
    const out: string[] = [];
    let fence: string | undefined;
    let inComment = false;
    for (const raw of body.split("\n")) {
      const f = /^\s*(```+|~~~+)/.exec(raw)?.[1];
      if (fence !== undefined) {
        out.push(raw);
        if (f !== undefined && f[0] === fence[0] && f.length >= fence.length) fence = undefined;
        continue;
      }
      if (f !== undefined && !inComment) { fence = f; out.push(raw); continue; }
      // %%Kommentare%% (auch über mehrere Zeilen)
      let line = "";
      let rest = raw;
      while (rest !== "") {
        const i = rest.indexOf("%%");
        if (i < 0) { if (!inComment) line += rest; break; }
        if (!inComment) line += rest.slice(0, i);
        inComment = !inComment;
        rest = rest.slice(i + 2);
      }
      if (inComment && line.trim() === "") continue;
      line = line.replace(/\s+\^[A-Za-z0-9-]+\s*$/, "");
      out.push(outsideCode(line, (s) => this.rewriteLinks(s, from)));
    }
    return out.join("\n");
  }

  private rewriteLinks(s: string, from: string): string {
    const enc = (p: string) => encodeURIComponent(p);
    s = s.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (_m, bang: string, inner: string) => {
      const { target, alias, heading } = parseWikiTarget(inner);
      const label = (alias && !/^\d+(x\d+)?$/.test(alias) ? alias : undefined) ?? (target === "" ? heading ?? "" : basename(target) + (heading && !bang ? ` › ${heading}` : ""));
      const ext = extname(target).toLowerCase();
      if (bang && ext !== "" && ext !== "md") {
        const file = this.resolveFile(target, from);
        if (file) return `\n![${basename(file)}](${ASSET_LINK}${enc(file)})\n`;
        this.warn(`Missing file “${target}” embedded in ${basename(from)}`);
        return label;
      }
      const note = target === "" ? undefined : this.resolveNote(target, from);
      if (note) return `[${label.replaceAll("]", "\\]")}](${NOTE_LINK}${enc(note)})`;
      return label;
    });
    // Standard-Markdown auf Vault-Dateien: ![](Anhang.png), [Text](Notiz.md)
    s = s.replace(/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g, (m, bang: string, text: string, href: string) => {
      if (href.includes("://") || href.startsWith(NOTE_LINK) || href.startsWith(ASSET_LINK) || href.startsWith("#") || href.startsWith("mailto:")) return m;
      let target: string;
      try { target = decodeURIComponent(href.replace(/^<|>$/g, "")); } catch { target = href; }
      const ext = extname(target.split("#")[0]!).toLowerCase();
      if (ext === "md" || ext === "") {
        const note = this.resolveNote(target.split("#")[0]!, from);
        return note ? `[${text}](${NOTE_LINK}${enc(note)})` : m;
      }
      const file = this.resolveFile(target, from);
      if (!file) return m;
      return bang ? `\n![${text}](${ASSET_LINK}${enc(file)})\n` : `\n![${text || basename(file)}](${ASSET_LINK}${enc(file)})\n`;
    });
    return s;
  }

  private warn(w: string) {
    if (!this.report.warnings.includes(w)) this.report.warnings.push(w);
  }

  private asset(path: string): { url?: string; asset?: AssetRef } {
    const cached = this.assetCache.get(path);
    if (cached) return { asset: cached };
    if (!this.opts.assets) return { url: basename(path) };
    try {
      const files = this.files;
      const ref = importAssetFrom(this.opts.assets, { size: files.size(path) ?? 0, load: () => files.read(path) }, basename(path), mimeFor(extname(path)));
      if (!ref) { this.warn(`Couldn't read file “${this.rel(path)}”`); return { url: basename(path) }; }
      this.assetCache.set(path, ref);
      this.report.assets += 1;
      return { asset: ref };
    } catch (e) {
      this.warn(e instanceof AssetRejected ? e.message : `Couldn't copy file ${basename(path)}`);
      return { url: basename(path) };
    }
  }

  private put(r: WireRecord) { this.records.push(r); }

  private putBlock(item: MarkdownBlock, parent: string, sk: string) {
    const props: BlockProps = { ...item.props };
    let type = item.type;
    if (type === "image") {
      // ![[datei.pdf]] kommt als Bild aus dem Parser: Art nach der Endung.
      const ext = extname(props.asset?.name ?? props.url ?? "").toLowerCase();
      if (ext === "pdf") type = "pdf";
      else if (VIDEO.has(ext) && !AUDIO.has(ext)) type = "video";
      else if (AUDIO.has(ext)) type = "audio";
      else if (ext !== "" && !IMAGE.has(ext)) type = "file";
    }
    if (type === "table" && props.tableColumns === undefined) props.tableColumns = 2;
    const id = makeRecordID();
    this.put({ kind: "block", data: makeBlock({ id, type, parent, sk, text: toRichText(item.text), props, createdBy: this.userID }, this.now()) });
    const keys = keysBetween(item.children.length, undefined, undefined);
    item.children.forEach((c, i) => this.putBlock(c, "b:" + id, keys[i]!));
  }

  /** Notiz als Seite; `extra` = Kinder nach dem Inhalt (Ordner-Inhalt bei Folder Notes). */
  private note(p: string, parent: string, sk: string, id: string = this.ids.get(p) ?? makeRecordID(), children?: () => void): string {
    if (this.opts.isCancelled?.()) throw new ImportCancelled();
    const raw = this.files.readText(p) ?? "";
    const { yaml, body: afterYaml } = splitFrontmatter(raw);
    const title = basename(stripExtension(p));
    let body = afterYaml;
    const split = MarkdownImporter.splitTitle(body);
    if (split.title !== undefined && split.title.toLowerCase() === title.toLowerCase()) body = split.body;
    const importer = new MarkdownImporter({
      resolveLink: (target) => (target.startsWith(NOTE_LINK) ? this.ids.get(decodeURIComponent(target.slice(NOTE_LINK.length))) : undefined),
      resolveAsset: (src) => (src.startsWith(ASSET_LINK) ? this.asset(decodeURIComponent(src.slice(ASSET_LINK.length))) : { url: src }),
    });
    const blocks = importer.parse(this.rewrite(body, p));
    if (yaml !== undefined && trimSpaces(yaml) !== "") blocks.unshift({ type: "code", text: [{ t: yaml.replace(/\n+$/, ""), m: PLAIN }], props: { language: "yaml" }, children: [] });
    this.put({ kind: "block", data: makeBlock({ id, type: "page", parent, sk, text: title, createdBy: this.userID }, this.now()) });
    this.report.pages += 1;
    const keys = keysBetween(blocks.length, undefined, undefined);
    blocks.forEach((b, i) => this.putBlock(b, "b:" + id, keys[i]!));
    this.done += 1;
    this.opts.progress?.(Math.min(1, this.done / this.total));
    children?.();
    return id;
  }

  /** Ordner als Seite: Unterordner und Notizen (Ordner zuerst, dann Notizen, je nach Name). */
  private folder(dir: string, parent: string, sk: string, title: string): string {
    const entries = this.files.list(dir).filter((p) => !hidden(this.rel(p)) && !(dir === this.vault && basename(p) === ".obsidian"));
    const folderNote = entries.find((p) => this.files.isFile(p) && extname(p).toLowerCase() === "md" && basename(stripExtension(p)) === basename(dir));
    const fill = (pageID: string, startAfter: string | undefined) => {
      const dirs = entries.filter((p) => this.files.isDirectory(p) && !this.files.isFile(p)).sort((a, b) => comparePaths(basename(a), basename(b)));
      const notes = entries.filter((p) => this.files.isFile(p) && extname(p).toLowerCase() === "md" && p !== folderNote).sort((a, b) => comparePaths(basename(a), basename(b)));
      for (const c of entries) if (this.files.isFile(c) && extname(c).toLowerCase() === "canvas") this.warn(`Skipped ${this.rel(c)} (Obsidian Canvas isn't supported yet)`);
      let k = startAfter;
      for (const d of dirs) {
        if (!this.files.walk(d).some((f) => !hidden(this.rel(f)) && extname(f).toLowerCase() === "md")) continue; // reine Anhang-Ordner
        k = keyBetween(k, undefined);
        this.folder(d, "b:" + pageID, k, basename(d));
      }
      for (const n of notes) {
        k = keyBetween(k, undefined);
        this.note(n, "b:" + pageID, k);
      }
    };
    if (folderNote) {
      this.folderNotes.add(folderNote);
      const id = this.ids.get(folderNote)!;
      // Kinder nach dem Inhalt der Notiz: Schlüssel hinter den Inhaltsblöcken.
      return this.note(folderNote, parent, sk, id, () => {
        const last = [...this.records].reverse().find((r) => r.kind === "block" && r.data.parent === "b:" + id);
        fill(id, last && last.kind === "block" ? last.data.sk : undefined);
      });
    }
    const id = makeRecordID();
    this.put({ kind: "block", data: makeBlock({ id, type: "page", parent, sk, text: title, createdBy: this.userID }, this.now()) });
    this.report.pages += 1;
    fill(id, undefined);
    return id;
  }

  /** Den ganzen Vault als eine Seite (Titel = Vault-Name) unter `w` mit vorläufigem Schlüssel. */
  run(rootTitle?: string, afterKey?: string): { records: WireRecord[]; rootKeys: string[]; report: ImportReport } {
    this.index();
    const key = keyBetween(afterKey, undefined);
    const title = rootTitle ?? (this.vault === "" ? "Obsidian vault" : basename(this.vault));
    const id = this.folder(this.vault, "w", key, title);
    this.report.rootIDs.push(id);
    this.report.warnings.unshift(`Obsidian vault “${title}”: ${this.ids.size} notes`);
    this.opts.progress?.(1);
    return { records: this.records, rootKeys: [key], report: this.report };
  }
}
