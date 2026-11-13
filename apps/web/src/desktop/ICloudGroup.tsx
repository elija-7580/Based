// BSD-334 (ADR 0015): Einstellungen → Sync & server → „Sync through iCloud Drive“. Der lokale Server gleicht über
// den Ordner ~/Library/Mobile Documents/com~apple~CloudDocs/Based mit anderen Macs ab (jedes Gerät schreibt nur in
// seinen eigenen Unterordner); die App bekommt die Änderungen wie gewohnt per Sync v2 vom lokalen Server.
import { BasedButton } from "@based/ui/astryx";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Group, Row, Value } from "../screens/settings/parts.js";
import { relative } from "../shell/format.js";
import { syncConfig } from "../shell/storage.js";
import { localServer } from "./localServer.js";

type Info = Awaited<ReturnType<ReturnType<typeof localServer>["folderSync"]>>;

export function ICloudGroup() {
  const ls = localServer();
  const s = useSyncExternalStore(ls.subscribe, ls.getState);
  const [info, setInfo] = useState<Info>();
  const [busy, setBusy] = useState(false);
  const running = s.status === "running";
  useEffect(() => {
    if (!running || !s.icloud) { setInfo(undefined); return; }
    let live = true;
    const load = () => ls.folderSync().then((v) => { if (live) setInfo(v); }, () => undefined);
    load();
    const t = setInterval(load, 10_000);
    return () => { live = false; clearInterval(t); };
  }, [ls, running, s.icloud]);
  if (!s.enabled) return null;
  const syncsHere = running && syncConfig.get()?.url === s.url;
  const toggle = async () => {
    setBusy(true);
    try { await ls.setICloud(!s.icloud); } finally { setBusy(false); }
  };
  const status = !s.icloud ? "Off" : !running ? "Starts with the local server"
    : info?.error ? `Problem: ${info.error}` : info?.lastRound ? `Last checked ${relative(new Date(info.lastRound))}` : "Starting…";
  return (
    <Group>
      <Row label="Sync through iCloud Drive" hint="Keeps your Macs in step through the Based folder in iCloud Drive – no server needed. Each Mac writes only its own files there.">
        <BasedButton label={busy ? "Restarting…" : s.icloud ? "Turn off" : "Turn on"} disabled={busy} onClick={() => void toggle()} />
      </Row>
      <Row label="iCloud Drive"><Value testID="icloud-status">{status}</Value></Row>
      {s.icloud && running && !syncsHere ? <Row label="Use the local server for sync" hint="This app's pages reach iCloud Drive through the local server. Choose it under Sync (above)." /> : null}
    </Group>
  );
}
