// BSD-319: Settings → Diagnostics in klaren Gruppen: Status, Problems, Reports, Log, For developers. Gleiche Zeilen und
// Abstände wie die übrigen Einstellungen (parts.tsx), keine Debug-Optik; alles per Tastatur erreichbar.
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import type { DiagnosticsEntry, DiagnosticsLevel } from "@based/core";
import { BasedButton, BasedConfirm, BasedField } from "@based/ui/astryx";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SYNC_LABEL } from "../../components/Sidebar.js";
import { isTauri } from "../../desktop.js";
import { BUILD, recorder } from "../../shell/bugReport.js";
import { diagnosticsLog, diagnosticsReport, previousSessionText, stallCount } from "../../shell/diagnostics.js";
import { hangHistory } from "../../shell/hangs.js";
import { ongoingHangNotice } from "@based/core";
import { bundleFile, onReportsChanged, reportsChanged, reportStore, type SavedReport } from "../../shell/reportStore.js";
import { reportUI, startReport } from "../../shell/reportUI.js";
import { crashConsentPref, crashPrompt, previousCrashReport } from "../../shell/crashReport.js";
import { devViewPref, deviceNode, newEditorPref } from "../../shell/storage.js";
import { Group, Row, Value } from "./parts.js";
import type { SettingsSectionProps } from "./registry.js";
import { clockSkewText } from "./clockSkew.js";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const useLog = () => useSyncExternalStore(diagnosticsLog.subscribe, diagnosticsLog.getSnapshot);

export const versionText = () => [BUILD.version ? `Version ${BUILD.version}` : "Development build", BUILD.commit ? `commit ${BUILD.commit}` : ""].filter(Boolean).join(" · ");

/** Zustand: Version, Sync, Speicher, Uhr, Hülle, Seiten. */
export function StatusSection({ state }: SettingsSectionProps) {
  const s = state.status;
  const nodes = Object.values(state.outline?.nodes ?? {});
  return (
    <Group>
      <Row label="Version"><Value testID="diagnostics-version">{versionText()}</Value></Row>
      <Row label="Sync"><Value>{SYNC_LABEL[s.state]}{s.detail ? ` · ${s.detail}` : ""}</Value></Row>
      <Row label="Storage"><Value testID="diagnostics-storage">{s.persistent ? "Persistent (OPFS)" : "Memory only"}{s.storageWarnings?.length ? ` · ${s.storageWarnings.join(" ")}` : ""}</Value></Row>
      {s.clockSkew !== undefined ? <Row label="Clock"><Value>{clockSkewText(s.clockSkew)}</Value></Row> : null}
      <Row label="Shell"><Value>{isTauri() ? "Desktop app" : "Web browser"}</Value></Row>
      <Row label="Pages"><Value testID="diagnostics-pages">{`${plural(nodes.filter((n) => n.kind === "page").length, "page")} · ${plural(nodes.filter((n) => n.kind === "database").length, "database")}`}</Value></Row>
    </Group>
  );
}

/** Probleme: letzte Sitzung, Hänger, Fehler und Warnungen mit Zähler. Leer: ein ruhiger Satz. */
export function ProblemsSection(_: SettingsSectionProps) {
  const log = useLog();
  const notice = previousSessionText();
  // BSD-418: endete die vorige Sitzung in einem Hänger, steht das hier – auch wenn sie danach „sauber“ schloss (Neuladen)
  const hang = useSyncExternalStore(hangHistory.subscribe, hangHistory.get).endedInHang;
  const freezes = stallCount();
  const errors = log.filter((e) => e.level === "error");
  const warnings = log.filter((e) => e.level === "warning" && !/^(main thread blocked|slow input|slow store request|previous session ended in a hang)/.test(e.message));
  if (!hang && !notice && freezes === 0 && errors.length === 0 && warnings.length === 0) {
    return <Group><Row label="Nothing to report" hint="No crashes, freezes or errors on this device since Based started." /></Group>;
  }
  const last = (l: DiagnosticsEntry[]) => (l.length ? `Last: ${l.at(-1)!.message}` : undefined);
  return (
    <Group>
      {hang ? <Row label="Last session" hint={ongoingHangNotice(hang.marker)}><Value testID="diagnostics-last-session">Ended in a hang</Value></Row>
        : notice ? <Row label="Last session" hint={notice}><Value testID="diagnostics-last-session">Ended unexpectedly</Value></Row> : null}
      {freezes ? <Row label="Freezes" hint="The app stopped responding for two seconds or longer"><Value testID="diagnostics-freezes">{freezes}</Value></Row> : null}
      {errors.length ? <Row label="Errors" hint={last(errors)}><Value testID="diagnostics-errors">{errors.length}</Value></Row> : null}
      {warnings.length ? <Row label="Warnings" hint={last(warnings)}><Value testID="diagnostics-warnings">{warnings.length}</Value></Row> : null}
    </Group>
  );
}

