// BSD-276: Hinweis nach Absturz oder Hänger („Prepare a report?“) – nur mit Einwilligung (Settings → Diagnostics →
// Crash reports), einmal je Sitzung. Zeigt genau, was im Bericht steht (ohne Inhalte), dann Datei sichern oder kopieren.
// Senden aus der App gibt es noch nicht – der Dialog sagt das, statt so zu tun.
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { crashReportSummary, crashReportText } from "@based/core";
import { BasedButton, BasedDialog } from "@based/ui/astryx";
import { useMemo, useState, useSyncExternalStore } from "react";
import { copyCrashReport, crashPrompt, previousCrashReport, saveCrashReport } from "../shell/crashReport.js";
import "./crashReport.css";

export function CrashReportPrompt() {
  const { open } = useSyncExternalStore(crashPrompt.subscribe, crashPrompt.get);
  const report = useMemo(() => (open ? previousCrashReport() : undefined), [open]);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState("");
  if (!open || !report) return null;
  const close = () => { setPreview(false); setStatus(""); crashPrompt.close(); };
  const copy = async () => setStatus((await copyCrashReport(report)) ? "copied" : "copy-failed");
  const save = async () => {
    const where = await saveCrashReport(report);
    setStatus(`saved:${where}`);
  };
  const lines = report.log.length;
  return (
    <BasedDialog open onClose={close} width={520} title={report.kind === "hang" ? "Based hung and was closed" : report.kind === "crash" ? "Based didn’t close normally" : "Based froze last time"}
      subtitle="Prepare a report for the beta? It holds no pages, titles or text."
      actions={<>
        <BasedButton label={status === "copied" || status.startsWith("saved:") ? "Done" : "Not now"} variant="ghost" onClick={close} />
        <BasedButton label={status === "copied" ? "Copied" : status === "copy-failed" ? "Couldn’t copy – try again" : "Copy report"} onClick={() => void copy()} />
        <BasedButton label="Save as file…" variant="primary" onClick={() => void save()} />
      </>}>
      <VStack gap={3} data-testid="crash-report-prompt">
        <Text type="body" display="block" data-testid="crash-report-summary">{crashReportSummary(report)}</Text>
        {/* Offen zeigt die Vorschau genau, was drinsteht – dann ersetzt sie die Beschreibung (Aktionen bleiben im Fenster). */}
        {preview ? null : <Text type="supporting" color="secondary" display="block">
          {`Included: app version, platform, when the session started and stopped, freezes${report.hang ? ", the hang with the steps before it" : ""}, and the last ${lines} diagnostics line${lines === 1 ? "" : "s"} with names and quoted text removed. Sending from the app isn’t available yet — save the file or copy it and pass it on.`}
        </Text>}
        {status.startsWith("saved:") ? <Text type="supporting" display="block" data-testid="crash-report-saved">{`Saved · ${status.slice(6)}`}</Text> : null}
        <HStack><BasedButton label={preview ? "Hide report" : "Show report"} variant="ghost" onClick={() => setPreview((p) => !p)} /></HStack>
        {preview ? <pre className="crash-report-preview" data-testid="crash-report-preview" tabIndex={0} aria-label="Report contents">{crashReportText(report)}</pre> : null}
      </VStack>
    </BasedDialog>
  );
}
