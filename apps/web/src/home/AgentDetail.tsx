// BSD-133 (Mockup v10, AgentV10): Agent-Detail – Klick auf eine laufende Karte. Breadcrumb, Status, Titel mit Tags,
// Kennzahlen, Timeline je Beteiligtem, Schritte (Werkzeug-Aufrufe aus dem Transkript) und Live-Protokoll; rechts
// Needs you, „Who works here“, „Result lands in“ und „Started from“ (die ursprüngliche Auftragskarte). Alles aus den
// Records; Pause gibt es im Kern nicht und fehlt deshalb.
import { BreadcrumbItem, Breadcrumbs } from "@astryxdesign/core/Breadcrumbs";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { isRunFinished, toMs, type StoredChatEvent } from "@based/brain";
import { agentDetail } from "@based/brain/home";
import { useEffect, useState, useSyncExternalStore } from "react";
import { chatController, openChatPanel } from "../chat/runtime.js";
import type { Route } from "../shell/router.js";
import { tasksRuntime } from "../tasks/runtime.js";
import type { ShellState, StoreClient } from "../worker/client.js";
import { clock, useNow } from "./hooks.js";
import { Timeline } from "./Timeline.js";
import "./home.css";

interface Props {
  client: StoreClient;
  state: ShellState;
  runID: string;
  onNavigate: (r: Route) => void;
  onOpenPage: (id: string) => void;
}

