// BSD-319: Dialog „Report a problem“ – ein Satz, Foto (abwählbar), echter Text nur per Häkchen. Danach: wo das Bündel
// liegt (Finder in der Mac-App, Datei im Browser). BSD-467: dazu der Weg zu uns – Mail an hello@basednotes.app mit
// Version, Kanal und System (kein Seiteninhalt), den Bericht hängt der Tester an. BSD-632: Hauptknopf „Send to Based“ –
// ein Klick speichert lokal und schickt den Bericht an basednotes.app (landet im Backlog); ohne Netz geht er später raus.
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { BasedButton, BasedDialog } from "@based/ui/astryx";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CrashReportPrompt } from "./CrashReportPrompt.js";
import { FEEDBACK_EMAIL, reportEmail } from "@based/core";
import { openMailto } from "../desktop.js";
import { APP_NAME, CHANNEL } from "../shell/beta.js";
import { bundleFile, REPORTS_DIR, reportStore } from "../shell/reportStore.js";
import { closeReport, reportUI, saveReport, sendReport } from "../shell/reportUI.js";

export function ReportProblemDialog({ onOpenDiagnostics }: { onOpenDiagnostics: () => void }) {
  const s = useSyncExternalStore(reportUI.subscribe, reportUI.get);
  const [note, setNote] = useState("");
  const [shot, setShot] = useState(true);
  const [realText, setRealText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [canReveal, setCanReveal] = useState(false);
  const [mailFailed, setMailFailed] = useState(false);
  // BSD-632: Vorschau des Bildschirmfotos im Dialog (dasselbe Bild, das mitgeht).
  const shotBlob = s.phase === "open" ? s.draft.screenshot : undefined;
  const [shotURL, setShotURL] = useState<string | undefined>();
  useEffect(() => {
    if (!shotBlob) { setShotURL(undefined); return; }
    const url = URL.createObjectURL(shotBlob);
    setShotURL(url);
    return () => URL.revokeObjectURL(url);
  }, [shotBlob]);
  useEffect(() => {
    if (s.phase === "open") {
      setNote("");
      setShot(true);
      setRealText(false);
      setError(undefined);
      setMailFailed(false);
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
    const inBrowser = s.saved.where === "this browser";
    const file = inBrowser ? `based-report-${s.saved.id}.json` : `~/${REPORTS_DIR}/${s.saved.id}`;
    const mail = reportEmail({ appName: APP_NAME, channel: CHANNEL, app: s.bundle.app, reportID: s.saved.id, attach: file });
    const email = () => void openMailto(mail.href).catch(() => setMailFailed(true));
    const send = s.send;
    if (send && (send.kind === "sending" || send.kind === "sent")) {
      const sent = send.kind === "sent";
      return (
        <BasedDialog open busy={!sent} onClose={closeReport} title={sent ? "Sent. Thank you!" : "Sending report…"}
          subtitle={sent ? "It’s with the Based team now. You don’t need to do anything else." : "Saved on this device. Sending it to the Based team."}
          actions={<>
            <BasedButton label="Open Diagnostics" variant="ghost" onClick={() => { closeReport(); onOpenDiagnostics(); }} />
            <BasedButton label="Done" variant="primary" busy={!sent} onClick={closeReport} />
          </>}>
          <VStack gap={1} data-testid="report-sent" data-state={send.kind}>
            <Text type="body">{`${s.saved.events} recorded events · ${s.saved.issues === 0 ? "no layout issues found" : `${s.saved.issues} layout issue${s.saved.issues === 1 ? "" : "s"} found`}`}</Text>
            <Text type="code" color="secondary" data-testid="report-id">{`Report ${s.saved.id}`}</Text>
          </VStack>
        </BasedDialog>
      );
    }
    const notSent = send?.kind === "later"
      ? "Couldn’t reach Based right now. The report will be sent automatically when you’re back online or next time Based starts."
      : send?.kind === "rejected" || send?.kind === "too-large" ? "Based couldn’t accept this report. Please email it to us instead." : undefined;
    return (
      <BasedDialog open onClose={closeReport} title="Report saved" subtitle={notSent ?? (s.saved.where === "this browser" ? "Kept in this browser. Save it as a file to pass it on." : "Agents can read it with `based reports`.")}
        actions={<>
          {canReveal ? <BasedButton label="Show in Finder" onClick={() => void reveal()} /> : <BasedButton label="Save as file…" onClick={() => void download()} />}
          <BasedButton label="Open Diagnostics" variant="ghost" onClick={() => { closeReport(); onOpenDiagnostics(); }} />
          <BasedButton label="Done" variant="primary" onClick={closeReport} />
        </>}>
        <VStack gap={4}>
          <VStack gap={1} data-testid="report-saved">
            <Text type="body">{`${s.saved.events} recorded events · ${s.saved.issues === 0 ? "no layout issues found" : `${s.saved.issues} layout issue${s.saved.issues === 1 ? "" : "s"} found`}`}</Text>
            {s.saved.where !== "this browser" ? <Text type="code" color="secondary" data-testid="report-where">{s.saved.where}</Text> : null}
            {send ? <Text type="body" color="secondary" data-testid="report-queued" data-state={send.kind}>{send.kind === "later" ? "Waiting to send" : "Not sent"}</Text> : null}
          </VStack>
          <VStack gap={2} data-testid="report-email" data-mailto={mail.href}>
            <Text type="body">{`Send it to ${FEEDBACK_EMAIL}`}</Text>
            <Text type="body" color="secondary">{inBrowser ? "Save it as a file first, then attach the file to the email." : "Attach the report folder from Finder to the email."}</Text>
            {mailFailed ? <Text type="body" color="secondary" data-testid="report-email-failed">{`Couldn’t open your mail app. Write to ${FEEDBACK_EMAIL} and attach the report.`}</Text> : null}
            <HStack><BasedButton label="Email report" onClick={email} /></HStack>
          </VStack>
        </VStack>
      </BasedDialog>
    );
  }

  const draft = s.draft;
  const save = async (andSend: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      if (andSend) await sendReport(note, { realText, screenshot: shot });
      else await saveReport(note, { realText, screenshot: shot });
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
        <BasedButton label="Save report" disabled={busy || !note.trim()} onClick={() => void save(false)} />
        <BasedButton label="Send to Based" variant="primary" busy={busy} disabled={!note.trim()} onClick={() => void save(true)} />
      </>}>
      <VStack gap={4} data-testid="report-dialog">
        <TextArea label="What did you do, and what happened?" value={note} onChange={setNote} rows={3} placeholder="Selected a paragraph and pressed Delete — a white box stayed over it." {...(error ? { status: { type: "error" as const, message: error } } : {})} />
        {shotURL && shot ? <img className="report-shot" src={shotURL} alt="Screenshot that will be included" data-testid="report-shot" draggable={false} /> : null}
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
