// BSD-138: Einstellungen → Sync & server (nur in der Desktop-App), beides Opt-in:
// - „Local server“: kleiner based-server auf diesem Rechner (127.0.0.1), damit `based` und Coding-Agenten ohne
//   eigenen Server laufen; optional synchronisiert diese App mit ihm.
// - „Command line tool“: legt den Befehl `based` an (Starter, Standard ~/.local/bin/based) bzw. entfernt ihn.
// Beides braucht Node.js ≥ 22 auf dem Rechner; die App lädt nichts herunter.
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/Layout";
import { BasedButton } from "@based/ui/astryx";
import { useEffect, useState, useSyncExternalStore } from "react";
import { TailnetGroup } from "./TailnetGroup.js";
import { Group, Row, Value } from "../screens/settings/parts.js";
import { registerSettingsSection, type SettingsSectionProps } from "../screens/settings/registry.js";
import { syncConfig } from "../shell/storage.js";
import { localServer } from "./localServer.js";

const STATUS: Record<string, string> = { off: "Off", starting: "Starting…", running: "Running", failed: "Stopped with an error", unavailable: "Only in the desktop app" };

function LocalServerSection({ client }: SettingsSectionProps) {
  const ls = localServer();
  const s = useSyncExternalStore(ls.subscribe, ls.getState);
  const [message, setMessage] = useState<string>();
  const [target, setTarget] = useState("");
  useEffect(() => { void ls.cliStatus(); }, [ls]);
  useEffect(() => { if (s.cli.target && target === "") setTarget(s.cli.target); }, [s.cli.target, target]);
  if (s.status === "unavailable") {
    return (
      <Group>
        <Row label="Local server and command line" hint="In the Based desktop app you can turn on a local server and install the `based` command — no server of your own needed." />
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
  const chosen = target.trim() === "" || target === s.cli.target ? undefined : target.trim();
  return (
    <VStack gap={4}>
      {s.node && !s.node.ok ? <Text type="supporting" color="secondary" role="status" data-testid="node-status">{s.node.message}</Text> : null}
      <Group>
        <Switch
          label="Local server"
          description="Runs a small Based server on this computer (127.0.0.1 only) while the app is open, with your Node.js. The command line tool `based` and coding agents (Claude Code, Codex …) use it."
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
      <TailnetGroup />
      <Group>
        <Row label="Command line tool" hint={s.cli.installed ? `Installed at ${s.cli.target ?? ""}.` : "Adds the `based` command. It runs with your Node.js and talks to this app's local server or your own server."}>
          {s.cli.installed
            ? <BasedButton label="Uninstall" variant="ghost" disabled={s.cli.busy} onClick={() => void ls.uninstallCli(chosen ?? s.cli.target)} />
            : <BasedButton label="Install…" disabled={s.cli.busy} onClick={() => void ls.installCli(chosen)} />}
        </Row>
        {!s.cli.installed ? <TextInput label="Install location" value={target} onChange={setTarget} placeholder="~/.local/bin/based" description="Leave as is unless you keep your own commands somewhere else." /> : null}
        {s.cli.message ? <Text type="supporting" color="secondary" role="status" data-testid="cli-status">{s.cli.message}</Text> : null}
      </Group>
    </VStack>
  );
}

registerSettingsSection({ id: "local-server", page: "sync", title: "Local server & command line", order: 20, component: LocalServerSection });
