// Die eingebauten Abschnitte der Einstellungen – angemeldet über dieselbe Registry, die auch andere Bereiche nutzen.
// Nur was in Based Next wirklich wirkt; alles andere nennt die Seite ehrlich unter „Not available yet“.
import { Link } from "@astryxdesign/core/Link";
import { Selector } from "@astryxdesign/core/Selector";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { BasedButton, BasedConfirm, BasedField } from "@based/ui/astryx";
import { useId, useState } from "react";
import type { Appearance } from "../../appearance.js";
import { ExportDialog, ImportDialog } from "../../components/ImportExport.js";
import { assetsLabel } from "../../assetBridge.js";
import { SYNC_LABEL } from "../../components/Sidebar.js";
import { checkForUpdates, isTauri } from "../../desktop.js";
import { validateSyncForm } from "../../shell/settings.js";
import { deviceNode, startPage, syncConfig } from "../../shell/storage.js";
import { Group, Row, Value } from "./parts.js";
import { AiSettingsSection } from "../../chat/AiSettingsSection.js";
import { registerSettingsSection, type SettingsSectionProps } from "./registry.js";

type ChoiceKey = "theme" | "style" | "marker" | "density";
interface Choice { key: ChoiceKey; label: string; hint?: string; options: { value: string; label: string; swatch?: string }[] }

const CHOICES: Choice[] = [
  {
    key: "theme", label: "Theme", hint: "System follows your device",
    options: [{ value: "light", label: "Light", swatch: "light" }, { value: "dark", label: "Dark", swatch: "dark" }, { value: "system", label: "System" }],
  },
  { key: "style", label: "Style", hint: "Default is quiet; Bold adds character", options: [{ value: "default", label: "Default" }, { value: "bold", label: "Bold" }] },
  {
    key: "marker", label: "Marker", hint: "How Based marks its work",
    options: (["butter", "mint", "sky", "rose"] as const).map((m) => ({ value: m, label: m[0]!.toUpperCase() + m.slice(1), swatch: m })),
  },
  { key: "density", label: "Density", options: [{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }] },
];

function AppearanceSection({ appearance, setAppearance }: SettingsSectionProps) {
  const toggle = (key: "calm" | "agentDetails", label: string, hint: string) => (
    <Switch label={label} description={hint} value={appearance[key]} onChange={(on) => setAppearance({ ...appearance, [key]: on })} labelPosition="start" labelSpacing="spread" width="100%" />
  );
  return (
    <VStack gap={4}>
      <Group>
        {CHOICES.map((c) => (
          <Row key={c.key} label={c.label} hint={c.hint}>
            <SegmentedControl label={c.label} value={appearance[c.key]} onChange={(v) => setAppearance({ ...appearance, [c.key]: v } as Appearance)}>
              {c.options.map((o) => (
                <SegmentedControlItem key={o.value} value={o.value} label={o.label} {...(o.swatch ? { icon: <span className={`swatch ${o.swatch}`} aria-hidden="true" /> } : {})} />
              ))}
            </SegmentedControl>
          </Row>
        ))}
      </Group>
      <Group>
        {toggle("calm", "Calm mode", "Agent marks turn grey — on with Focus")}
        {toggle("agentDetails", "Show agent details", "Models, run times and permissions on Home")}
      </Group>
    </VStack>
  );
}

/** Sync-Server (Sync v2): URL und Token; leer = nur auf diesem Gerät. */
function SyncSection({ client, state }: SettingsSectionProps) {
  const status = state.status;
  const saved = syncConfig.get();
  const [url, setURL] = useState(saved?.url ?? "");
  const [token, setToken] = useState(saved?.token ?? "");
  const [connected, setConnected] = useState(!!saved);
  const [error, setError] = useState<string | undefined>();
  const connect = () => {
    const r = validateSyncForm({ url, token });
    if (!r.ok) return setError(r.error);
    setError(undefined);
    setURL(r.config.url);
    setToken(r.config.token);
    syncConfig.set(r.config);
    setConnected(true);
    // erst gespeichert, dann verbunden: der Status in der Seitenleiste heißt dann auch „übersteht Neuladen“
    void syncConfig.flush().then(() => client.setSync(r.config));
  };
  const disconnect = () => {
    syncConfig.set(undefined);
    setConnected(false);
    void syncConfig.flush().then(() => client.setSync(undefined));
  };
  return (
    <Group>
      <Row label="Status" hint={status.persistent ? "Your workspace is saved in this browser." : "This browser can't keep your workspace — changes are lost when you close the tab."}>
        <Value testID="sync-settings-status">{SYNC_LABEL[status.state]}{status.detail && status.state !== "synced" ? ` · ${status.detail}` : ""}{status.assets ? ` · ${assetsLabel(status.assets)}` : ""}</Value>
      </Row>
      <form onSubmit={(e) => { e.preventDefault(); connect(); }} noValidate>
        <VStack gap={4}>
          <BasedField label="Server URL" type="url" placeholder="https://based.example.com" value={url} disabled={connected} onChange={(v) => { setURL(v); setError(undefined); }} {...(error ? { error } : {})} hint="Connect a based-server to use this workspace on your other devices." />
          <BasedField label="Token" type="password" autoComplete="off" value={token} disabled={connected} onChange={setToken} />
          <HStack gap={2}>
            {connected ? (
              <>
                <BasedButton label="Sync now" onClick={() => void client.syncNow()} />
                <BasedButton label="Disconnect" variant="ghost" onClick={disconnect} />
              </>
            ) : (
              <BasedButton label="Connect" variant="primary" type="submit" disabled={!url.trim()} />
            )}
          </HStack>
        </VStack>
      </form>
    </Group>
  );
}

