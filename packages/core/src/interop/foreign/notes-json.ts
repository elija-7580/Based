// Simplenote (Export-ZIP mit „source/notes.json“) und Standard Notes (entschlüsselte Sicherung
// „Standard Notes Backup and Import File.txt“): Notizlisten als JSON → Datenbank mit einer Seite je Notiz.
import { basename, extname, ImportFiles } from "../files.js";
import { addTable, escapeText, isObj, isoCell, parseJSON, str, type Json, type TableRow } from "./table.js";

const ms = (v: Json | undefined) => { const s = str(v); const t = s === undefined ? NaN : Date.parse(s); return Number.isNaN(t) ? undefined : t; };
const tagCell = (tags: string[]) => tags.map((t) => t.replaceAll(",", " ")).join(", ");

function shallow(files: ImportFiles, root: string, depth: number): string[] {
  const prefix = root === "" ? "" : root + "/";
  return files.walk(root).filter((f) => f.slice(prefix.length).split("/").length <= depth);
}

export function convertSimplenote(files: ImportFiles, root: string): { files: ImportFiles; note: string } | undefined {
  const file = shallow(files, root, 3).find((f) => basename(f).toLowerCase() === "notes.json");
  const data = file !== undefined ? parseJSON(files.readText(file)) : undefined;
  if (!isObj(data) || !Array.isArray(data.activeNotes)) return undefined;
  const rows: TableRow[] = [];
  for (const n of data.activeNotes.filter(isObj)) {
    const content = (str(n.content) ?? "").replaceAll("\r\n", "\n");
    const nl = content.indexOf("\n");
    const first = (nl < 0 ? content : content.slice(0, nl)).trim();
    const rest = nl < 0 ? "" : content.slice(nl + 1);
    const markdown = n.markdown === true || (Array.isArray(n.systemTags) && n.systemTags.includes("markdown"));
    const tags = (Array.isArray(n.tags) ? n.tags : []).filter((t): t is string => typeof t === "string");
    rows.push({
      title: first.replace(/^#+\s*/, "") || "Untitled",
      cells: [tagCell(tags), isoCell(ms(n.creationDate)), isoCell(ms(n.lastModified)), n.pinned === true || (Array.isArray(n.systemTags) && n.systemTags.includes("pinned")) ? "Yes" : "No"],
      body: markdown ? rest : escapeText(rest),
    });
  }
  const out = new ImportFiles();
  addTable(out, { name: "Simplenote", titleColumn: "Note", columns: [{ name: "Tags", type: "multiSelect" }, { name: "Created", type: "date" }, { name: "Modified", type: "date" }, { name: "Pinned", type: "checkbox" }], rows });
  const trashed = Array.isArray(data.trashedNotes) ? data.trashedNotes.length : 0;
  return { files: out, note: `Simplenote: ${rows.length} notes${trashed > 0 ? ` (${trashed} in the trash left out)` : ""}` };
}

export function convertStandardNotes(files: ImportFiles, root: string): { files: ImportFiles; note: string } | undefined {
  const candidates = shallow(files, root, 2).filter((f) => ["txt", "json"].includes(extname(f).toLowerCase()) && (files.size(f) ?? 0) > 20);
  for (const f of candidates) {
    // nur Dateien, die wie die Sicherung beginnen (keine großen Textdateien parsen)
    const named = /standard notes|backup|decrypted|sn-/i.test(basename(f));
    const text = files.readText(f);
    if (text === undefined || !(named || /^\s*\{\s*"(version|items)"/.test(text.slice(0, 200)))) continue;
    const data = parseJSON(text);
    if (!isObj(data) || !Array.isArray(data.items) || !data.items.some((i) => isObj(i) && typeof i.content_type === "string")) continue;
    const items = data.items.filter(isObj);
    const notes = items.filter((i) => i.content_type === "Note");
    const encrypted = notes.filter((n) => !isObj(n.content)).length;
    // Tags verweisen auf Notizen
    const tagsOf = new Map<string, string[]>();
    for (const t of items) {
      if (t.content_type !== "Tag" || !isObj(t.content)) continue;
      const name = str(t.content.title);
      if (name === undefined) continue;
      for (const r of Array.isArray(t.content.references) ? t.content.references.filter(isObj) : []) {
        const id = str(r.uuid);
        if (id !== undefined) tagsOf.set(id, [...(tagsOf.get(id) ?? []), name]);
      }
    }
    const rows: TableRow[] = [];
    for (const n of notes) {
      if (!isObj(n.content) || n.content.trashed === true || n.deleted === true) continue;
      const text0 = str(n.content.text) ?? "";
      // „Super“-Notizen speichern ihren Inhalt als JSON des Editors; lesbar bleibt nur die Vorschau
      const superNote = n.content.noteType === "super" || /^\s*\{"root":/.test(text0);
      const body = superNote ? escapeText(str(n.content.preview_plain) ?? "") : text0;
      rows.push({
        title: (str(n.content.title) ?? "").trim() || "Untitled",
        cells: [tagCell(tagsOf.get(str(n.uuid) ?? "") ?? []), isoCell(ms(n.created_at)), isoCell(ms(n.updated_at)), n.content.pinned === true ? "Yes" : "No"],
        body,
      });
    }
    const out = new ImportFiles();
    addTable(out, { name: "Standard Notes", titleColumn: "Note", columns: [{ name: "Tags", type: "multiSelect" }, { name: "Created", type: "date" }, { name: "Updated", type: "date" }, { name: "Pinned", type: "checkbox" }], rows });
    return { files: out, note: `Standard Notes: ${rows.length} notes${encrypted > 0 ? ` — ${encrypted} are encrypted and were left out; export a decrypted backup to import them` : ""}` };
  }
  return undefined;
}
