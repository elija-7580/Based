// Google Keep aus Google Takeout: je Notiz eine .json (und eine .html, die wir nicht brauchen) im Ordner „Keep“
// (der Ordnername ist übersetzt, z. B. „Notizen“ – erkannt wird am Inhalt der JSON-Dateien).
import { basename, dirname, extname, ImportFiles, joinPath, type LazyFile } from "../files.js";
import { addTable, escapeText, isObj, isoCell, num, parseJSON, str, type Json, type TableRow } from "./table.js";

const isKeepNote = (v: Json | undefined): v is Record<string, Json> =>
  isObj(v) && (typeof v.textContent === "string" || Array.isArray(v.listContent)) && (v.userEditedTimestampUsec !== undefined || v.createdTimestampUsec !== undefined || v.isTrashed !== undefined);

/** Ordner unter `root`, dessen JSON-Dateien Keep-Notizen sind. */
function keepDir(files: ImportFiles, root: string): string | undefined {
  const byDir = new Map<string, string[]>();
  for (const f of files.walk(root)) {
    if (extname(f).toLowerCase() !== "json") continue;
    const d = dirname(f);
    const list = byDir.get(d) ?? [];
    if (list.length < 3) list.push(f);
    byDir.set(d, list);
    if (byDir.size > 200) break;
  }
  for (const [d, sample] of byDir) {
    if (sample.some((f) => (files.size(f) ?? 0) < 5_000_000 && isKeepNote(parseJSON(files.readText(f))))) return d;
  }
  return undefined;
}

export function convertKeep(files: ImportFiles, root: string): { files: ImportFiles; note: string } | undefined {
  const dir = keepDir(files, root);
  if (dir === undefined) return undefined;
  const rows: (TableRow & { edited: number })[] = [];
  let trashed = 0;
  for (const f of files.list(dir).sort()) {
    if (extname(f).toLowerCase() !== "json" || !files.isFile(f)) continue;
    const n = parseJSON(files.readText(f));
    if (!isKeepNote(n)) continue;
    if (n.isTrashed === true) { trashed += 1; continue; }
    const lines: string[] = [];
    const attached = new Map<string, Uint8Array | LazyFile>();
    for (const a of Array.isArray(n.attachments) ? n.attachments.filter(isObj) : []) {
      const name = str(a.filePath);
      if (name === undefined) continue;
      // Takeout nennt in der JSON manchmal „.jpeg“, die Datei heißt „.jpg“
      const path = [joinPath(dir, name), joinPath(dir, name.replace(/\.jpeg$/i, ".jpg"))].find((p) => files.isFile(p));
      if (path === undefined) continue;
      const size = files.size(path) ?? 0;
      attached.set(basename(path), { size, load: () => files.read(path) });
      lines.push(`![](<${basename(path)}>)`, "");
    }
    if (Array.isArray(n.listContent)) {
      for (const item of n.listContent.filter(isObj)) lines.push(`- [${item.isChecked === true ? "x" : " "}] ${escapeText(str(item.text) ?? "").replaceAll("\n", " ")}`);
    } else {
      // Keep kennt nur Zeilen: jede Zeile ein Absatz, Leerzeilen bleiben Abstände
      lines.push(...escapeText(str(n.textContent) ?? "").split("\n").map((l) => (l.trim() === "" ? "" : l)));
    }
    for (const a of Array.isArray(n.annotations) ? n.annotations.filter(isObj) : []) {
      const url = str(a.url);
      if (url !== undefined && /^https?:\/\//i.test(url)) lines.push("", `[${url}](${url})`);
    }
    const usec = (v: Json | undefined) => { const x = num(v); return x === undefined ? undefined : x / 1000; };
    const labels = (Array.isArray(n.labels) ? n.labels : []).map((l) => (isObj(l) ? str(l.name) : undefined)).filter((s): s is string => s !== undefined && s !== "");
    const title = (str(n.title) ?? "").trim() || (str(n.textContent) ?? "").trim().split("\n")[0]!.slice(0, 80) || "Untitled";
    rows.push({
      title,
      cells: [labels.map((l) => l.replaceAll(",", " ")).join(", "), isoCell(usec(n.createdTimestampUsec)), isoCell(usec(n.userEditedTimestampUsec)), n.isPinned === true ? "Yes" : "No", n.isArchived === true ? "Yes" : "No"],
      body: lines.join("\n") + "\n",
      files: attached,
      edited: usec(n.userEditedTimestampUsec) ?? 0,
    });
  }
  // wie in Keep: angepinnte zuerst, dann zuletzt bearbeitete
  rows.sort((a, b) => Number(b.cells[3] === "Yes") - Number(a.cells[3] === "Yes") || b.edited - a.edited);
  const out = new ImportFiles();
  addTable(out, {
    name: "Google Keep", titleColumn: "Note",
    columns: [{ name: "Labels", type: "multiSelect" }, { name: "Created", type: "date" }, { name: "Edited", type: "date" }, { name: "Pinned", type: "checkbox" }, { name: "Archived", type: "checkbox" }],
    rows,
  });
  return { files: out, note: `Google Keep: ${rows.length} notes${trashed > 0 ? ` (${trashed} in the trash left out)` : ""}` };
}
