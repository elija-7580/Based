// Die eingebauten Abschnitte der Einstellungen – angemeldet über dieselbe Registry, die auch andere Bereiche nutzen.
// Nur was in Based Next wirklich wirkt; alles andere nennt die Seite ehrlich unter „Not available yet“.
import { Link } from "@astryxdesign/core/Link";
import { Selector } from "@astryxdesign/core/Selector";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Switch } from "@astryxdesign/core/Switch";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { TEAMSPACE_ICONS } from "../../components/TeamspaceDialog.js";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { BasedButton, BasedConfirm, BasedField } from "@based/ui/astryx";
import { useId, useState, useSyncExternalStore } from "react";
import type { Appearance } from "../../appearance.js";
import { ExportDialog, ImportDialog } from "../../components/ImportExport.js";
import { assetsLabel } from "../../assetBridge.js";
import { SYNC_LABEL } from "../../components/Sidebar.js";
import { checkForUpdates, isTauri } from "../../desktop.js";
import { validateSyncForm } from "../../shell/settings.js";
import { diagnosticsLog, diagnosticsReport, previousSessionText } from "../../shell/diagnostics.js";
import { deviceNode, startPage, syncConfig, weekStartPref } from "../../shell/storage.js";
import { weekStartForLocale } from "@based/core";
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
/** BSD-286: „This device's clock is 1 h 5 min behind the server“. */
export function clockSkewText(seconds: number): string {
  const a = Math.abs(seconds);
  const parts = a >= 86_400 ? [`${Math.floor(a / 86_400)} d`, `${Math.floor((a % 86_400) / 3600)} h`]
    : a >= 3600 ? [`${Math.floor(a / 3600)} h`, `${Math.floor((a % 3600) / 60)} min`]
      : [`${Math.max(1, Math.round(a / 60))} min`];
  const span = parts.filter((p) => !/^0 /.test(p)).join(" ");
  return `This device's clock is ${span} ${seconds > 0 ? "behind" : "ahead of"} the server`;
}

