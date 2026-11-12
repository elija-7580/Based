// BSD-243 Teil 3b: Laufen Zeitpläne auch bei geschlossener App? Der Server meldet es in /sync/v2/info
// (agents.runsOnServer, BSD-243 Teil 3a). Ohne Server: nur bei offener App.
import { useEffect, useState } from "react";
import { syncConfig } from "../shell/storage.js";

export type ServerRuns = "none" | "app-only" | "server";

/** Text unter „Schedules“ in den Einstellungen. */
export function scheduleHint(s: ServerRuns | undefined): string {
  if (s === "server") return "Scheduled runs also start when Based is closed: your server runs them. Steps that need your approval are declined there – those run while Based is open.";
  if (s === "app-only") return "Scheduled runs start while Based is open in this browser or app. Your server can run them when Based is closed if it has model access (BASED_ANTHROPIC_API_KEY, see docs/server.md).";
  return "Scheduled runs start while Based is open in this browser or app.";
}

/** /sync/v2/info des verbundenen Servers lesen. */
export async function fetchServerRuns(cfg: { url: string; token: string } | undefined, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<ServerRuns> {
  if (!cfg?.url) return "none";
  try {
    const r = await fetcher(`${cfg.url.replace(/\/+$/, "")}/sync/v2/info`, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!r.ok) return "none";
    const v = (await r.json()) as { agents?: { runsOnServer?: unknown } };
    return v.agents?.runsOnServer === true ? "server" : "app-only";
  } catch {
    return "none";
  }
}

export function useServerRuns(): ServerRuns | undefined {
  const [s, setS] = useState<ServerRuns>();
  const cfg = syncConfig.get();
  const key = cfg ? `${cfg.url}\n${cfg.token}` : "";
  useEffect(() => {
    let alive = true;
    void fetchServerRuns(syncConfig.get()).then((v) => { if (alive) setS(v); });
    return () => { alive = false; };
  }, [key]);
  return s;
}
