// Präfixe in Props und Zwischenablage (früher mapping/bn.ts, mit BSD-407 Teil 4c ohne BlockNote).

/** Präfix für Dateien aus dem Asset-Speicher in `url`-Props der Medienblöcke. */
export const ASSET_URL_PREFIX = "based-asset:";
/** „Copy and sync“ legt das in die Zwischenablage (wie Swift `SyncedBlockClipboard`). */
export const SYNC_CLIPBOARD_PREFIX = "based-sync:";

export function syncSourceFromClipboard(text: string): string | undefined {
  const s = text.trim();
  if (!s.startsWith(SYNC_CLIPBOARD_PREFIX)) return undefined;
  const id = s.slice(SYNC_CLIPBOARD_PREFIX.length);
  return id.length > 0 && !/\s/.test(id) ? id : undefined;
}
