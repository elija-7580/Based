// BSD-138: Einstellungen → Sync & server (nur in der Desktop-App), beides Opt-in:
// - „Local server“: kleiner based-server auf diesem Rechner (127.0.0.1), damit `based` und Coding-Agenten ohne
//   eigenen Server laufen; optional synchronisiert diese App mit ihm.
// - „Command line tool“: legt den Befehl `based` an (Starter, Standard ~/.local/bin/based) bzw. entfernt ihn.
// Beides braucht Node.js ≥ 22 auf dem Rechner; die App lädt nichts herunter.
//
// Feedback 20. 11. (Entscheidung Elija: „geführt + Details“): Die Technik stand ungefiltert da (Node-Pfad, Adresse,
// Installationsort). Jetzt: der Server mit zwei Sätzen, was er tut; darunter drei Karten mit je einer Bedienung –
// Terminal-Befehl, AI-Apps (auf beta kein „Agent“), vom Handy erreichbar (TailnetGroup). Adresse, Node, Pfad und Sync stehen unter
// „Details“. Was man tun muss (Node fehlt, Fehler), bleibt immer sichtbar.
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { BasedButton } from "@based/ui/astryx";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { TailnetGroup } from "./TailnetGroup.js";
import { BackupsGroup } from "./BackupsGroup.js";
import { ICloudGroup } from "./ICloudGroup.js";
import { Group, Row, Value } from "../screens/settings/parts.js";
import { registerSettingsSection, type SettingsSectionProps } from "../screens/settings/registry.js";
import { syncConfig } from "../shell/storage.js";
import { localServer, PLACES } from "./localServer.js";

const STATUS: Record<string, string> = { off: "Off", starting: "Starting…", running: "Running", failed: "Stopped with an error", unavailable: "Only in the desktop app" };

/** „Details“ auf- und zuklappen – derselbe Knopf wie „Steps“ bei den Hängern. */
export function DetailsToggle({ open, onToggle, what }: { open: boolean; onToggle: () => void; what: string }) {
  return <BasedButton label={open ? "Hide details" : "Details"} variant="ghost" ariaLabel={open ? `Hide details for ${what}` : `Show details for ${what}`} onClick={onToggle} />;
}

/** Eine Karte: Name und ein Satz links, die eine Bedienung rechts; Technik nur aufgeklappt. */
function ToolCard({ title, description, control, details, testID }: { title: string; description: ReactNode; control?: ReactNode; details?: ReactNode; testID: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Group>
      <div data-testid={testID}>
        <VStack gap={3}>
          <Row label={title} hint={description}>
            <HStack gap={2} vAlign="center">
              {details ? <DetailsToggle open={open} onToggle={() => setOpen((o) => !o)} what={title} /> : null}
              {control}
            </HStack>
          </Row>
          {open && details ? <VStack gap={3} data-testid={`${testID}-details`}>{details}</VStack> : null}
        </VStack>
      </div>
    </Group>
  );
}

