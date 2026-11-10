// „Copy and sync“ merkt sich den Verweis auch hier: Browser ohne Clipboard-Berechtigung (WebKit ohne Nutzergeste,
// Tauri-WebView) können ihn so trotzdem einfügen („Paste synced block“ im Slash-Menü).
let last: string | undefined;

export function rememberSyncClipboard(text: string): void {
  last = text;
}

/** Für Tests und die Shell: was „Copy and sync“ zuletzt kopiert hat. */
export function lastCopiedSync(): string | undefined {
  return last;
}
