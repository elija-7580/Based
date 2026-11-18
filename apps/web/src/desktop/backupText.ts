// Meldung nach „Restore“ in Einstellungen → Backups (BSD-274, BSD-558).

/** Text nach dem Wiederherstellen; nennt Dateien (Bilder, Anhänge), die weder hier noch im Backup lesbar waren. */
export function restoredMessage(at: number, missing: number = 0): string {
  const base = `Restored the backup from ${new Date(at).toLocaleString()}. The state before was backed up first – restore that one to undo.`;
  if (missing <= 0) return base;
  return `${base} ${missing === 1 ? "1 file (image or attachment) from this backup was" : `${missing} files (images or attachments) from this backup were`} not found and shows as missing.`;
}