function LocalServerSection({ client, navigate }: SettingsSectionProps) {
  const ls = localServer();
  const s = useSyncExternalStore(ls.subscribe, ls.getState);
  const [message, setMessage] = useState<string>();
  const [target, setTarget] = useState("");
  const [details, setDetails] = useState(false);
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
  const running = s.status === "running";
  const useForSync = async () => {
    const cfg = await ls.syncConfig();
    if (!cfg) return;
    syncConfig.set(cfg);
    await syncConfig.flush();
    await client.setSync(cfg);
    setMessage("This app now syncs with the local server.");
  };
  const chosen = target.trim() === "" || target === s.cli.target ? undefined : target.trim();
  // Node fehlt oder ist zu alt: das muss man sehen (sonst startet nichts). Gefundene Node nur unter „Details“.
  const nodeProblem = s.node && !s.node.ok;
  return (
    <VStack gap={4}>
      <Group>
        <Switch
          label="Local server"
          description="While Based is open, a small server runs on this computer. The terminal command, AI apps and your phone connect to it. Only this computer can reach it unless you turn on phone access below."
          value={s.enabled} onChange={(on) => void ls.setEnabled(on)} labelPosition="start" labelSpacing="spread" width="100%"
        />
        <Row label="Status" hint={s.error}>
          <HStack gap={2} vAlign="center">
            <Value testID="local-server-status">{STATUS[s.status] ?? s.status}</Value>
            <DetailsToggle open={details} onToggle={() => setDetails((d) => !d)} what="the local server" />
          </HStack>
        </Row>
        {nodeProblem ? <Text type="supporting" color="secondary" role="status" data-testid="node-status">{s.node!.message}</Text> : null}
        {details ? (
          <VStack gap={3} data-testid="local-server-details">
            <Row label="Address" hint="Reachable from this computer only (127.0.0.1)."><Value mono>{s.url ?? "—"}</Value></Row>
            <Row label="Node.js" hint={s.node?.bundled ? "Comes with Based." : "Uses the Node.js installed on this computer."}>
              <Value {...(nodeProblem ? {} : { testID: "node-status" })}>{s.node?.message ?? "Checking…"}</Value>
            </Row>
            {running && !current ? (
              <Row label="Sync this app with it" hint="So `based` sees the same pages as this app. You can switch to another server later.">
                <BasedButton label="Use for sync" onClick={() => void useForSync()} />
              </Row>
            ) : null}
            {syncsHere ? <Text type="supporting" color="secondary">This app syncs with the local server.</Text> : null}
          </VStack>
        ) : null}
        {message ? <Text type="supporting" color="secondary" role="status">{message}</Text> : null}
      </Group>

      <ToolCard
        testID="tool-cli"
        title="Terminal command"
        description={s.cli.installed ? `Type \`${PLACES.cliName}\` in Terminal to search, read and write pages.` : `Adds \`${PLACES.cliName}\` to Terminal: search, read and write pages from scripts and the command line.`}
        control={s.cli.installed
          ? <BasedButton label="Uninstall" variant="ghost" disabled={s.cli.busy} onClick={() => void ls.uninstallCli(chosen ?? s.cli.target)} />
          : <BasedButton label="Install…" disabled={s.cli.busy} onClick={() => void ls.installCli(chosen)} />}
        details={
          <>
            {s.cli.installed
              ? <Row label="Installed at"><Value mono>{s.cli.target ?? ""}</Value></Row>
              : <TextInput label="Install location" value={target} onChange={setTarget} placeholder={`~/.local/bin/${PLACES.cliName}`} description="Leave as is unless you keep your own commands somewhere else." />}
            <Text type="supporting" color="secondary">It runs with Node.js and talks to this app's local server, or to your own server.</Text>
          </>
        }
      />
      {s.cli.message ? <Text type="supporting" color="secondary" role="status" data-testid="cli-status">{s.cli.message}</Text> : null}

      <ToolCard
        testID="tool-agents"
        title="AI apps"
        description={running
          ? "Claude Code, Codex, Cursor and other AI apps can read and edit your pages. Set each app up once."
          : "Claude Code, Codex, Cursor and other AI apps can read and edit your pages. Turn on the local server first."}
        control={<BasedButton label="Set up…" variant="secondary" disabled={!running} onClick={() => navigate({ name: "settings", page: "ai-apps" })} />}
        details={<Text type="supporting" color="secondary">{`Apps start \`${PLACES.cliName} mcp\` (MCP), which talks to the local server. No token ends up in their settings.`}</Text>}
      />

      <TailnetGroup />
      <ICloudGroup />
      <BackupsGroup />
    </VStack>
  );
}

registerSettingsSection({ id: "local-server", page: "sync", title: "This computer", order: 20, component: LocalServerSection, keywords: ["Local server", "Command line tool", "Terminal command", "based", "AI apps", "MCP", "Backups", "Backup folder", "iCloud Drive", "Tailscale", "Pair a device", "Reachable from your phone"] });