export function AgentDetailScreen({ client, state, runID, onNavigate, onOpenPage }: Props) {
  const rt = tasksRuntime(client);
  const ui = useSyncExternalStore(rt.subscribe, rt.getState);
  const snap = state.agents;
  const now = useNow(1000);
  const [steps, setSteps] = useState<{ id: string; name: string; ok: boolean | undefined }[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (state.ready && !snap) void client.agentSnapshot().catch(() => undefined);
  }, [state.ready, snap, client]);

  const d = snap ? agentDetail(runID, snap, now, (id) => state.titles.get(id)) : undefined;
  const chatID = d?.run.data.chatID;
  const finished = d ? isRunFinished(d.run.data.status) : false;
  // Schritte aus dem Transkript (wird am Ende eines Laufs gespeichert)
  useEffect(() => {
    if (!chatID) return;
    let live = true;
    client.chatLoad(chatID).then((c) => {
      if (!live) return;
      const results = new Map<string, boolean>();
      for (const e of c.events as StoredChatEvent[]) if (e.type === "toolResult") results.set((e as { id: string }).id, !(e as { isError: boolean }).isError);
      setSteps(c.events.filter((e): e is Extract<StoredChatEvent, { type: "toolUse" }> => e.type === "toolUse").map((e) => ({ id: e.id, name: e.name, ok: results.get(e.id) })));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [client, chatID, finished]);

  if (!snap) return <div className="detail"><p className="t-desc">Loading…</p></div>;
  if (!d) {
    return (
      <div className="detail"><div className="detail-inner">
        <Heading level={1}>This agent run no longer exists</Heading>
        <span><Button label="Back to Home" variant="secondary" onClick={() => onNavigate({ name: "home" })} /></span>
      </div></div>
    );
  }

  const act = (f: () => Promise<unknown> | unknown) => {
    setError(undefined);
    Promise.resolve().then(f).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const r = d.run.data;
  const here = ui.active.includes(runID);
  const approvals = ui.approvals.filter((a) => a.runID === runID);
  const openChat = (id: string) => act(async () => { await chatController(client).open(id); openChatPanel(); });
  const continueInChat = () => act(async () => {
    if (!d.task) return;
    const chat = await client.chatCreate(d.task.title.slice(0, 80));
    const events: StoredChatEvent[] = [{ type: "userMessage", text: d.task.data.input, at: Date.now() }];
    if (r.result) events.push({ type: "text", text: r.result }, { type: "result", text: r.result, isError: false });
    await client.chatSave(chat.id, 0, events);
    openChat(chat.id);
  });

  return (
    <div className="detail" data-testid="agent-detail">
      <div className="detail-inner">
        <Breadcrumbs label="Agent location">
          <BreadcrumbItem onClick={() => onNavigate({ name: "home" })}>Home</BreadcrumbItem>
          {d.project ? <BreadcrumbItem onClick={() => onNavigate({ name: "project", id: d.project!.id })}>{d.project.name}</BreadcrumbItem> : null}
          <BreadcrumbItem isCurrent>{d.title}</BreadcrumbItem>
        </Breadcrumbs>
        <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <span className="t-meta" data-testid="agent-status" style={{ display: "inline-flex", gap: "var(--space-2)", alignItems: "center" }}>
            <span className={r.status === "running" || r.status === "queued" ? "pulse" : r.status === "needsYou" ? "pulse needs" : "dot"} aria-hidden="true" />
            {r.status === "running" && here ? "running in this tab" : d.status}
          </span>
          <Heading level={1}>{d.title}</Heading>
          <span className="detail-tags">
            <span className="tag">{d.kindLabel}</span>
            {d.project ? <span className="tag"><button type="button" onClick={() => onNavigate({ name: "project", id: d.project!.id })}>{d.project.name}</button></span> : null}
            {r.model ? <span className="tag mono">{r.model}</span> : null}
            {d.task ? <span className="tag">{`asked by you${d.task.data.source === "composer" ? " on Home" : d.task.data.source ? ` via ${d.task.data.source}` : ""} · `}<span className="home-mono">{clock(toMs(d.task.data.createdAt))}</span></span> : null}
          </span>
          <span className="task-actions">
            {r.chatID && finished ? <Button size="sm" variant="secondary" label="Open transcript" onClick={() => openChat(r.chatID!)} /> : null}
            {!finished ? <Button size="sm" variant="secondary" label="Stop" onClick={() => act(async () => { rt.agents.cancel(runID); await client.agents({ op: "updateRun", id: runID, patch: { status: "cancelled", lease: null } }); })} /> : null}
          </span>
          {error ? <p className="t-desc" role="alert" style={{ color: "var(--danger)", margin: 0 }}>{error}</p> : null}
        </section>

        <section className="metrics" aria-label="Key figures">
          {d.metrics.map((m) => (
            <span key={m.label} className="metric"><span className="t-meta">{m.label}</span><span className="v">{m.value}</span>{m.sub ? <span className="t-meta">{m.sub}</span> : null}</span>
          ))}
        </section>

        <div className="detail-grid">
          <div className="detail-col">
            <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              <h2 className="t-section">Who did what, when</h2>
              <Timeline data={d.timeline} />
            </section>
            {steps.length > 0 ? (
              <section aria-label="Steps" style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                <h2 className="t-section">Steps</h2>
                <ol className="plain-list">
                  {steps.map((s) => <li key={s.id}><span aria-label={s.ok === false ? "failed" : "done"}>{s.ok === false ? "✗" : "✓"}</span><span className="grow">{s.name.replace(/_/g, " ")}</span></li>)}
                </ol>
              </section>
            ) : null}
            <section aria-label="Live" style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              <h2 className="t-section">Live</h2>
              <ol className="plain-list" data-testid="agent-live">
                {d.live.map((l, i) => (
                  <li key={i}><span className="home-mono">{clock(l.atMs)}</span><span className="grow"><span className="live-verb">{l.verb}</span>{l.text ? ` ${l.text}` : ""}</span></li>
                ))}
              </ol>
              {r.result && finished ? <p className="t-desc" style={{ margin: 0 }} data-testid="agent-result">{r.result}</p> : null}
            </section>
          </div>

          <aside className="detail-col" aria-label="About this run">
            {approvals.map((a) => (
              <section key={a.callID} className="panel-box needs" aria-label="Needs you">
                <strong>Needs you</strong>
                <span>{`${d.title} wants to use ${a.name.replace(/_/g, " ")}.`}</span>
                <span className="task-actions">
                  <Button size="sm" variant="primary" label="Allow" onClick={() => rt.agents.approve(runID, a.callID, true)} />
                  <Button size="sm" variant="secondary" label="Always" onClick={() => act(async () => {
                    const rules = snap.main.permissions.rules.trim();
                    await client.agents({ op: "saveMain", patch: { rules: `${rules ? rules + "\n" : ""}allow based.${a.name}` } });
                    rt.agents.approve(runID, a.callID, true);
                  })} />
                  <Button size="sm" variant="ghost" label="No" onClick={() => rt.agents.approve(runID, a.callID, false)} />
                </span>
              </section>
            ))}
            <section className="panel-box" aria-label="Who works here">
              <strong>Who works here</strong>
              <ul className="plain-list who-tree">
                {d.tree.map((n) => (
                  <li key={n.id} style={{ ["--depth" as string]: n.depth }}>
                    <span className={n.status === "running" ? "pulse" : n.status === "needsYou" ? "pulse needs" : "dot"} aria-hidden="true" />
                    <span className="grow">{n.id === runID ? <strong>{n.label}</strong> : <button type="button" className="arc-link" onClick={() => onNavigate({ name: "agent", id: n.id })}>{n.label}</button>}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="panel-box" aria-label="Result lands in">
              <strong>Result lands in</strong>
              <ul className="plain-list">
                {d.lands.map((l) => (
                  <li key={l.label}>
                    {l.pageID ? <button type="button" className="arc-link" onClick={() => onOpenPage(l.pageID!)}>{l.label}</button>
                      : l.projectID ? <button type="button" className="arc-link" onClick={() => onNavigate({ name: "project", id: l.projectID! })}>{l.label}</button>
                      : <span className="t-desc">{l.label}</span>}
                  </li>
                ))}
              </ul>
            </section>
            {d.task ? (
              <section className="panel-box agent" aria-label="Started from" data-testid="agent-started-from">
                <strong>Started from</strong>
                <span className="t-meta">{`Task card · `}<span className="home-mono">{clock(toMs(d.task.data.createdAt))}</span></span>
                <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{d.task.data.input}</span>
                <span className="task-actions"><Button size="sm" variant="ghost" label="Continue in chat" onClick={continueInChat} /></span>
              </section>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
