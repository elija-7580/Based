// Feedback 17. 11.: Einstellungen → Meeting notes → „Transcription“. Zeigt den nächsten fehlenden Schritt und lädt
// das Sprachmodell erst auf ausdrücklichen Klick (BSD-231: Opt-in, feste Quelle, Größe und Prüfsumme prüft der Server).
// In der Mac-App läuft whisper.cpp über den lokalen Server auf diesem Mac; im Browser über den verbundenen Server.
import { BasedButton } from "@based/ui/astryx";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { isTauri } from "../desktop.js";
import { localServer } from "../desktop/localServer.js";
import { Row } from "../screens/settings/parts.js";
import { transcriptionServers, type TranscriptionServer } from "./servers.js";
import { downloadPercent, megabytes, transcribeModel, transcribeStatus, transcriptionChanged, transcriptionStep, type TranscribeStatus, type TranscriptionStep } from "./whisper.js";

/** Reine Texte (getestet): Hinweis je Schritt. `local`: Server auf diesem Mac; `desktop`: läuft in der Mac-App. */
export function transcriptionHint(step: TranscriptionStep, o: { local: boolean; desktop: boolean; status?: TranscribeStatus | undefined }): string {
  const model = o.status?.model;
  const failed = model?.error && model.error !== "cancelled" ? ` The last download failed: ${model.error}.` : "";
  switch (step) {
    case "no-server":
      return o.desktop
        ? "Based transcribes on this Mac with whisper.cpp, through the local server. Turn on the local server in Sync & server first."
        : "Needs a Based server that offers transcription. Connect one in Sync & server.";
    case "no-engine":
      return o.local
        ? "whisper.cpp isn't installed on this Mac yet. In Terminal, run “brew install whisper-cpp”, then check again."
        : "whisper.cpp isn't installed on your server yet.";
    case "no-model":
      if (model?.source !== "catalog") return "The server's speech model file is missing.";
      return `One step left: download the speech model (${[model.name, megabytes(model.size)].filter(Boolean).join(", ")}) from huggingface.co. After that, transcription works offline.${failed}`;
    case "downloading": {
      const pct = model ? downloadPercent(model) : undefined;
      return `Downloading the speech model…${pct === undefined ? "" : ` ${pct} %`}`;
    }
    case "ready":
      return o.local ? "Ready. Recordings are transcribed on this Mac; the audio doesn't leave it." : "Ready. Recordings are transcribed on your server.";
  }
}

export function TranscriptionSetup() {
  const ls = localServer();
  const local = useSyncExternalStore(ls.subscribe, ls.getState);
  const [found, setFound] = useState<{ server: TranscriptionServer; status: TranscribeStatus } | null>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const load = useCallback(async () => {
    for (const server of await transcriptionServers()) {
      const status = await transcribeStatus(server);
      if (status) { setFound({ server, status }); return status; }
    }
    setFound(null);
    return undefined;
  }, []);
  // Neu fragen, wenn der lokale Server startet oder stoppt.
  useEffect(() => { void load(); }, [load, local.status, local.url]);

  const step = transcriptionStep(found?.status);
  // Während des Ladens jede Sekunde den Stand holen; am Ende dem Aufnahmedienst Bescheid geben.
  useEffect(() => {
    if (step !== "downloading") return;
    const t = setInterval(() => void load().then((s) => { if (s && !s.model.downloading) transcriptionChanged(); }), 1000);
    return () => clearInterval(t);
  }, [step, load]);

  const act = (action: "download" | "cancel" | "remove") => {
    if (!found) return;
    setBusy(true);
    setProblem(undefined);
    void transcribeModel(found.server, action)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .then(load)
      .finally(() => { setBusy(false); transcriptionChanged(); });
  };

  if (found === undefined) return <Row label="Transcription" hint="Checking…" />;
  const hint = transcriptionHint(step, { local: found?.server.local ?? false, desktop: isTauri(), status: found?.status });
  const catalog = found?.status.model.source === "catalog";
  return (
    <Row label="Transcription" hint={problem ? `${hint} ${problem}` : hint}>
      {step === "no-engine" ? <BasedButton label="Check again" busy={busy} onClick={() => { setBusy(true); void load().finally(() => { setBusy(false); transcriptionChanged(); }); }} /> : null}
      {step === "no-model" && catalog ? <BasedButton label="Download model" busy={busy} onClick={() => act("download")} /> : null}
      {step === "downloading" ? <BasedButton label="Cancel" variant="ghost" onClick={() => act("cancel")} /> : null}
      {step === "ready" && catalog ? <BasedButton label="Remove model" variant="ghost" busy={busy} onClick={() => act("remove")} /> : null}
    </Row>
  );
}
