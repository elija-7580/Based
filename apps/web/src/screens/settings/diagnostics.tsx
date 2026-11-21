// BSD-319: Settings → Diagnostics in klaren Gruppen. Feedback 20. 11. („alles in einem“, Entscheidung Elija): oben eine
// Übersicht – ein Satz, ob alles gut ist, Probleme, Zustand – und EIN Knopf „Copy report“, der alles mitnimmt (Zustand,
// Hänger, Log, letzte Sitzung). Darunter „Details“ mit Umschalter Hangs · Log · Crash reports · Reports; „For
// developers“ bleibt hinter dem Schalter. Gleiche Zeilen und Abstände wie die übrigen Einstellungen (parts.tsx).
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import type { DiagnosticsEntry, DiagnosticsLevel } from "@based/core";
import { BasedButton, BasedConfirm, BasedField, BasedSwitcher } from "@based/ui/astryx";
import { useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { SYNC_LABEL } from "../../components/Sidebar.js";
import { isTauri } from "../../desktop.js";
import { copyReportHint, reportSendingHint } from "../../shell/beta.js";
import { BUILD, recorder } from "../../shell/bugReport.js";
import { copyText } from "../../shell/copyText.js";
import { diagnosticsLog, diagnosticsReport, previousSessionText, stallCount } from "../../shell/diagnostics.js";
import { hangHistory } from "../../shell/hangs.js";
import { ongoingHangNotice } from "@based/core";
import { bundleFile, onReportsChanged, reportsChanged, reportStore, type SavedReport } from "../../shell/reportStore.js";
import { reportUI, startReport } from "../../shell/reportUI.js";
import { crashConsentPref, crashPrompt, previousCrashReport } from "../../shell/crashReport.js";
import { devViewPref, deviceNode } from "../../shell/storage.js";
import { Group, Note, Row, Value } from "./parts.js";
import { HangsSection } from "./hangs.js";
import type { SettingsSectionProps } from "./registry.js";
import { clockSkewText } from "./clockSkew.js";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const useLog = () => useSyncExternalStore(diagnosticsLog.subscribe, diagnosticsLog.getSnapshot);

export const versionText = () => [BUILD.version ? `Version ${BUILD.version}` : "Development build", BUILD.commit ? `commit ${BUILD.commit}` : ""].filter(Boolean).join(" · ");

/** Was „Copy report“ über diesen Zustand sagt (ohne Seiteninhalte). */
function reportFacts(state: SettingsSectionProps["state"]) {
  const s = state.status;
  return {
    version: versionText(),
    sync: `${s.state}${s.detail ? ` (${s.detail})` : ""}`,
    storage: (s.persistent ? "persistent" : "memory") + (s.storageWarnings?.length ? ` (${s.storageWarnings.join(" ")})` : ""),
    clock: s.clockSkew !== undefined ? clockSkewText(s.clockSkew) : undefined,
    device: deviceNode.get() ?? "-",
    shell: isTauri() ? "desktop" : "web",
    pages: Object.keys(state.outline?.nodes ?? {}).length,
    trash: state.outline?.trash.length ?? 0,
  };
}

/** Warnungen, die schon als Hänger zählen, nicht doppelt als „Warnings“. */
const HANG_WARNING = /^(main thread blocked|slow input|slow store request|store busy|previous session ended in a hang)/;

/**
 * Übersicht: ein Satz (alles gut / so viele Dinge zum Ansehen), der eine Knopf „Copy report“, darunter die Probleme
 * (letzte Sitzung, Freezes, Fehler, Warnungen) und der Zustand (Version, Sync, Speicher, Uhr, Hülle, Seiten).
 */
export function OverviewSection({ state }: SettingsSectionProps) {
  const log = useLog();
  const notice = previousSessionText();
  // BSD-418: endete die vorige Sitzung in einem Hänger, steht das hier – auch wenn sie danach „sauber“ schloss (Neuladen)
  const hang = useSyncExternalStore(hangHistory.subscribe, hangHistory.get).endedInHang;
  const freezes = stallCount();
  const errors = log.filter((e) => e.level === "error");
  const warnings = log.filter((e) => e.level === "warning" && !HANG_WARNING.test(e.message));
  const issues = [hang || notice ? 1 : 0, freezes ? 1 : 0, errors.length ? 1 : 0, warnings.length ? 1 : 0].reduce((a, b) => a + b, 0);
  const [copied, setCopied] = useState<"" | "ok" | "failed">("");
  const copy = () => { void copyText(diagnosticsReport(reportFacts(state))).then((ok) => setCopied(ok ? "ok" : "failed")); };
  const last = (l: DiagnosticsEntry[]) => (l.length ? `Last: ${l.at(-1)!.message}` : undefined);
  const s = state.status;
  const nodes = Object.values(state.outline?.nodes ?? {});
  return (
    <VStack gap={4}>
      <Group>
        <Row label={issues ? `${plural(issues, "thing")} to look at` : "Nothing to report"}
          hint={issues ? copyReportHint() : "No crashes, freezes or errors on this device since Based started."}>
          <BasedButton label={copied === "ok" ? "Copied" : copied === "failed" ? "Couldn’t copy – try again" : "Copy report"} variant="primary" onClick={copy} />
        </Row>
        {issues ? null : <Note>{copyReportHint()}</Note>}
        {hang ? <Row label="Last session" hint={ongoingHangNotice(hang.marker)}><Value testID="diagnostics-last-session">Ended in a hang</Value></Row>
          : notice ? <Row label="Last session" hint={notice}><Value testID="diagnostics-last-session">Ended unexpectedly</Value></Row> : null}
        {freezes ? <Row label="Freezes" hint="The app stopped responding for two seconds or longer"><Value testID="diagnostics-freezes">{freezes}</Value></Row> : null}
        {errors.length ? <Row label="Errors" hint={last(errors)}><Value testID="diagnostics-errors">{errors.length}</Value></Row> : null}
        {warnings.length ? <Row label="Warnings" hint={last(warnings)}><Value testID="diagnostics-warnings">{warnings.length}</Value></Row> : null}
      </Group>
      <Group>
        <Row label="Version"><Value testID="diagnostics-version">{versionText()}</Value></Row>
        <Row label="Sync"><Value>{SYNC_LABEL[s.state]}{s.detail ? ` · ${s.detail}` : ""}</Value></Row>
        <Row label="Storage"><Value testID="diagnostics-storage">{s.persistent ? "Persistent (OPFS)" : "Memory only"}{s.storageWarnings?.length ? ` · ${s.storageWarnings.join(" ")}` : ""}</Value></Row>
        {s.clockSkew !== undefined ? <Row label="Clock"><Value>{clockSkewText(s.clockSkew)}</Value></Row> : null}
        <Row label="Shell"><Value>{isTauri() ? "Desktop app" : "Web browser"}</Value></Row>
        <Row label="Pages"><Value testID="diagnostics-pages">{`${plural(nodes.filter((n) => n.kind === "page").length, "page")} · ${plural(nodes.filter((n) => n.kind === "database").length, "database")}`}</Value></Row>
      </Group>
    </VStack>
  );
}

const DETAIL_TABS = [{ id: "hangs", label: "Hangs" }, { id: "log", label: "Log" }, { id: "crash", label: "Crash reports" }, { id: "reports", label: "Reports" }] as const;
type DetailTab = (typeof DETAIL_TABS)[number]["id"];

/** Details: ein Umschalter statt vier Abschnitte untereinander. */
export function DetailsSection(props: SettingsSectionProps) {
  const [tab, setTab] = useState<DetailTab>("hangs");
  return (
    <VStack gap={3}>
      <BasedSwitcher label="Details" value={tab} onChange={(v) => setTab(v as DetailTab)} items={DETAIL_TABS.map((t) => ({ id: t.id, label: t.label }))} />
      <div data-testid={`diagnostics-tab-${tab}`}>
        {tab === "hangs" ? <HangsSection {...props} /> : tab === "log" ? <LogSection {...props} /> : tab === "crash" ? <CrashReportsSection {...props} /> : <ReportsSection {...props} />}
      </div>
    </VStack>
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
      <Row label="Sending" hint={reportSendingHint()} />
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
export function LogSection(_: SettingsSectionProps) {
  const log = useLog();
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return log.filter((e) => (level === "all" || e.level === level) && (!q || e.message.toLowerCase().includes(q)));
  }, [log, level, query]);
  // Nur die gezeigten Zeilen (Filter und Suche gelten) – fürs schnelle Weitergeben eines Ausschnitts.
  const [logCopied, setLogCopied] = useState<"" | "ok" | "failed">("");
  const copyLog = () => { void copyText(shown.map(logLine).join("\n")).then((ok) => setLogCopied(ok ? "ok" : "failed")); };
  // ⌘A im Log markiert nur das Log (nicht die ganze Einstellungsseite)
  const selectLog = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "a") return;
    e.preventDefault();
    const sel = globalThis.getSelection?.();
    if (!sel) return;
    const r = globalThis.document.createRange();
    r.selectNodeContents(e.currentTarget);
    sel.removeAllRanges();
    sel.addRange(r);
  };
  return (
    <Group>
      <Row label="Events on this device" hint="Newest last — no page content">
        {/* BSD-300: Kopieren kann scheitern (keine Berechtigung für die Zwischenablage) – dann das sagen, nicht still bleiben. */}
        <BasedButton label={logCopied === "ok" ? "Copied" : logCopied === "failed" ? "Couldn’t copy – try again" : `Copy log (${shown.length})`} variant="ghost" onClick={copyLog}
          disabled={shown.length === 0} />
      </Row>
      <HStack gap={3} vAlign="end" wrap="wrap">
        <BasedSwitcher label="Level" value={level} onChange={(v) => setLevel(v as LevelFilter)} items={LEVELS.map((l) => ({ id: l.value, label: l.label }))} />
        <StackItem size="fill">
          <BasedField label="Search the log" value={query} onChange={setQuery} placeholder="Filter…" />
        </StackItem>
      </HStack>
      <div className="diagnostics-log" data-testid="diagnostics-log" role="log" aria-label="Diagnostics log" tabIndex={0} onKeyDown={selectLog}>
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
  const [size, setSize] = useState(recorder.size);
  useEffect(() => {
    const id = setInterval(() => setSize(recorder.size), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <Group>
      <Switch label="Developer view" description="Shows block bounds, layers and focus, and the last editor events live. Helps with the daily acceptance test."
        value={dev} onChange={(on) => devViewPref.set(on)} labelPosition="start" labelSpacing="spread" width="100%" />
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
