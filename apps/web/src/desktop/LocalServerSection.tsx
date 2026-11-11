// BSD-138: Einstellungen → Sync & server → „Local server“ (nur in der Desktop-App): lokaler based-server als Beilage,
// damit `based` (CLI) und Coding-Agenten ohne eigenen Server laufen. Optional: diese App synchronisiert mit ihm,
// solange kein anderer Server eingestellt ist (dann sieht die CLI dieselben Seiten).
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Layout";
import { BasedButton } from "@based/ui/astryx";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Group, Row, Value } from "../screens/settings/parts.js";
import { registerSettingsSection, type SettingsSectionProps } from "../screens/settings/registry.js";
import { syncConfig } from "../shell/storage.js";
import { localServer } from "./localServer.js";

const STATUS: Record<string, string> = { off: "Off", starting: "Starting…", running: "Running", failed: "Stopped with an error", unavailable: "Only in the desktop app" };

function LocalServerSection({ client }: SettingsSectionProps) {
  const ls = localServer();
  const s = useSyncExternalStore(ls.subscribe, ls.getState);
  const [cli, setCli] = useState<string>();
  const [message, setMessage] = useState<string>();
  useEffect(() => { void ls.cliInstall().then((r) => setCli(r?.command), () => undefined); }, [ls]);
  if (s.status === "unavailable") {
    return (
      <Group>
        <Row label="Local server" hint="In the Based desktop app, the command line tool and coding agents can run without a server of your own." />
        <Value testID="local-server-status">{STATUS.unavailable}</Value>
      </Group>
    );
  }
  const current = syncConfig.get();
  const syncsHere = !!current && current.url === s.url;
  const useForSync = async () => {
    const cfg = await ls.syncConfig();
    if (!cfg) return;
    syncConfig.set(cfg);
    await syncConfig.flush();
    await client.setSync(cfg);
    setMessage("This app now syncs with the local server.");
  };
  return (
    <VStack gap={4}>
      <Group>
        <Switch
          label="Local server"
          description="Runs a small Based server on this computer (127.0.0.1 only) while the app is open. The command line tool `based` and coding agents (Claude Code, Codex …) use it — no server of your own needed."
          value={s.enabled} onChange={(on) => void ls.setEnabled(on)} labelPosition="start" labelSpacing="spread" width="100%"
        />
        <Row label="Status" hint={s.error}>
          <Value testID="local-server-status">{STATUS[s.status] ?? s.status}{s.url ? ` · ${s.url}` : ""}</Value>
        </Row>
        {s.status === "running" && !current ? (
          <Row label="Sync this app with it" hint="So `based` sees the same pages as this app. You can switch to another server later.">
            <BasedButton label="Use for sync" onClick={() => void useForSync()} />
          </Row>
        ) : null}
        {syncsHere ? <Text type="supporting" color="secondary">This app syncs with the local server.</Text> : null}
        {message ? <Text type="supporting" color="secondary" role="status">{message}</Text> : null}
      </Group>
      {cli ? (
        <Group>
          <Row label="Command line tool" hint="Run once in Terminal; then `based search …`, `based page get …` work while the local server runs. Also in the app menu: Install Command Line Tool…">
            <BasedButton label="Copy command" variant="ghost" onClick={() => void navigator.clipboard?.writeText(cli).then(() => setMessage("Command copied."), () => setMessage(cli))} />
          </Row>
          <code className="ai-command">{cli}</code>
        </Group>
      ) : null}
    </VStack>
  );
}

registerSettingsSection({ id: "local-server", page: "sync", title: "Local server", order: 20, component: LocalServerSection });
