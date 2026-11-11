// BSD-162/197 (Mockup v10, HomeV10): die Startseite. Kopf (Zeitrahmen, Kosten in Mono, Server-Status), Begrüßung mit
// einem Satz aus echten Ereignissen, Zeitbogen (erledigt · Needs you · geplant · innerer Ring = läuft) und die
// Auftragskarte direkt über dem Composer. Alles kommt aus den Agenten-Records (ShellState.agents) und der Laufzeit
// des Hauptagenten (tasks/runtime.ts); Lage und Zustände rechnen die reinen Funktionen in @based/brain/home.
// Ablauf beim Senden: Eingabe wird zur Karte → „versteht“ (Skelett) → Plan → die Karte fliegt in den inneren Ring
// bzw. ins Ziel auf dem Bogen (FLIP, nur Position und Deckkraft, 180 ms; bei „reduzierter Bewegung“ ohne Flug).
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { composerTask, costLine, greetingSentence, greetingWord, homeModel, taskCard, type Frame, type NeedsYou } from "@based/brain/home";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { chatController, openChatPanel } from "../chat/runtime.js";
import { Composer } from "../components/Composer.js";
import { SYNC_LABEL } from "../components/Sidebar.js";
import { dismissedCards, reducedMotion, useDismissed, useNow } from "../home/hooks.js";
import { TaskCard } from "../home/TaskCard.js";
import { TimeArc } from "../home/TimeArc.js";
import "../home/home.css";
import { Icon } from "../icons.js";
import type { Route } from "../shell/router.js";
import { tasksRuntime } from "../tasks/runtime.js";
import type { ShellState, StoreClient } from "../worker/client.js";

interface Props {
  client: StoreClient;
  state: ShellState;
  showDetails: boolean;
  onOpenPage: (id: string) => void;
  onNavigate: (r: Route) => void;
  onNewPage: () => void;
  onNewDatabase?: () => void;
}

const FRAME_KEY = "based.home.frame";
const readFrame = (): Frame => {
  try {
    const v = globalThis.localStorage?.getItem(FRAME_KEY);
    return v === "week" || v === "month" ? v : "today";
  } catch {
    return "today";
  }
};