/**
 * BSD-276: Absturzberichte – Einwilligung (Standard aus), Bericht über die vorige Sitzung von Hand vorbereiten. Senden
 * aus der App gibt es noch nicht (kein Ziel, kein Datenschutztext): die Zeile sagt das.
 */
export function CrashReportsSection(_: SettingsSectionProps) {
  const on = useSyncExternalStore(crashConsentPref.subscribe, crashConsentPref.get);
  const report = useMemo(() => previousCrashReport(), []);
  return (
    <Group>
      <Switch label="Offer a report after a crash or freeze" description="When Based didn’t close normally or froze, it asks at the next start. Reports hold no pages, titles or text."
        value={on} onChange={(v) => crashConsentPref.set(v)} labelPosition="start" labelSpacing="spread" width="100%" data-testid="crash-consent" />
      <Row label="Last session" hint={report ? (report.kind === "hang" ? "Ended in a hang" : report.kind === "crash" ? "Didn’t close normally" : `Froze ${plural(report.session.freezes, "time")}`) : "Closed normally — nothing to report"}>
        <BasedButton label="Prepare report…" variant="ghost" disabled={!report} onClick={() => crashPrompt.show()} />
      </Row>
      <Row label="Sending" hint="Not available in this beta yet — save the report as a file or copy it and pass it on." />
    </Group>
  );
}

function useReports() {
  const [reports, setReports] = useState<SavedReport[] | undefined>();
  const [canReveal, setCanReveal] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => void reportStore().then(async (s) => {
      if (alive) setCanReveal(!!s.reveal);
      const list = await s.list().catch(() => []);
      if (alive) setReports(list);
    });
    load();
    const off = onReportsChanged(load);
    return () => { alive = false; off(); };
  }, []);
  return { reports, canReveal };
}

