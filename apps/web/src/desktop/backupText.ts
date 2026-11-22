// Meldung nach „Restore“ in Einstellungen → Backups (BSD-274, BSD-558).

/** Text nach dem Wiederherstellen; nennt Dateien (Bilder, Anhänge), die weder hier noch im Backup lesbar waren. */
export function restoredMessage(at: number, missing: number = 0): string {
  const base = `Restored the backup from ${new Date(at).toLocaleString()}. The state before was backed up first – restore that one to undo.`;
  if (missing <= 0) return base;
  return `${base} ${missing === 1 ? "1 file (image or attachment) from this backup was" : `${missing} files (images or attachments) from this backup were`} not found and shows as missing.`;
}

/**
 * BSD-648: Satz vorn in der Rückfrage „Restore this backup?“, wenn der Stand unvollständig ist (abgeschnitten oder
 * unlesbare Zeilen). Das Wiederherstellen selbst bleibt wie es ist – die Rückfrage sagt nur klar, was passiert.
 */
export function damagedBackupText(d: { readable: number; expected: number } | undefined): string {
  if (!d) return "";
  return `This backup is damaged: only ${d.readable} of ${d.expected} records can be read. Restoring it makes your workspace match the readable part. `;
}