function SyncSection({ client, state }: SettingsSectionProps) {
  const status = state.status;
  const saved = syncConfig.get();
  const [url, setURL] = useState(saved?.url ?? "");
  const [token, setToken] = useState(saved?.token ?? "");
  const [connected, setConnected] = useState(!!saved);
  const [collab, setCollab] = useState(saved?.collab === true);
  const [error, setError] = useState<string | undefined>();
  // BSD-220: Echtzeit-Text (Beta). Gilt für Seiten, die danach geöffnet werden.
  const changeCollab = (on: boolean) => {
    setCollab(on);
    const cur = syncConfig.get();
    if (!cur) return;
    const next = { url: cur.url, token: cur.token, ...(on ? { collab: true } : {}) };
    syncConfig.set(next);
    void syncConfig.flush().then(() => client.setSync(next));
  };
  const connect = () => {
    const r = validateSyncForm({ url, token });
    if (!r.ok) return setError(r.error);
    setError(undefined);
    setURL(r.config.url);
    setToken(r.config.token);
    const config = collab ? { ...r.config, collab: true } : r.config;
    syncConfig.set(config);
    setConnected(true);
    // erst gespeichert, dann verbunden: der Status in der Seitenleiste heißt dann auch „übersteht Neuladen“
    void syncConfig.flush().then(() => client.setSync(config));
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
      {status.clockSkew !== undefined ? (
        <Row label="Clock" hint="Based stamps your changes with the server's time until this is fixed. Set the date and time of this device automatically.">
          <Value testID="sync-clock-skew">{clockSkewText(status.clockSkew)}</Value>
        </Row>
      ) : null}
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
          <Switch label="Real-time text (beta)" description="Merge edits to the same paragraph from your devices instead of keeping only the latest. Applies to pages you open next."
            value={collab} onChange={changeCollab} labelPosition="start" labelSpacing="spread" width="100%" />
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
      <Row label="Name" hint="Used for exports and shown to people you share with">
        <WorkspaceName name={state.outline?.workspaceName ?? ""} onRename={(name) => void client.command({ op: "renameWorkspace", name })} />
      </Row>
      <Row label="Icon" hint="Shown next to the workspace name; syncs to every device">
        <HStack gap={1} wrap="wrap" role="group" aria-label="Workspace icon" data-testid="workspace-icon">
          <ToggleButton label="No icon" isPressed={!state.outline?.workspaceIcon} onPressedChange={() => void client.command({ op: "setWorkspaceIcon" })}>–</ToggleButton>
          {TEAMSPACE_ICONS.map((e) => (
            <ToggleButton key={e} label={`Icon ${e}`} isPressed={state.outline?.workspaceIcon === e} onPressedChange={() => void client.command({ op: "setWorkspaceIcon", icon: e })}>{e}</ToggleButton>
          ))}
        </HStack>
      </Row>
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

/** BSD-205: Workspace-Name, gespeichert beim Verlassen des Feldes oder mit Enter. */
function WorkspaceName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [value, setValue] = useState(name);
  const [prev, setPrev] = useState(name);
  if (prev !== name) {
    setPrev(name);
    setValue(name);
  }
  const commit = () => { if (value.trim() && value.trim() !== name) onRename(value); else setValue(name); };
  return (
    <span data-testid="workspace-name" onBlur={commit}>
      <BasedField label="Workspace name" value={value} onChange={setValue} placeholder="Workspace" onEnter={commit} />
    </span>
  );
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const AUTO = "auto";

/** BSD-205: Wochenbeginn für Kalender, Datumsauswahl und Diagramm-Wochen (pro Gerät). */
function LanguageSection(_: SettingsSectionProps) {
  const [value, setValue] = useState(() => {
    const d = weekStartPref.get();
    return d === undefined ? AUTO : String(d);
  });
  const auto = DAY_NAMES[weekStartForLocale()]!;
  return (
    <Group>
      <Row label="Start week on" hint="Calendars and date pickers start the week on this day">
        <Selector
          label="Start week on"
          value={value}
          onChange={(v) => {
            const next = v ?? AUTO;
            setValue(next);
            weekStartPref.set(next === AUTO ? undefined : Number(next));
          }}
          options={[{ value: AUTO, label: `Automatic (${auto})` }, ...[1, 0, 6].map((d) => ({ value: String(d), label: DAY_NAMES[d]! }))]}
        />
      </Row>
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
  const facts = {
    sync: `${s.state}${s.detail ? ` (${s.detail})` : ""}`,
    storage: s.persistent ? "persistent" : "memory",
    clock: s.clockSkew !== undefined ? clockSkewText(s.clockSkew) : undefined,
    device: deviceNode.get() ?? "-",
    shell: isTauri() ? "desktop" : "web",
    pages: Object.keys(state.outline?.nodes ?? {}).length,
    trash: state.outline?.trash.length ?? 0,
  };
  const log = useSyncExternalStore(diagnosticsLog.subscribe, diagnosticsLog.getSnapshot);
  const notice = previousSessionText();
  const copy = () => void navigator.clipboard?.writeText(diagnosticsReport(facts)).then(() => setCopied(true), () => setCopied(false));
  return (
    <Group>
      <Row label="Sync"><Value>{SYNC_LABEL[s.state]}{s.detail ? ` · ${s.detail}` : ""}</Value></Row>
      <Row label="Storage"><Value>{s.persistent ? "Persistent (OPFS)" : "Memory only"}</Value></Row>
      {s.clockSkew !== undefined ? <Row label="Clock"><Value>{clockSkewText(s.clockSkew)}</Value></Row> : null}
      <Row label="Shell"><Value>{isTauri() ? "Desktop app" : "Web browser"}</Value></Row>
      {notice ? <Row label="Last session"><Value testID="diagnostics-last-session">{notice}</Value></Row> : null}
      <Row label="Log" hint="Recent events on this device, newest last — no page content">
        <VStack gap={1} data-testid="diagnostics-log">
          {log.length === 0 ? <Value>—</Value> : log.slice(-8).map((e, i) => <Value key={i} mono>{`${new Date(e.at).toLocaleTimeString()} ${e.level} ${e.message}`}</Value>)}
        </VStack>
      </Row>
      <Row label="Report" hint="State of this device, the previous session and the log as text — contains no page content">
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
  registerSettingsSection({ id: "language", page: "language", title: "Week", order: 10, component: LanguageSection, provides: ["Start week on Monday"] });
  registerSettingsSection({ id: "import-export", page: "import", title: "Import & export", order: 10, component: ImportSection });
  registerSettingsSection({ id: "sync-server", page: "sync", title: "Based server", order: 10, component: SyncSection });
  registerSettingsSection({ id: "plan", page: "billing", title: "Plan", order: 10, component: BillingSection });
  registerSettingsSection({ id: "updates", page: "updates", title: "Updates", order: 10, component: UpdatesSection });
  registerSettingsSection({ id: "diagnostics", page: "diagnostics", title: "This device", order: 10, component: DiagnosticsSection });
  // BSD-159: Anbieter, Schlüssel, Modelle und Freigaben aus dem Chat-Bereich.
  registerSettingsSection({ id: "ai-providers", page: "agents", title: "Models and keys", order: 10, component: () => <AiSettingsSection />, provides: ["API keys for AI providers", "Permissions"] });
  registerSettingsSection({ id: "about", page: "about", title: "About", order: 10, component: AboutSection });
}