export function Home({ client, state, showDetails, onOpenPage, onNavigate, onNewPage, onNewDatabase }: Props) {
  const rt = tasksRuntime(client);
  const ui = useSyncExternalStore(rt.subscribe, rt.getState);
  const snap = state.agents;
  const [frame, setFrame] = useState<Frame>(readFrame);
  const [error, setError] = useState<string>();
  const dismissed = useDismissed();

  useEffect(() => {
    if (state.ready && !snap) void client.agentSnapshot().catch(() => undefined);
  }, [state.ready, snap, client]);

  const busy = (snap?.runs ?? []).some((r) => r.data.status === "running" || r.data.status === "queued");
  const now = useNow(busy ? 1000 : 5000);
  const projectName = (id: string) => snap?.projects.find((p) => p.id === id)?.name;
  const titleOf = (id: string) => state.titles.get(id);

  const composer = useMemo(() => (snap ? composerTask(snap.tasks, snap.runs, now, dismissed) : {}), [snap, now, dismissed]);
  const composerView = composer.id && snap ? taskCard(snap.tasks.find((t) => t.id === composer.id)!, snap.runs, projectName) : undefined;
  const model = useMemo(
    () => (snap ? homeModel({ snapshot: snap, approvals: ui.approvals, active: ui.active, nowMs: now, frame, ...(composer.id ? { composerID: composer.id } : {}) }) : undefined),
    [snap, ui, now, frame, composer.id],
  );

  // Erledigte Karte nach der Haltezeit pünktlich wegschicken
  const [, tick] = useState(0);
  useEffect(() => {
    if (!composer.until) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, composer.until - Date.now()) + 30);
    return () => clearTimeout(t);
  }, [composer.until]);

  // MARK: Flug ins Ziel (FLIP)
  const cardRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const last = useRef<{ id: string; rect: DOMRect; flight: string; runID?: string } | undefined>(undefined);
  useLayoutEffect(() => {
    const prev = last.current;
    const el = cardRef.current?.firstElementChild as HTMLElement | null;
    if (composerView && el) {
      last.current = { id: composerView.id, rect: el.getBoundingClientRect(), flight: composerView.flight, ...(composerView.runID ? { runID: composerView.runID } : {}) };
    } else last.current = undefined;
    if (!prev || prev.id === composerView?.id || prev.flight === "none" || reducedMotion()) return;
    const sel = prev.flight === "ring" && prev.runID ? `[data-run-id="${prev.runID}"]` : `[data-task-id="${prev.id}"]`;
    const target = stageRef.current?.querySelector<HTMLElement>(sel);
    if (!target || typeof target.animate !== "function") return;
    const to = target.getBoundingClientRect();
    const dx = prev.rect.left + prev.rect.width / 2 - (to.left + to.width / 2);
    const dy = prev.rect.top + prev.rect.height / 2 - (to.top + to.height / 2);
    target.animate([{ transform: `translate(${dx}px, ${dy}px)`, opacity: 0.2 }, { transform: "translate(0, 0)", opacity: 1 }], { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" });
  });

  const act = (f: () => Promise<unknown> | unknown) => {
    setError(undefined);
    Promise.resolve()
      .then(f)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const submit = (text: string) => {
    if (!state.ready) return false;
    act(() => rt.submit(text));
    return true;
  };

  const approve = (n: Extract<NeedsYou, { kind: "approval" }>, how: "allow" | "always" | "no") =>
    act(async () => {
      if (how === "always" && snap) {
        const rules = snap.main.permissions.rules.trim();
        await client.agents({ op: "saveMain", patch: { rules: `${rules ? rules + "\n" : ""}allow based.${n.tool}` } });
      }
      rt.agents.approve(n.runID, n.callID, how !== "no");
    });

  const stopRun = (runID: string) =>
    act(async () => {
      rt.agents.cancel(runID);
      await client.agents({ op: "updateRun", id: runID, patch: { status: "cancelled", lease: null } });
    });

  const saveAsPage = () =>
    act(async () => {
      if (!composerView?.answer) return;
      const res = await client.chatTool("create_page", { title: composerView.input.slice(0, 120), markdown: composerView.answer });
      const id = /\(id: ([^)]+)\)/.exec(res.text)?.[1];
      if (res.isError || !id) throw new Error(res.text);
      dismissedCards.add(composerView.id);
      onOpenPage(id);
    });

  const continueInChat = () =>
    act(async () => {
      if (!composerView) return;
      const chat = await client.chatCreate(composerView.input.slice(0, 80));
      const at = Date.now();
      await client.chatSave(chat.id, 0, [
        { type: "userMessage", text: composerView.input, at },
        ...(composerView.answer !== undefined ? [{ type: "text" as const, text: composerView.answer }, { type: "result" as const, text: composerView.answer, isError: false }] : []),
      ]);
      dismissedCards.add(composerView.id);
      await chatController(client).open(chat.id);
      openChatPanel();
    });

  const segments = model ? greetingSentence(model, now, titleOf) : [];
  const synced = state.status.state === "synced" || state.status.state === "syncing";

  return (
    <div className="home" data-testid="home">
      <div className="home-inner">
        <header className="home-head">
          <SegmentedControl label="Time frame" size="sm" value={frame} onChange={(v) => {
            const f: Frame = v === "week" || v === "month" ? v : "today";
            setFrame(f);
            try { localStorage.setItem(FRAME_KEY, f); } catch { /* nur diese Sitzung */ }
          }}>
            <SegmentedControlItem value="today" label="Today" />
            <SegmentedControlItem value="week" label="Week" />
            <SegmentedControlItem value="month" label="Month" />
          </SegmentedControl>
          <span className="home-mono" data-testid="home-cost">{model ? costLine(model, frame) : "…"}</span>
          <span className="grow" />
          <span className="home-status t-meta" data-testid="home-server">
            <span className={`dot ${synced ? "synced-dot" : state.status.state === "error" ? "error-dot" : ""}`} aria-hidden="true" />
            {synced ? "Server connected" : SYNC_LABEL[state.status.state]}
          </span>
          <button type="button" className="btn ghost" onClick={onNewPage}><Icon name="plus" size={16} />New page</button>
          {onNewDatabase ? <button type="button" className="btn ghost" onClick={onNewDatabase}><Icon name="plus" size={16} />New database</button> : null}
        </header>

        <section className="home-greet" aria-label="Greeting">
          <h1 className="t-greeting">{greetingWord(now)}.</h1>
          <p data-testid="home-sentence">
            {segments.map((s, i) => (s.pageID ? <button key={i} type="button" className="home-mark" onClick={() => onOpenPage(s.pageID!)}>{s.text}</button> : s.marker ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
            {!snap ? <span>{state.ready ? "Loading what Based is doing…" : "Opening your workspace…"}</span> : null}
          </p>
        </section>

        <div ref={stageRef}>
          {model ? (
            <TimeArc model={model} frame={frame} nowMs={now} showDetails={showDetails} titleOf={titleOf}
              onOpenRun={(id) => onNavigate({ name: "agent", id })} onOpenPage={onOpenPage} onOpenProject={(id) => onNavigate({ name: "project", id })}
              onUndo={(id) => act(() => rt.runner.undo(id))} onApprove={approve} onAnswer={(id, o) => act(() => rt.runner.answer(id, o))}
              onConfirm={(id) => act(() => rt.runner.confirm(id))} onFile={(id) => act(() => rt.runner.dismiss(id))} onStopRun={stopRun} />
          ) : <div className="arc-stage" style={{ height: "var(--space-8)" }} />}
        </div>

        <div className="home-dock">
          <div className="home-cardslot" ref={cardRef}>
            {composerView ? (
              <TaskCard card={composerView} projectName={projectName}
                onAnswer={(o) => act(() => rt.runner.answer(composerView.id, o))} onConfirm={() => act(() => rt.runner.confirm(composerView.id))}
                onFile={() => act(() => rt.runner.dismiss(composerView.id))} onUndo={() => act(() => rt.runner.undo(composerView.id))}
                onRetry={() => act(() => rt.runner.retry(composerView.id))} onClose={() => dismissedCards.add(composerView.id)}
                onOpenPage={onOpenPage} onSaveAsPage={saveAsPage} onContinueInChat={continueInChat}
                onRaiseBudget={() => onNavigate({ name: "settings", page: "agents" })} onSetUpModel={() => onNavigate({ name: "settings", page: "agents" })}
                onOpenRun={(id) => onNavigate({ name: "agent", id })} onOpenProject={(id) => onNavigate({ name: "project", id })} />
            ) : null}
          </div>
          {error ? <p className="t-desc" role="alert" style={{ color: "var(--danger)", margin: 0 }}>{error}</p> : null}
          <Composer showDetails={showDetails} onSubmit={submit} disabled={!state.ready} label="Tell Based" inputID="home-ask"
            placeholder="Tell Based what to do — it becomes a card"
            details={`planner ${snap?.main.model ?? "auto"} · ${ui.ready ? "ready" : "no model set up"}`} />
          <p className="t-meta home-dock-hint">Everything you send becomes a card. It stays here until Based knows where it belongs.</p>
        </div>
      </div>
    </div>
  );
}
