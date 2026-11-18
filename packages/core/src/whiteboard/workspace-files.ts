// Welche Dateien es im Workspace schon gibt (Bilder und Anhänge in Seiten, Dateien auf Boards, Datei-Properties) –
// damit ein Agent eine Datei auswählen und aufs Board legen kann, wie ein Mensch sie aus dem Workspace zieht.
// Gelesen wird nur, was die Records über eine Datei wissen (Name, Art, Größe, Bildmaße auf Boards); die Bytes liegen
// im Dateispeicher und kommen über den Host dazu (Server: erkennt Maße und PDF-Seiten aus den Bytes).
import type { WorkspaceStore } from "../store/store.js";
import { boardObjectFromBlock } from "./records.js";
import type { BoardFileInfo } from "./placefile.js";

const HASH = /^[0-9a-f]{64}$/;
export const fileRefOf = (hash: string) => `based-asset:${hash}`;

export type WorkspaceFile = BoardFileInfo;

/** Alle Dateien mit Adresse, die Records kennen; je Datei das Wissen aller Fundstellen zusammen. */
export function workspaceFiles(store: WorkspaceStore): Map<string, WorkspaceFile> {
  const out = new Map<string, WorkspaceFile>();
  const add = (hash: string, info: Partial<BoardFileInfo>) => {
    const ref = fileRefOf(hash);
    const cur = out.get(ref) ?? { ref, name: "", mime: "", size: 0 };
    if (!cur.name && info.name) cur.name = info.name;
    if (!cur.mime && info.mime) cur.mime = info.mime;
    if (!cur.size && info.size) cur.size = info.size;
    if (cur.width === undefined && info.width && info.height) { cur.width = info.width; cur.height = info.height; }
    out.set(ref, cur);
  };
  store.scanBlocks(['"name"'], (b) => {
    if (b.trashedAt) return;
    const wb = (b.props as { wb?: unknown } | undefined)?.wb;
    if (wb) {
      const o = boardObjectFromBlock(b);
      if (o && o.kind !== "connector" && (o.kind === "image" || o.kind === "file") && o.ref?.startsWith("based-asset:")) {
        const hash = o.ref.slice("based-asset:".length);
        if (HASH.test(hash)) {
          // Ein Bild auf dem Board kennt sein Seitenverhältnis (Breite × Höhe des Objekts).
          add(hash, { name: String(o.style?.name ?? ""), mime: String(o.style?.mime ?? ""), size: Number(o.style?.size ?? 0), ...(o.kind === "image" ? { width: o.w, height: o.h } : {}) });
        }
      }
      return;
    }
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.id === "string" && typeof o.name === "string" && HASH.test(o.id)) {
          add(o.id, { name: o.name, ...(typeof o.mime === "string" ? { mime: o.mime } : {}), ...(typeof o.size === "number" ? { size: o.size } : {}) });
        }
        for (const x of Object.values(o)) walk(x);
      }
    };
    walk(b.props);
    walk(b.values);
  });
  for (const f of out.values()) if (!f.name) f.name = `file-${f.ref.slice(-64, -56)}`;
  return out;
}
