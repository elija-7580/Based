// Exporte anderer Apps erkennen und in einen Dateibaum übersetzen, den die vorhandenen Importer lesen:
// - Liste von Notizen mit Angaben → CSV-Datenbank + eine Markdown-Seite je Zeile (Markdown-Import)
// - verlinkte Notizen in Ordnern → Markdown mit [[Wikilinks]] (Vault-Import)
// Erkannt wird am Inhalt, nicht am Dateinamen des Archivs. Alles hier ist rein (kein DOM, kein Netz).
import { basename, extname, ImportFiles } from "../files.js";
import { convertChats } from "./chats.js";
import { convertJoplin, joplinDir } from "./joplin.js";
import { convertKeep } from "./keep.js";
import { convertSimplenote, convertStandardNotes } from "./notes-json.js";
import { convertRoam, isRoamExport } from "./roam.js";
import { parseJSON } from "./table.js";

export interface ForeignExport {
  files: ImportFiles;
  /** Als Vault lesen (Ordner → Seiten, [[Links]] → Erwähnungen) statt als Markdown/CSV. */
  vault: boolean;
  /** Titel der Wurzelseite (Vault). */
  title?: string | undefined;
  /** Bezeichnung im Bericht („Roam Research graph“). */
  label?: string | undefined;
  /** Seitentitel je Datei, wo der Dateiname den Titel nicht tragen kann. */
  titles?: Map<string, string> | undefined;
  note: string;
}

/** Größte JSON-Datei, die zum Erkennen ganz gelesen wird. */
const MAX_SNIFF_BYTES = 400_000_000;

/**
 * Ist der Baum unter `root` der Export einer anderen App? Gibt den übersetzten Baum zurück, sonst `undefined`
 * (dann entscheiden die gewöhnlichen Regeln: Notion, Obsidian, Markdown …).
 */
export function convertForeignExport(files: ImportFiles, root: string, name: string): ForeignExport | undefined {
  const all = files.walk(root);
  if (all.length === 0) return undefined;
  const names = new Set(all.map((f) => basename(f).toLowerCase()));

  // ChatGPT / Claude
  if ([...names].some((n) => /^conversations(-\d+)?\.json$/.test(n))) {
    const r = convertChats(files, root);
    if (r) return { ...r, vault: false };
  }
  // Joplin (JEX entpackt oder RAW-Ordner)
  if (all.some((f) => /^[0-9a-f]{32}\.md$/i.test(basename(f)))) {
    const dir = joplinDir(files, root);
    if (dir !== undefined) {
      const r = convertJoplin(files, dir);
      return { ...r, vault: true, title: name === "" ? "Joplin" : name, label: "Joplin export" };
    }
  }
  // Simplenote
  if (names.has("notes.json")) {
    const r = convertSimplenote(files, root);
    if (r) return { ...r, vault: false };
  }
  const json = all.filter((f) => extname(f).toLowerCase() === "json");
  // Roam Research: eine JSON-Datei (auch im ZIP), sonst nichts Lesbares daneben
  if (json.length === 1 && !all.some((f) => ["md", "html", "htm", "csv"].includes(extname(f).toLowerCase())) && (files.size(json[0]!) ?? 0) < MAX_SNIFF_BYTES) {
    const data = parseJSON(files.readText(json[0]!));
    if (isRoamExport(data)) {
      const graph = basename(json[0]!).replace(/\.json$/i, "");
      const r = convertRoam(data, graph);
      return { ...r, vault: true, title: graph, label: "Roam Research graph" };
    }
  }
  // Standard Notes (entschlüsselte Sicherung)
  if (all.some((f) => ["txt", "json"].includes(extname(f).toLowerCase()))) {
    const r = convertStandardNotes(files, root);
    if (r) return { ...r, vault: false };
  }
  // Google Keep (Takeout)
  if (json.length > 0) {
    const r = convertKeep(files, root);
    if (r) return { ...r, vault: false };
  }
  return undefined;
}
