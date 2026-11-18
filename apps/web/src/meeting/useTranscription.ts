// Elija 17.11.: Transkription mit einem Klick einschalten – gemeinsam für Einstellungen → Meeting notes und den
// Willkommensbildschirm. „Einschalten“ heißt in der Mac-App: lokalen Server starten (falls aus), das gewählte
// Sprachmodell laden (Standard: Balanced/small) und es zum gewählten machen. Geladen wird nur auf diesen Klick.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { isTauri } from "../desktop.js";
import { localServer, type LocalServerState } from "../desktop/localServer.js";
import { transcriptionServers, type TranscriptionServer } from "./servers.js";
import { transcribeModel, transcribeStatus, transcriptionChanged, transcriptionStep, type TranscribeModelChoice, type TranscribeStatus, type TranscriptionStep } from "./whisper.js";

export interface Found { server: TranscriptionServer; status: TranscribeStatus }

/** Erster Server, der Transkription anbietet (lokaler zuerst). */
export async function findTranscription(): Promise<Found | undefined> {
  for (const server of await transcriptionServers()) {
    const status = await transcribeStatus(server);
    if (status) return { server, status };
  }
  return undefined;
}

/** Wartet, bis der lokale Server läuft oder gescheitert ist (rein über den Zustand; getestet mit einem Doppel). */
export function waitForLocalServer(ls: { getState(): Pick<LocalServerState, "status" | "error">; subscribe(fn: () => void): () => void }, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const s = ls.getState();
      if (s.status === "running") { done(); resolve(); }
      else if (s.status === "failed" || s.status === "unavailable") { done(); reject(new Error(s.error ?? "The local server didn't start.")); }
    };
    const off = ls.subscribe(check);
    const timer = setTimeout(() => { done(); reject(new Error("The local server didn't start in time.")); }, timeoutMs);
    const done = () => { off(); clearTimeout(timer); };
    check();
  });
}

/** Reine Regel (getestet): Was tut „Einschalten“ bei diesem Stand mit dem gewünschten Modell? */
export function turnOnAction(status: TranscribeStatus, want?: string): { action: "download" | "select"; id: string } | undefined {
  if (!status.engineInstalled || !status.models?.length) return status.engineInstalled && status.model.source === "catalog" && !status.model.installed ? { action: "download", id: "" } : undefined;
  const m = status.models.find((x) => x.id === want) ?? status.models.find((x) => x.active) ?? status.models[0]!;
  if (m.downloading) return undefined;
  if (!m.installed) return { action: "download", id: m.id };
  return m.active ? undefined : { action: "select", id: m.id };
}

/** Einschalten: lokalen Server starten (Mac-App), dann das Modell laden bzw. wählen. Gibt den neuen Stand zurück. */
export async function turnOnTranscription(want?: string): Promise<Found | undefined> {
  if (isTauri()) {
    const ls = localServer();
    if (ls.getState().status !== "running") {
      await ls.setEnabled(true);
      await waitForLocalServer(ls);
    }
  }
  const found = await findTranscription();
  if (!found) return undefined;
  const next = turnOnAction(found.status, want);
  if (next) await transcribeModel(found.server, next.action, undefined, next.id || undefined);
  transcriptionChanged();
  return findTranscription();
}

export interface TranscriptionSetupState {
  /** `undefined`: wird geprüft; `null`: kein Server bietet Transkription an. */
  found: Found | null | undefined;
  step: TranscriptionStep;
  busy: boolean;
  problem: string | undefined;
  /** Modell, auf das sich die Knöpfe beziehen (Auswahl in den Einstellungen; Standard: das gewählte des Servers). */
  choice: TranscribeModelChoice | undefined;
  choose(id: string): void;
  turnOn(): void;
  act(action: "download" | "select" | "cancel" | "remove"): void;
  refresh(): void;
}

export function useTranscriptionSetup(): TranscriptionSetupState {
  const ls = localServer();
  const local = useSyncExternalStore(ls.subscribe, ls.getState);
  const [found, setFound] = useState<Found | null>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [picked, setPicked] = useState<string>();

  const load = useCallback(async () => {
    const f = await findTranscription();
    setFound(f ?? null);
    return f;
  }, []);
  // Neu fragen, wenn der lokale Server startet oder stoppt.
  useEffect(() => { void load(); }, [load, local.status, local.url]);

  const step = transcriptionStep(found?.status);
  // Während des Ladens jede Sekunde den Stand holen; am Ende dem Aufnahmedienst Bescheid geben.
  useEffect(() => {
    if (step !== "downloading") return;
    const t = setInterval(() => void load().then((f) => { if (f && transcriptionStep(f.status) !== "downloading") transcriptionChanged(); }), 1000);
    return () => clearInterval(t);
  }, [step, load]);

  const models = found?.status.models;
  const choice = models?.find((m) => m.downloading) ?? models?.find((m) => m.id === picked) ?? models?.find((m) => m.active);
  const guard = (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(undefined);
    void work().catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e))).then(load).finally(() => { setBusy(false); transcriptionChanged(); });
  };
  return {
    found, step, busy, problem, choice,
    choose: setPicked,
    turnOn: () => guard(() => turnOnTranscription(picked)),
    act: (action) => { if (found) guard(() => transcribeModel(found.server, action, undefined, choice?.id)); },
    refresh: () => guard(async () => undefined),
  };
}