/** Berichte: neuen anlegen, gespeicherte mit Datum und Satz, im Finder zeigen bzw. als Datei sichern, löschen. */
export function ReportsSection(_: SettingsSectionProps) {
  const { reports, canReveal } = useReports();
  const [deleting, setDeleting] = useState<SavedReport | undefined>();
  const reveal = async (id: string) => (await reportStore()).reveal?.(id).catch(() => undefined);
  const download = async (id: string) => {
    const r = await (await reportStore()).load(id);
    if (!r) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await bundleFile(r.bundle, r.screenshot));
    a.download = `based-report-${id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const preparing = useSyncExternalStore(reportUI.subscribe, () => reportUI.get().phase === "capturing");
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <Group>
      <Row label="Report a problem" hint="Saves the last editor events, the layout and a screenshot · ⇧⌘B anywhere">
        {/* Der Dialog kommt erst nach dem Bildschirmfoto – bis dahin sagt der Knopf, dass etwas passiert. */}
        <BasedButton label={preparing ? "Preparing report…" : "Report a problem…"} disabled={preparing} busy={preparing} onClick={() => void startReport()} />
      </Row>
      <VStack gap={4} data-testid="diagnostics-reports">
        {reports === undefined ? null : reports.length === 0 ? (
          <Row label="No reports yet" hint={canReveal ? "Reports are saved in ~/.config/based/reports — agents list them with `based reports`." : "Reports are kept in this browser."} />
        ) : reports.map((r) => (
          <Row key={r.id} label={r.note || "No description"} hint={`${when(r.createdAt)} · ${plural(r.events, "event")}${r.issues ? ` · ${plural(r.issues, "layout issue")}` : ""}${r.screenshot ? " · screenshot" : ""}`}>
            <HStack gap={2}>
              {canReveal ? <BasedButton label="Show in Finder" variant="ghost" onClick={() => void reveal(r.id)} /> : <BasedButton label="Save as file…" variant="ghost" onClick={() => void download(r.id)} />}
              <BasedButton label="Delete" variant="ghost" onClick={() => setDeleting(r)} />
            </HStack>
          </Row>
        ))}
      </VStack>
      <BasedConfirm open={!!deleting} onClose={() => setDeleting(undefined)} title="Delete this report?" description="The recording, layout and screenshot of this report are removed from this device."
        actionLabel="Delete report" onConfirm={async () => { if (deleting) { await (await reportStore()).remove(deleting.id); reportsChanged(); } }} />
    </Group>
  );
}

const logLine = (e: DiagnosticsEntry) => `${new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}  ${e.level.toUpperCase().padEnd(7)} ${e.message}`;

type LevelFilter = "all" | DiagnosticsLevel;
const LEVELS: { value: LevelFilter; label: string }[] = [
  { value: "all", label: "All" }, { value: "info", label: "Info" }, { value: "warning", label: "Warnings" }, { value: "error", label: "Errors" },
];

/** Ganzes Log mit Filter nach Stufe und Suche; Bericht als Text kopieren. */
export function LogSection({ state }: SettingsSectionProps) {
  const log = useLog();
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  // BSD-300: Kopieren kann scheitern (keine Berechtigung für die Zwischenablage) – dann das sagen, nicht still bleiben.
  const [copied, setCopied] = useState<"" | "ok" | "failed">("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return log.filter((e) => (level === "all" || e.level === level) && (!q || e.message.toLowerCase().includes(q)));
  }, [log, level, query]);
  const s = state.status;
  const facts = {
    version: versionText(),
    sync: `${s.state}${s.detail ? ` (${s.detail})` : ""}`,
    storage: (s.persistent ? "persistent" : "memory") + (s.storageWarnings?.length ? ` (${s.storageWarnings.join(" ")})` : ""),
    clock: s.clockSkew !== undefined ? clockSkewText(s.clockSkew) : undefined,
    device: deviceNode.get() ?? "-",
    shell: isTauri() ? "desktop" : "web",
    pages: Object.keys(state.outline?.nodes ?? {}).length,
    trash: state.outline?.trash.length ?? 0,
  };
  const copy = () => {
    const clip = globalThis.navigator?.clipboard;
    if (!clip) return setCopied("failed");
    void clip.writeText(diagnosticsReport(facts)).then(() => setCopied("ok"), () => setCopied("failed"));
  };
  return (
    <Group>
      <Row label="Events on this device" hint="Newest last — no page content">
        <BasedButton label={copied === "ok" ? "Copied" : copied === "failed" ? "Couldn’t copy – try again" : "Copy diagnostics"} onClick={copy} />
      </Row>
      <HStack gap={3} vAlign="end" wrap="wrap">
        <SegmentedControl label="Level" value={level} onChange={(v) => setLevel(v as LevelFilter)}>
          {LEVELS.map((l) => <SegmentedControlItem key={l.value} value={l.value} label={l.label} />)}
        </SegmentedControl>
        <StackItem size="fill">
          <BasedField label="Search the log" value={query} onChange={setQuery} placeholder="Filter…" />
        </StackItem>
      </HStack>
      <div className="diagnostics-log" data-testid="diagnostics-log" role="log" aria-label="Diagnostics log" tabIndex={0}>
        {shown.length === 0 ? <Value>{log.length ? "No matching entries" : "—"}</Value> : shown.map((e, i) => (
          <div key={`${e.at}-${i}`} className="diagnostics-log-line" data-level={e.level}>{logLine(e)}</div>
        ))}
      </div>
      <Text type="supporting" color="secondary" display="block" data-testid="diagnostics-log-count">{`${shown.length} of ${plural(log.length, "entry")}`.replace("entrys", "entries")}</Text>
    </Group>
  );
}

/** Für Entwickler: Entwickler-Ansicht, Design Kit, Aufzeichnung leeren. */
export function DeveloperSection({ navigate }: SettingsSectionProps) {
  const dev = useSyncExternalStore(devViewPref.subscribe, devViewPref.get);
  const newEditor = useSyncExternalStore(newEditorPref.subscribe, newEditorPref.get);
  const [size, setSize] = useState(recorder.size);
  useEffect(() => {
    const id = setInterval(() => setSize(recorder.size), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <Group>
      <Switch label="Developer view" description="Shows block bounds, layers and focus, and the last editor events live. Helps with the daily acceptance test."
        value={dev} onChange={(on) => devViewPref.set(on)} labelPosition="start" labelSpacing="spread" width="100%" />
      <Switch label="New editor (preview)" description="Block editor after ADR 0016: one text field per block, stable handle, dragging and block selection. Takes effect when a page opens."
        value={newEditor} onChange={(on) => newEditorPref.set(on)} labelPosition="start" labelSpacing="spread" width="100%" />
      <Row label="Editor recording" hint="Always on · the last two minutes, in memory only">
        <HStack gap={2} vAlign="center">
          <Value testID="diagnostics-recording">{plural(size, "event")}</Value>
          <BasedButton label="Clear" variant="ghost" disabled={size === 0} onClick={() => { recorder.clear(); setSize(0); }} />
        </HStack>
      </Row>
      <Row label="Design kit" hint="Buttons, dialog, menu and form fields in the Based theme">
        <BasedButton label="Open design kit" variant="ghost" onClick={() => navigate({ name: "settings", page: "kit" })} />
      </Row>
    </Group>
  );
}
