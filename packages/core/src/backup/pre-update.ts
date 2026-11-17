// BSD-456: Sicherung vor jedem App-Update – auch ohne lokalen Server. Bevor die Desktop-App ein Update installiert,
// legt sie den ganzen Workspace als Based-Archiv (`.based.zip`, wie „Export → Based archive“: alle Records und Dateien)
// in einen Ordner je App (Hülle: ~/Library/Application Support/<bundle-id>/pre-update) und behält die letzten drei.
// Bei sehr vielen Dateien (> 300 MB) sichert die App nur die Records (`.based.jsonl`) – die Dateien bleiben beim
// Update im App-Speicher. Die Datei wird nach dem Schreiben zurückgelesen und geprüft; geht etwas schief, installiert die Hülle das Update
// nicht und sagt in einem Satz, warum. Wiederherstellen: über den normalen Archiv-Import (Settings → Import).
// Plattformneutral: das Dateisystem liefert die Hülle (`BackupTarget`, Pfade relativ zum pre-update-Ordner).
import { isArchive, loadArchive } from "../interop/archive.js";
import type { BackupTarget } from "./backup.js";

export const PRE_UPDATE_DIR = "pre-update";
export const PRE_UPDATE_KEEP = 3;
const NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z) .+\.based\.(zip|jsonl)$/;

const safeVersion = (v: string) => (v.trim().replace(/[^0-9A-Za-z.+-]/g, "_").slice(0, 40) || "unknown");

/**
 * `2026-11-17T03-30-00Z Based 0.2.2 before 0.2.3.based.zip` – sortiert nach Zeit, sagt, welches Update folgte.
 * `.based.jsonl`, wenn nur die Records gesichert wurden (großer Workspace, siehe apps/web worker/interop.ts).
 */
export function preUpdateName(at: Date, from: string, to: string, recordsOnly = false): string {
  const stamp = at.toISOString().slice(0, 19).replace(/:/g, "-") + "Z";
  return `${stamp} Based ${safeVersion(from)} before ${safeVersion(to)}${recordsOnly ? ".based.jsonl" : ".based.zip"}`;
}

/** Zu löschende Sicherungen: alle eigenen außer den neuesten `keep`; fremde Dateien bleiben. */
export function preUpdateToPrune(names: readonly string[], keep = PRE_UPDATE_KEEP): string[] {
  const own = names.filter((n) => NAME.test(n)).sort().reverse();
  return own.slice(Math.max(0, keep));
}

export type PreUpdateResult =
  | { ok: true; name: string; bytes: number; records: number; pruned: string[] }
  | { ok: false; message: string };

/**
 * Archiv erzeugen, schreiben, zurücklesen und prüfen, dann aufräumen. Wirft nie: Fehler kommen als `ok: false` mit
 * einem Satz für den Dialog zurück.
 */
export async function writePreUpdateBackup(
  target: BackupTarget,
  input: { archive: () => Promise<Uint8Array>; from: string; to: string; now?: Date; keep?: number },
): Promise<PreUpdateResult> {
  const fail = (what: string, e?: unknown): PreUpdateResult => {
    const detail = e === undefined ? "" : `: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200)}`;
    return { ok: false, message: `${what}${detail}` };
  };
  let zip: Uint8Array;
  try {
    zip = await input.archive();
  } catch (e) {
    return fail("Your workspace couldn't be copied", e);
  }
  if (!isArchive(zip)) return fail("The copy of your workspace was incomplete");
  const expected = loadArchive(zip).read.records.length;
  const isZip = zip.length >= 4 && zip[0] === 0x50 && zip[1] === 0x4b;
  const name = preUpdateName(input.now ?? new Date(), input.from, input.to, !isZip);
  try {
    await target.write(name, zip);
  } catch (e) {
    return fail("The copy couldn't be saved", e);
  }
  try {
    const back = await target.read(name);
    if (back.length !== zip.length || loadArchive(back).read.records.length !== expected) return fail("The saved copy didn't match your workspace");
  } catch (e) {
    return fail("The saved copy couldn't be read back", e);
  }
  // Aufräumen ist nicht kritisch: ein Fehler hier hält das Update nicht auf.
  let pruned: string[] = [];
  try {
    pruned = preUpdateToPrune(await target.list(""), input.keep ?? PRE_UPDATE_KEEP);
    for (const old of pruned) await target.remove(old);
  } catch {
    pruned = [];
  }
  return { ok: true, name, bytes: zip.length, records: expected, pruned };
}

/** Text für den Dialog, wenn die Sicherung scheitert (das Update wird dann nicht installiert). */
export function preUpdateFailureText(message: string): string {
  return `The update wasn't installed, because Based couldn't save a copy of your workspace first (${message.replace(/[.\s]+$/, "")}). Your data is unchanged — try again, or export a Based archive first.`;
}
