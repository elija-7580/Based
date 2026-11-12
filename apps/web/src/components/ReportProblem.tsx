// BSD-319: Dialog „Report a problem“ – ein Satz, Foto (abwählbar), echter Text nur per Häkchen. Danach: wo das Bündel
// liegt (Finder in der Mac-App, Datei im Browser).
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/Layout";
import { BasedButton, BasedDialog } from "@based/ui/astryx";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CrashReportPrompt } from "./CrashReportPrompt.js";
import { bundleFile, reportStore } from "../shell/reportStore.js";
import { closeReport, reportUI, saveReport } from "../shell/reportUI.js";

export function ReportProblemDialog({ onOpenDiagnostics }: { onOpenDiagnostics: () => void }) {
  const s = useSyncExternalStore(reportUI.subscribe, reportUI.get);
  const [note, setNote] = useState("");
  const [shot, setShot] = useState(true);
  const [realText, setRealText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [canReveal, setCanReveal] = useState(false);
  useEffect(() => {
    if (s.phase === "open") {
      setNote("");
      setShot(true);
      setRealText(false);
      setError(undefined);
    }
  }, [s.phase]);
  useEffect(() => {
    void reportStore().then((st) => setCanReveal(!!st.reveal));
  }, []);
  // BSD-276: Hinweis nach Absturz/Hänger hängt hier mit dran (gleiche Stelle im Baum, App.tsx bleibt unberührt).
  if (s.phase !== "open" && s.phase !== "saved") return <CrashReportPrompt />;

  if (s.phase === "saved") {
    const reveal = async () => {
      const st = await reportStore();
      await st.reveal?.(s.saved.id).catch(() => undefined);
    };
    const download = async () => {
      const blob = await bundleFile(s.bundle, s.draft.screenshot && s.bundle.screenshot ? s.draft.screenshot : undefined);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `based-report-${s.saved.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    return (
      <BasedDialog open onClose={closeReport} title="Report saved" subtitle={s.saved.where === "this browser" ? "Kept in this browser. Save it as a file to pass it on." : "Agents can read it with `based reports`."}
        actions={<>
          {canReveal ? <BasedButton label="Show in Finder" onClick={() => void reveal()} /> : <BasedButton label="Save as file…" onClick={() => void download()} />}
          <BasedButton label="Open Diagnostics" variant="ghost" onClick={() => { closeReport(); onOpenDiagnostics(); }} />
          <BasedButton label="Done" variant="primary" onClick={closeReport} />
        </>}>
        <VStack gap={1} data-testid="report-saved">
          <Text type="body">{`${s.saved.events} recorded events · ${s.saved.issues === 0 ? "no layout issues found" : `${s.saved.issues} layout issue${s.saved.issues === 1 ? "" : "s"} found`}`}</Text>
          {s.saved.where !== "this browser" ? <Text type="code" color="secondary" data-testid="report-where">{s.saved.where}</Text> : null}
        </VStack>
      </BasedDialog>
    );
  }

  const draft = s.draft;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await saveReport(note, { realText, screenshot: shot });
    } catch (e) {
      setError(`Couldn’t save the report: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const events = draft.frozen.events.length;
  return (
    <BasedDialog open form busy={busy} onClose={closeReport} width={480} title="Report a problem"
      subtitle={`Based kept the last ${events} editor event${events === 1 ? "" : "s"} and the layout from the moment you asked.`}
      actions={<>
        <BasedButton label="Cancel" variant="ghost" onClick={closeReport} />
        <BasedButton label="Save report" variant="primary" busy={busy} disabled={!note.trim()} onClick={() => void save()} />
      </>}>
      <VStack gap={4} data-testid="report-dialog">
        <TextArea label="What did you do, and what happened?" value={note} onChange={setNote} rows={3} placeholder="Selected a paragraph and pressed Delete — a white box stayed over it." {...(error ? { status: { type: "error" as const, message: error } } : {})} />
        <VStack gap={2}>
          <CheckboxInput label="Include a screenshot" value={shot && !!draft.screenshot} isDisabled={!draft.screenshot}
            description={draft.screenshot ? "Shows what was on screen, including page content." : "No screenshot could be taken this time."} onChange={setShot} />
          <CheckboxInput label="Include real text" value={realText} onChange={setRealText}
            description="Off: letters and numbers are replaced, so the report holds no content. Tokens and email addresses are always removed." />
        </VStack>
      </VStack>
    </BasedDialog>
  );
}
