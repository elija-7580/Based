// BSD-133 (Mockup v10, ProjectV10): Projekt-Detail. Kopf mit Projekt-Kachel, Status und Ziel, Kennzahlen (Running,
// Done this week, Planned, Budget im Monat), Timeline 2 Wochen zurück / 1 voraus, „Updates from the main agent“;
// rechts Running now, „Landed here“, Pages (Unterseiten der Projektseite), Up next und ein Eingabefeld an den
// Hauptagenten mit Projekt-Bezug (die Eingabe wird mit „For <Projekt>:“ eingeleitet – der Kern kennt noch keinen
// Projekt-Kontext beim Senden).
import { BreadcrumbItem, Breadcrumbs } from "@astryxdesign/core/Breadcrumbs";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { toMs } from "@based/brain";
import { projectDetail } from "@based/brain/home";
import { useEffect, useRef, useState } from "react";
import { Composer } from "../components/Composer.js";
import { Icon } from "../icons.js";
import type { Route } from "../shell/router.js";
import { tasksRuntime } from "../tasks/runtime.js";
import type { ShellState, StoreClient } from "../worker/client.js";
import { useNow, when } from "./hooks.js";
import { Timeline } from "./Timeline.js";
import "./home.css";

interface Props {
  client: StoreClient;
  state: ShellState;
  projectID: string;
  showDetails: boolean;
  onNavigate: (r: Route) => void;
  onOpenPage: (id: string) => void;
}

export function ProjectDetailScreen({ client, state, projectID, showDetails, onNavigate, onOpenPage }: Props) {
  const rt = tasksRuntime(client);
  const snap = state.agents;
  const now = useNow(5000);
  const [sent, setSent] = useState<string>();
  const ask = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.ready && !snap) void client.agentSnapshot().catch(() => undefined);
  }, [state.ready, snap, client]);

  if (!snap) return <div className="detail"><p className="t-desc">Loading…</p></div>;
  const d = projectDetail(projectID, snap, now);
  if (!d) {
    return (
      <div className="detail"><div className="detail-inner">
        <Heading level={1}>This project no longer exists</Heading>
        <span><Button label="Back to Home" variant="secondary" onClick={() => onNavigate({ name: "home" })} /></span>
      </div></div>
    );
  }
  const p = d.project;
  const pages = p.data.pageID ? (state.outline?.children[p.data.pageID] ?? []).filter((id) => state.titles.has(id)) : [];
  const fmtDay = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  return (
    <div className="detail" data-testid="project-detail">
      <div className="detail-inner">
        <Breadcrumbs label="Project location">
          <BreadcrumbItem onClick={() => onNavigate({ name: "home" })}>Home</BreadcrumbItem>
          <BreadcrumbItem isCurrent>{p.name}</BreadcrumbItem>
        </Breadcrumbs>
        <section style={{ display: "flex", gap: "var(--space-4)", alignItems: "center", flexWrap: "wrap" }}>
          <span className="project-tile" aria-hidden="true"><Icon name="teamspace" /></span>
          <span style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", flex: 1, minWidth: 0 }}>
            <Heading level={1}>{p.name}</Heading>
            <span className="t-meta">{p.data.status}{" · "}{p.data.goal ?? "No goal yet — tell the main agent what this project is for."}</span>
          </span>
          <span className="task-actions">
            <Button size="sm" variant="primary" label="Give an agent a task" onClick={() => ask.current?.querySelector("textarea")?.focus()} />
            {p.data.pageID && state.titles.has(p.data.pageID) ? <Button size="sm" variant="secondary" label="Open project page" onClick={() => onOpenPage(p.data.pageID!)} /> : null}
          </span>
        </section>

        <section className="metrics" aria-label="Key figures">
          {d.metrics.map((m) => (
            <span key={m.label} className="metric"><span className="t-meta">{m.label}</span><span className="v">{m.value}</span>{m.sub ? <span className="t-meta">{m.sub}</span> : null}</span>
          ))}
        </section>

        <div className="detail-grid">
          <div className="detail-col">
            <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              <h2 className="t-section">Two weeks back, one ahead</h2>
              <Timeline data={d.timeline} axis={[fmtDay(d.timeline.fromMs), "today", fmtDay(d.timeline.toMs)]} />
            </section>
            <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }} aria-label="Updates from the main agent">
              <h2 className="t-section">Updates from the main agent</h2>
              {d.updates.length === 0 ? <p className="t-desc" style={{ margin: 0 }}>No updates yet. When the main agent files something into {p.name} or an agent finishes here, it shows up here and on the project page.</p> : null}
              {d.updates.slice(0, 12).map((u) => (
                <span key={u.id} className="update-row" style={{ display: "flex", gap: "var(--space-3)" }}>
                  <span className="home-mono">{when(u.atMs, now)}</span>
                  <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{u.text}</span>
                </span>
              ))}
            </section>
          </div>

          <aside className="detail-col">
            <section className="panel-box" aria-label="Running now">
              <strong>Running now</strong>
              {d.running.length === 0 ? <span className="t-desc">Nothing right now.</span> : (
                <ul className="plain-list">
                  {d.running.map((r) => <li key={r.id}><span className={r.data.status === "needsYou" ? "pulse needs" : "pulse"} aria-hidden="true" /><span className="grow"><button type="button" className="arc-link" onClick={() => onNavigate({ name: "agent", id: r.id })}>{r.data.title || r.name}</button></span></li>)}
                </ul>
              )}
            </section>
            <section className="panel-box" aria-label="Landed here" data-testid="project-landed">
              <strong>Landed here</strong>
              {d.landed.length === 0 ? <span className="t-desc">Task cards that end up in {p.name} appear here.</span> : (
                <ul className="plain-list">
                  {d.landed.slice(0, 8).map((l) => (
                    <li key={l.taskID}>
                      <span className="grow">{l.title}<span className="t-meta">{` · ${l.target}`}</span></span>
                      {l.pageID && state.titles.has(l.pageID) ? <button type="button" className="arc-link" onClick={() => onOpenPage(l.pageID!)}>Open</button> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {pages.length > 0 ? (
              <section className="panel-box" aria-label="Pages">
                <strong>Pages</strong>
                <ul className="plain-list">
                  {pages.slice(0, 8).map((id) => <li key={id}><Icon name="page" size={14} /><span className="grow"><button type="button" className="arc-link" onClick={() => onOpenPage(id)}>{state.titles.get(id)}</button></span></li>)}
                </ul>
              </section>
            ) : null}
            <section className="panel-box" aria-label="Up next">
              <strong>Up next</strong>
              {d.upNext.length === 0 ? <span className="t-desc">Nothing planned.</span> : (
                <ul className="plain-list">
                  {d.upNext.map((s) => <li key={s.id}><span className="home-mono">{when(toMs(s.data.nextAt!), now)}</span><span className="grow">{s.name || s.data.prompt}</span></li>)}
                </ul>
              )}
            </section>
            <section ref={ask} aria-label={`Ask about ${p.name}`} style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              <Composer showDetails={showDetails} hide={["agent", "compute", "permission"]} label={`Tell Based about ${p.name}`} inputID="project-ask" placeholder={`Something for ${p.name}…`}
                onSubmit={(text) => { void rt.submit(`For ${p.name}: ${text}`).then(() => setSent(text)); return true; }} />
              {sent ? <span className="t-meta" role="status">{`Sent — the card is on Home.`}</span> : null}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
