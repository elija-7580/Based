// Feedback 17. 11.: Einstellungen → Meeting notes → „Transcription“. Zeigt den nächsten fehlenden Schritt, lässt das
// Sprachmodell wählen (Fast, Balanced, Best) und lädt es erst auf ausdrücklichen Klick (BSD-231: Opt-in, feste
// Quelle, Größe und Prüfsumme prüft der Server). In der Mac-App läuft whisper.cpp über den lokalen Server auf diesem
// Mac; „Turn on“ startet ihn und lädt das Modell in einem Schritt. Im Browser: über den verbundenen Server.
import { BasedButton, BasedMenu } from "@based/ui/astryx";
import { isTauri } from "../desktop.js";
import { Row } from "../screens/settings/parts.js";
import { useTranscriptionSetup } from "./useTranscription.js";
import { downloadPercent, megabytes, modelLabel, MODEL_TIERS, type TranscribeModelChoice, type TranscribeStatus, type TranscriptionStep } from "./whisper.js";

const tierOf = (m: Pick<TranscribeModelChoice, "id" | "name"> | undefined) => (m ? MODEL_TIERS[m.id]?.tier ?? m.name ?? m.id : "the speech model");

/**
 * Reine Texte (getestet): Hinweis je Schritt. `local`: Server auf diesem Mac; `desktop`: läuft in der Mac-App;
 * `choice`: das Modell, auf das sich die Knöpfe beziehen.
 */
export function transcriptionHint(step: TranscriptionStep, o: { local: boolean; desktop: boolean; status?: TranscribeStatus | undefined; choice?: TranscribeModelChoice | undefined }): string {
  const model = o.choice ?? o.status?.model;
  const failed = model?.error && model.error !== "cancelled" ? ` The last download failed: ${model.error}.` : "";
  switch (step) {
    case "no-server":
      return o.desktop
        ? "Off. Turn it on to get transcripts of your recordings, made on this Mac. Based downloads a speech model once (488 MB) from huggingface.co."
        : "Needs a Based server that offers transcription. Connect one in Sync & server.";
    case "no-engine":
      return o.local
        ? "This build of Based doesn't include whisper.cpp. In Terminal, run “brew install whisper-cpp”, then check again."
        : "whisper.cpp isn't installed on your server yet.";
    case "no-model": {
      if (o.status?.model.source === "file") return "The server's speech model file is missing.";
      const tier = o.choice ? MODEL_TIERS[o.choice.id]?.hint : undefined;
      return `Download a speech model once from huggingface.co; after that, transcription works offline.${tier ? ` ${tier}` : ""}${failed}`;
    }
    case "downloading": {
      const pct = model ? downloadPercent(model) : undefined;
      return `Downloading ${tierOf(o.choice)}${model?.size ? ` (${megabytes(model.size)})` : ""}…${pct === undefined ? "" : ` ${pct} %`}`;
    }
    case "ready": {
      const where = o.local ? "Recordings are transcribed on this Mac; the audio doesn't leave it." : "Recordings are transcribed on your server.";
      if (o.choice && !o.choice.installed) return `Ready with another model. ${MODEL_TIERS[o.choice.id]?.hint ?? ""}${failed}`.trim();
      return `Ready${o.choice?.active ? ` with ${tierOf(o.choice)}` : ""}. ${where}`;
    }
  }
}

export function TranscriptionSetup() {
  const t = useTranscriptionSetup();
  if (t.found === undefined) return <Row label="Transcription" hint="Checking…" />;
  const desktop = isTauri();
  const status = t.found?.status;
  const hint = transcriptionHint(t.step, { local: t.found?.server.local ?? false, desktop, status, choice: t.choice });
  const models = status?.models;
  const c = t.choice;
  const canChoose = models && models.length > 1 && status?.engineInstalled && t.step !== "downloading";
  return (
    <Row label="Transcription" hint={t.problem ? `${hint} ${t.problem}` : hint}>
      {canChoose && c ? (
        <BasedMenu
          label={`${modelLabel(c)}${c.installed ? " · downloaded" : ""}`}
          align="end"
          items={models.map((m) => ({
            label: `${modelLabel(m)}${m.installed ? " · downloaded" : ""}`,
            description: MODEL_TIERS[m.id]?.hint ?? m.name ?? "",
            onSelect: () => t.choose(m.id),
          }))}
        />
      ) : null}
        {t.step === "no-server" && desktop ? <BasedButton label="Turn on" busy={t.busy} onClick={t.turnOn} /> : null}
        {t.step === "no-engine" ? <BasedButton label="Check again" busy={t.busy} onClick={t.refresh} /> : null}
        {t.step === "downloading" ? <BasedButton label="Cancel" variant="ghost" onClick={() => t.act("cancel")} /> : null}
        {(t.step === "no-model" || t.step === "ready") && c && !c.installed ? <BasedButton label="Download" busy={t.busy} onClick={() => t.act("download")} /> : null}
        {(t.step === "no-model" || t.step === "ready") && c && c.installed && !c.active ? <BasedButton label="Use this model" busy={t.busy} onClick={() => t.act("select")} /> : null}
        {t.step === "ready" && c && c.installed && c.active ? <BasedButton label="Remove" variant="ghost" busy={t.busy} onClick={() => t.act("remove")} /> : null}
        {t.step === "no-model" && !models && status?.model.source === "catalog" ? <BasedButton label="Download" busy={t.busy} onClick={() => t.act("download")} /> : null}
    </Row>
  );
}
