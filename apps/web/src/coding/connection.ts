// BSD-251: Verbindung für Coding-Agenten und den CLI-Verlauf (Claude Code, Codex). In der Desktop-App reicht der
// lokale Server (Einstellungen → Sync & server → Local server) – unabhängig davon, womit die App synchronisiert.
// Sonst gilt der verbundene based-server (`--coding-root`).
import { useEffect, useState, useSyncExternalStore } from "react";
import { localServer } from "../desktop/localServer.js";
import { syncConfig } from "../shell/storage.js";
import { CodingModel } from "./model.js";

export interface CodingConnection { url: string; token: string; source: "local" | "server" }

/** Der lokale Server dieses Rechners geht vor (dort liegen die Gespräche der CLIs), sonst der Sync-Server. */
export function pickConnection(local: { url: string; token: string } | undefined, sync: { url: string; token: string } | undefined): CodingConnection | undefined {
  if (local?.url) return { url: local.url, token: local.token, source: "local" };
  if (sync?.url) return { url: sync.url, token: sync.token, source: "server" };
  return undefined;
}

let shared: { key: string; model: CodingModel } | undefined;
/** Ein Modell je Server-Verbindung (bleibt beim Wechsel zwischen Chat und Coding erhalten). */
export function codingModelFor(c: { url: string; token: string }): CodingModel {
  const key = `${c.url}\n${c.token}`;
  if (shared?.key !== key) {
    shared?.model.stop();
    shared = { key, model: new CodingModel({ url: c.url, token: c.token }) };
  }
  return shared.model;
}

export function useCodingConnection() {
  const ls = localServer();
  const local = useSyncExternalStore(ls.subscribe, ls.getState);
  const [localConfig, setLocalConfig] = useState<{ url: string; token: string }>();
  useEffect(() => {
    let alive = true;
    if (local.status !== "running") { setLocalConfig(undefined); return; }
    void ls.syncConfig().then((c) => { if (alive) setLocalConfig(c); });
    return () => { alive = false; };
  }, [ls, local.status, local.url]);
  const connection = pickConnection(localConfig, syncConfig.get());
  /** Läuft der lokale Server schon an (Token wird noch geholt)? Dann kein „nicht verbunden“ aufblitzen lassen. */
  const pending = local.status === "starting" || (local.status === "running" && !localConfig && !connection);
  return { connection, local, pending, turnOnLocal: () => ls.setEnabled(true) };
}
