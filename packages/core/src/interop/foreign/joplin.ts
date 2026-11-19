// Joplin: Export „JEX“ (tar) bzw. „RAW“ (Ordner). Jeder Eintrag ist eine Datei „<32 hex>.md“: Titel, Leerzeile,
// Inhalt, Leerzeile, dann Angaben „schlüssel: wert“ (id, parent_id, type_ …). type_: 1 Notiz, 2 Notizbuch,
// 4 Datei (liegt in resources/<id>.<endung>), 5 Tag, 6 Tag-Zuordnung. Wird in einen Ordnerbaum mit Markdown-Notizen
// übersetzt, den der Vault-Import liest; `:/<id>` wird zum Pfad der Datei bzw. Notiz.
import { basename, dirname, extname, ImportFiles } from "../files.js";
import { safeName, uniqueNamer } from "./table.js";

const ITEM = /^[0-9a-f]{32}\.md$/i;

interface Item { id: string; type: number; title: string; body: string; meta: Map<string, string> }

function parseItem(text: string): Item | undefined {
  const t = text.replaceAll("\r\n", "\n");
  // Angaben: der letzte Absatz aus „key: value“-Zeilen, der „type_:“ enthält
  const cut = t.lastIndexOf("\n\n");
  const metaText = cut < 0 ? t : t.slice(cut + 2);
  const meta = new Map<string, string>();
  for (const line of metaText.split("\n")) {
    const m = /^([a-z_]+): ?(.*)$/.exec(line);
    if (m) meta.set(m[1]!, m[2]!);
  }
  const type = Number(meta.get("type_"));
  const id = meta.get("id");
  if (!id || !Number.isFinite(type) || type <= 0) return undefined;
  const head = cut < 0 ? "" : t.slice(0, cut);
  const nl = head.indexOf("\n");
  const title = (nl < 0 ? head : head.slice(0, nl)).trim();
  const body = nl < 0 ? "" : head.slice(nl + 1).replace(/^\n+/, "");
  return { id, type, title, body, meta };
}

/** Ordner unter `root`, in dem Joplin-Einträge liegen. */
export function joplinDir(files: ImportFiles, root: string): string | undefined {
  const hit = files.walk(root).find((f) => ITEM.test(basename(f)) && /\ntype_: ?\d+\s*$/.test((files.readText(f) ?? "").slice(-400)));
  return hit === undefined ? undefined : dirname(hit);
}

export function convertJoplin(files: ImportFiles, dir: string): { files: ImportFiles; note: string; titles: Map<string, string> } {
  const items = new Map<string, Item>();
  for (const f of files.list(dir)) {
    if (!files.isFile(f) || !ITEM.test(basename(f))) continue;
    const it = parseItem(files.readText(f) ?? "");
    if (it) items.set(it.id, it);
  }
  // Dateien: resources/<id>.<endung>
  const resourceFile = new Map<string, string>();
  for (const f of files.walk(dir === "" ? "resources" : dir + "/resources")) {
    const id = basename(f).split(".")[0]!.toLowerCase();
    if (/^[0-9a-f]{32}$/.test(id)) resourceFile.set(id, f);
  }
  const out = new ImportFiles();
  const titles = new Map<string, string>();
  const enc = new TextEncoder();

  // Notizbücher → Ordnerpfade (eindeutige Namen je Ebene)
  const folderPath = new Map<string, string>();
  const namers = new Map<string, (n: string) => string>();
  const nameIn = (parent: string, name: string) => {
    let n = namers.get(parent);
    if (!n) namers.set(parent, (n = uniqueNamer()));
    return n(name);
  };
  const pathOf = (id: string, seen = new Set<string>()): string => {
    const known = folderPath.get(id);
    if (known !== undefined) return known;
    const it = items.get(id);
    if (!it || it.type !== 2 || seen.has(id)) return "";
    seen.add(id);
    const parent = it.meta.get("parent_id") ? pathOf(it.meta.get("parent_id")!, seen) : "";
    const p = (parent === "" ? "" : parent + "/") + nameIn(parent, safeName(it.title, "Notebook"));
    folderPath.set(id, p);
    return p;
  };
  for (const it of items.values()) if (it.type === 2) { const p = pathOf(it.id); if (p !== "") out.addDirectory(p); }

  // Dateien → „_resources/<name>“
  const resourcePath = new Map<string, string>();
  const resName = uniqueNamer();
  for (const it of items.values()) {
    if (it.type !== 4) continue;
    const src = resourceFile.get(it.id.toLowerCase());
    if (src === undefined) continue;
    const ext = extname(src) || it.meta.get("file_extension") || "";
    let name = safeName(it.meta.get("filename") || it.title || it.id, it.id);
    if (ext !== "" && extname(name).toLowerCase() !== ext.toLowerCase()) name += "." + ext;
    const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
    const dot = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
    const p = "_resources/" + resName(stem) + dot;
    resourcePath.set(it.id.toLowerCase(), p);
    const size = files.size(src) ?? 0;
    out.addLazy(p, { size, load: () => files.read(src) });
  }

  // Tags je Notiz
  const tagName = new Map<string, string>();
  for (const it of items.values()) if (it.type === 5) tagName.set(it.id, it.title);
  const tagsOf = new Map<string, string[]>();
  for (const it of items.values()) {
    if (it.type !== 6) continue;
    const note = it.meta.get("note_id"), tag = tagName.get(it.meta.get("tag_id") ?? "");
    if (note && tag) tagsOf.set(note, [...(tagsOf.get(note) ?? []), tag]);
  }

  // Notizen
  const notePath = new Map<string, string>();
  const notes = [...items.values()].filter((it) => it.type === 1);
  for (const it of notes) {
    const folder = it.meta.get("parent_id") ? pathOf(it.meta.get("parent_id")!) : "";
    const p = (folder === "" ? "" : folder + "/") + nameIn(folder, safeName(it.title)) + ".md";
    notePath.set(it.id.toLowerCase(), p);
    titles.set(p, it.title === "" ? "Untitled" : it.title);
  }
  const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  let conflicts = 0;
  for (const it of notes) {
    if (it.meta.get("is_conflict") === "1") conflicts += 1;
    const body = it.body.replace(/\]\(:\/([0-9a-f]{32})(#[^)\s]*)?\)/gi, (m, id: string) => {
      const target = resourcePath.get(id.toLowerCase()) ?? notePath.get(id.toLowerCase());
      return target === undefined ? m : `](/${encPath(target)})`;
    }).replace(/<img\b[^>]*\ssrc=["']:\/([0-9a-f]{32})["'][^>]*>/gi, (m, id: string) => {
      const target = resourcePath.get(id.toLowerCase());
      return target === undefined ? m : `![](/${encPath(target)})`;
    });
    const tags = tagsOf.get(it.id) ?? [];
    const head = tags.length > 0 ? `Tags: ${tags.map((t) => "#" + t.replace(/\s+/g, "-")).join(" ")}\n\n` : "";
    out.add(notePath.get(it.id.toLowerCase())!, enc.encode(head + body + "\n"));
  }
  return { files: out, titles, note: `Joplin: ${notes.length} notes in ${folderPath.size} notebooks${conflicts > 0 ? ` (${conflicts} conflict copies included)` : ""}` };
}
