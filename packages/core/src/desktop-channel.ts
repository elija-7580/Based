// BSD-455: „Based Beta“ läuft neben „Based Next“ auf demselben Mac. Die eigene Bundle-ID trennt App-Daten, WebView-
// Speicher (dort liegen auch die verschlüsselten Tokens, kein Schlüsselbund) und Fenster. Alles, was nicht an der
// Bundle-ID hängt, steht hier pro Kanal: Port des lokalen Servers, Discovery-/Token-Datei für die CLI, Backup-Ordner,
// iCloud-Sync-Ordner, Name und Kennzeichen des CLI-Starters. Eine Stelle, damit Hülle (apps/web/src/desktop), Server
// (`--local`) und CLI dieselben Namen benutzen. Fehlerberichte (~/.config/based/reports) bleiben gemeinsam: jeder
// Bericht hat eine eigene ID und nennt die App.
//
// Datenformat unverändert; Based Next behält alle bisherigen Namen (keine Migration nötig).

export type DesktopChannel = "next" | "beta";

export interface DesktopPlaces {
  channel: DesktopChannel;
  /** Name der App (Owner in der Discovery-Datei, Texte). */
  appName: string;
  /** Fester Port des lokalen Servers (nur 127.0.0.1). */
  port: number;
  /** Discovery-Datei unter ~/.config/based (Adresse, PID, Pfad der Token-Datei). */
  discoveryFile: string;
  /** Token-Datei unter ~/.config/based (0600). */
  tokenFile: string;
  /** Ordner für automatische Backups unter ~/Documents. */
  backupFolder: string;
  /** Sync-Ordner in iCloud Drive (unter ~/Library/Mobile Documents/com~apple~CloudDocs). */
  icloudFolder: string;
  /** Standardname des Befehls unter ~/.local/bin. */
  cliName: string;
}

const PLACES: Readonly<Record<DesktopChannel, DesktopPlaces>> = {
  next: {
    channel: "next", appName: "Based Next", port: 47821, discoveryFile: "local.json", tokenFile: "local-token",
    backupFolder: "Based Backups", icloudFolder: "Based", cliName: "based",
  },
  beta: {
    channel: "beta", appName: "Based Beta", port: 47822, discoveryFile: "local-beta.json", tokenFile: "local-beta-token",
    backupFolder: "Based Beta Backups", icloudFolder: "Based Beta", cliName: "based-beta",
  },
};

/** Kanal aus einem Wert wie BASED_CHANNEL (Build-Schalter oder Umgebung); alles außer „beta“ ist Based Next. */
export function desktopChannel(value: string | undefined | null): DesktopChannel {
  return value?.trim().toLowerCase() === "beta" ? "beta" : "next";
}

/** Feste Namen/Ports eines Kanals. */
export function desktopPlaces(channel: DesktopChannel | string | undefined | null = "next"): DesktopPlaces {
  return PLACES[channel === "next" || channel === "beta" ? channel : desktopChannel(channel)];
}

/** Alle Kanäle (für Tests: keine zwei teilen einen Port, Ordner oder Dateinamen). */
export const DESKTOP_CHANNELS: readonly DesktopChannel[] = ["next", "beta"];
