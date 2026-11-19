// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-580: Einstellungen → Connect AI apps → „Search by meaning“. Gleiche Bauteile wie „Transcription“ bei Meeting
// notes: eine Zeile mit Hinweis und Knopf. Geladen wird nur auf Klick („Turn on“); ohne Klick geht keine Anfrage an
// fremde Server. Während Download und Indexierung fragt die Zeile jede Sekunde nach dem Stand.
import { BasedButton } from "@based/ui/astryx";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { isTauri } from "../desktop.js";
import { transcriptionServers, type TranscriptionServer } from "../meeting/servers.js";
import { Lines, Row } from "../screens/settings/parts.js";
import { localServer } from "./localServer.js";
import { brainHint, brainModel, brainStatus, brainStep, type BrainStatus } from "./semanticSearch.js";

interface Found { server: TranscriptionServer; status: BrainStatus }

/** Erster Server, der die Suche nach Bedeutung anbietet (lokaler zuerst). */
async function findBrain(): Promise<Found | undefined> {
  for (const server of await transcriptionServers()) {
    const status = await brainStatus(server);
    if (status) return { server, status };
  }
  return undefined;
}

export function SemanticSearchSetup({ onOpenSync }: { onOpenSync?: (() => void) | undefined }) {
  const ls = localServer();
  const local = useSyncExternalStore(ls.subscribe, ls.getState);
  const [found, setFound] = useState<Found | null>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const refresh = useCallback(() => { void findBrain().then((f) => setFound(f ?? null), () => setFound(null)); }, []);
  useEffect(refresh, [refresh, local.status, local.url]);
  const step = brainStep(found?.status);
  useEffect(() => {
    if (step !== "downloading" && step !== "indexing") return;
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [step, refresh]);
  if (found === undefined) return <Lines gap={0} testID="semantic-search"><Row label="Search by meaning" hint="Checking…" /></Lines>;
  const desktop = isTauri();
  const act = (action: "download" | "cancel" | "remove") => {
    if (!found) return;
    setBusy(true);
    setProblem(undefined);
    brainModel(found.server, action).then(
      (s) => { if (s) setFound({ server: found.server, status: s }); },
      (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
    ).finally(() => setBusy(false));
  };
  const hint = brainHint(step, found?.status, { local: found?.server.local ?? false, desktop });
  return (
    <Lines gap={0} testID="semantic-search">
    <Row label="Search by meaning" hint={problem ? `${hint} ${problem}` : hint}>
      {step === "no-server" && !desktop && onOpenSync ? <BasedButton label="Open Sync & server" variant="ghost" onClick={onOpenSync} /> : null}
      {step === "off" ? <BasedButton label="Turn on" busy={busy} onClick={() => act("download")} /> : null}
      {step === "error" ? <BasedButton label="Try again" busy={busy} onClick={() => act("download")} /> : null}
      {step === "downloading" ? <BasedButton label="Cancel" variant="ghost" onClick={() => act("cancel")} /> : null}
      {step === "indexing" || step === "ready" || step === "error" ? <BasedButton label="Remove" variant="ghost" busy={busy} onClick={() => act("remove")} /> : null}
    </Row>
    </Lines>
  );
}