function ImportSection({ client, navigate }: SettingsSectionProps) {
  const [open, setOpen] = useState<"import" | "export" | undefined>();
  return (
    <Group>
      <Row label="Import" hint="A Notion export (HTML or Markdown & CSV), Markdown or CSV files, or a Based archive">
        <BasedButton label="Import…" onClick={() => setOpen("import")} />
      </Row>
      <Row label="Export" hint="Everything as Markdown, HTML or a lossless Based archive">
        <BasedButton label="Export workspace…" onClick={() => setOpen("export")} />
      </Row>
      {open === "import" ? <ImportDialog client={client} onClose={() => setOpen(undefined)} onOpenPage={(id) => navigate({ name: "page", id })} /> : null}
      {open === "export" ? <ExportDialog client={client} onClose={() => setOpen(undefined)} /> : null}
    </Group>
  );
}

const count = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

function WorkspaceSection({ client, state, navigate }: SettingsSectionProps) {
  const [confirm, setConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const nodes = Object.values(state.outline?.nodes ?? {});
  const trash = state.outline?.trash.length ?? 0;
  return (
    <Group>
      <Row label="Name"><Value testID="workspace-name">{state.outline?.workspaceName || "Workspace"}</Value></Row>
      <Row label="Contents" hint="Pages and databases outside the Trash">
        <Value testID="workspace-counts">{count(nodes.filter((n) => n.kind === "page").length, "page")} · {count(nodes.filter((n) => n.kind === "database").length, "database")}</Value>
      </Row>
      <Row label="Export all content" hint="Take everything with you">
        <BasedButton label="Export…" onClick={() => setExporting(true)} />
      </Row>
      <Row label="Trash" hint={trash ? `${count(trash, "page")} waiting in the Trash` : "The Trash is empty"}>
        <HStack gap={2}>
          <BasedButton label="Open Trash" variant="ghost" onClick={() => navigate({ name: "trash" })} />
          <BasedButton label="Empty Trash…" variant="danger" disabled={trash === 0} onClick={() => setConfirm(true)} />
        </HStack>
      </Row>
      <BasedConfirm open={confirm} onClose={() => setConfirm(false)} title="Empty the Trash?" description={`${count(trash, "page")} will be deleted for good. This can't be undone.`} actionLabel="Empty Trash" onConfirm={async () => { await client.command({ op: "emptyTrash" }); }} />
      {exporting ? <ExportDialog client={client} onClose={() => setExporting(false)} /> : null}
    </Group>
  );
}

function DeviceSection({ state }: SettingsSectionProps) {
  return (
    <Group>
      <Row label="Device ID" hint="Identifies this browser when it syncs"><Value mono testID="device-id">{deviceNode.get() ?? "not assigned yet"}</Value></Row>
      <Row label="Storage" hint="Where this device keeps the workspace">
        <Value>{state.status.persistent ? "Saved in this browser" : "Memory only — not saved"}</Value>
      </Row>
    </Group>
  );
}

function BillingSection() {
  return (
    <Group>
      <Row label="Current plan"><Value>Open source · free</Value></Row>
    </Group>
  );
}

function UpdatesSection() {
  const [busy, setBusy] = useState(false);
  if (!isTauri()) {
    return (
      <Group>
        <Row label="Web app" hint="You always get the current version when you reload this page. The desktop app checks for updates when it starts." />
      </Group>
    );
  }
  return (
    <Group>
      <Row label="Desktop app" hint="Based Next checks for updates when it starts">
        <BasedButton label="Check for updates…" busy={busy} onClick={() => { setBusy(true); void checkForUpdates({ interactive: true }).finally(() => setBusy(false)); }} />
      </Row>
    </Group>
  );
}

function DiagnosticsSection({ state, navigate }: SettingsSectionProps) {
  const s = state.status;
  const [copied, setCopied] = useState(false);
  const lines = [
    `sync: ${s.state}${s.detail ? ` (${s.detail})` : ""}`,
    `storage: ${s.persistent ? "persistent" : "memory"}`,
    `device: ${deviceNode.get() ?? "-"}`,
    `shell: ${isTauri() ? "desktop" : "web"}`,
    `pages: ${Object.keys(state.outline?.nodes ?? {}).length}, trash: ${state.outline?.trash.length ?? 0}`,
  ];
  const copy = () => void navigator.clipboard?.writeText(lines.join("\n")).then(() => setCopied(true), () => setCopied(false));
  return (
    <Group>
      <Row label="Sync"><Value>{SYNC_LABEL[s.state]}{s.detail ? ` · ${s.detail}` : ""}</Value></Row>
      <Row label="Storage"><Value>{s.persistent ? "Persistent (OPFS)" : "Memory only"}</Value></Row>
      <Row label="Shell"><Value>{isTauri() ? "Desktop app" : "Web browser"}</Value></Row>
      <Row label="Report" hint="State of this device as text — contains no page content">
        <BasedButton label={copied ? "Copied" : "Copy diagnostics"} onClick={copy} />
      </Row>
      <Row label="Design kit" hint="Buttons, dialog, menu and form fields in the Based theme">
        <BasedButton label="Open design kit" variant="ghost" onClick={() => navigate({ name: "settings", page: "kit" })} />
      </Row>
    </Group>
  );
}

function AboutSection() {
  const id = useId();
  return (
    <Group>
      <Row label="Based Next" labelID={id} hint="Local-first notes, databases and agents. Your workspace lives on your device." />
      <Row label="License"><Value>MIT · open source</Value></Row>
      <Row label="Source code" hint="Opens GitHub in a new tab">
        <Link href="https://github.com/elija-7580/Based" target="_blank">github.com/elija-7580/Based</Link>
      </Row>
      <Row label="Fonts" hint="Style Bold uses Schibsted Grotesk and Literata (SIL Open Font License 1.1), bundled with the app">
        <Text type="supporting" color="secondary">No requests to font servers</Text>
      </Row>
    </Group>
  );
}

const HOME = "__home";

/** Startseite: wohin neue Tabs, der Start der App und das Schließen des letzten Tabs führen. */
function StartPageSection({ state }: SettingsSectionProps) {
  const [value, setValue] = useState(() => startPage.get() ?? HOME);
  const nodes = state.outline?.nodes ?? {};
  const pages = Object.entries(nodes)
    .filter(([, n]) => n.kind === "page" || n.kind === "database")
    .map(([id]) => ({ value: id, label: state.titles.get(id) || "Untitled" }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const known = value === HOME || pages.some((p) => p.value === value);
  return (
    <Group>
      <Row label="Open on start" hint="New tabs, app start and closing the last tab lead here">
        <Selector
          label="Start page"
          value={known ? value : HOME}
          onChange={(v) => {
            const next = v ?? HOME;
            setValue(next);
            startPage.set(next === HOME ? undefined : next);
          }}
          options={[{ value: HOME, label: "Home" }, ...pages]}
        />
      </Row>
    </Group>
  );
}

let registered = false;

/** Meldet die eingebauten Abschnitte einmal an (aus Settings.tsx). */
export function registerBuiltinSettings() {
  if (registered) return;
  registered = true;
  registerSettingsSection({ id: "device", page: "account", title: "This device", order: 10, component: DeviceSection });
  registerSettingsSection({ id: "appearance", page: "my-settings", title: "Appearance", order: 10, component: AppearanceSection });
  registerSettingsSection({ id: "start-page", page: "my-settings", title: "Start page", order: 20, component: StartPageSection, provides: ["Home page and start page"] });
  registerSettingsSection({ id: "workspace", page: "workspace", title: "Workspace", order: 10, component: WorkspaceSection });
  registerSettingsSection({ id: "import-export", page: "import", title: "Import & export", order: 10, component: ImportSection });
  registerSettingsSection({ id: "sync-server", page: "sync", title: "Based server", order: 10, component: SyncSection });
  registerSettingsSection({ id: "plan", page: "billing", title: "Plan", order: 10, component: BillingSection });
  registerSettingsSection({ id: "updates", page: "updates", title: "Updates", order: 10, component: UpdatesSection });
  registerSettingsSection({ id: "diagnostics", page: "diagnostics", title: "This device", order: 10, component: DiagnosticsSection });
  // BSD-159: Anbieter, Schlüssel, Modelle und Freigaben aus dem Chat-Bereich.
  registerSettingsSection({ id: "ai-providers", page: "agents", title: "Models and keys", order: 10, component: () => <AiSettingsSection />, provides: ["API keys for AI providers", "Permissions"] });
  registerSettingsSection({ id: "about", page: "about", title: "About", order: 10, component: AboutSection });
}
