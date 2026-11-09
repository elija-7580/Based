// Home: Begrüßung, Hauptagent (Nachricht + Composer), „Based is working on“, „This week“, „Pick up again“.
// Listen als Flächen (v8), keine Karten. Agent-Details nur mit „Show agent details“. Agent-Abschnitte sind noch
// Demo (src/data.ts); „Pick up again“ zeigt die zuletzt geöffneten echten Seiten (BSD-153).
import { AgentBar } from "../components/AgentMark.js";
import { Composer } from "../components/Composer.js";
import { AGENT_TASKS, THIS_WEEK } from "../data.js";
import { Icon } from "../icons.js";
import { relative } from "../shell/format.js";
import type { RecentEntry } from "../shell/storage.js";
import type { ShellState } from "../worker/client.js";

function greeting(now: Date) {
  const h = now.getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

interface Props {
  showDetails: boolean;
  recent: RecentEntry[];
  state: ShellState;
  onOpenPage: (id: string) => void;
  onNewPage: () => void;
  now?: Date;
}

export function Home({ showDetails, recent, state, onOpenPage, onNewPage, now = new Date() }: Props) {
  const pickUp = recent.filter((r) => state.titles.has(r.id) && !state.outline?.trash.some((t) => t.id === r.id)).slice(0, 5);
  const sectionOf = (id: string) => {
    const o = state.outline;
    let n = o?.nodes[id];
    for (let i = 0; n?.parent && i < 100; i++) n = o?.nodes[n.parent];
    return n ? o?.sections.find((s) => s.id === n!.section)?.name ?? "" : "";
  };
  const date = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  return (
    <div className="content">
      <div className="column">
        <header>
          <div className="muted">{date}</div>
          <h1 className="t-greeting">{greeting(now)}, Elija</h1>
        </header>

        <section aria-label="Main agent" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <div className="agent-message">
            <AgentBar label="Message from Based" />
            <div style={{ flex: "1 1 300px", display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span className="t-meta">Based · 16:58</span>
              <p className="t-body">Lecture 4 is summarised. I'm drafting your statistics study plan — about ten minutes left. One thing needs you: approve a test run for BSD-112.</p>
            </div>
            <div className="actions">
              <button type="button" className="btn" disabled={!pickUp[0]} onClick={() => pickUp[0] && onOpenPage(pickUp[0].id)}>Open summary</button>
              <button type="button" className="btn primary">Approve</button>
            </div>
          </div>
          <Composer showDetails={showDetails} />
        </section>

        <div className="split">
          <section aria-labelledby="working">
            <div className="group-title"><h2 id="working" className="t-section">Based is working on</h2></div>
            <div className="group">
              {AGENT_TASKS.map((a) => (
                <div key={a.task} className="row">
                  <span className="tile"><Icon name={a.icon} /></span>
                  <span className="grow">
                    <strong>{a.task}</strong>
                    <span className="t-desc" style={{ display: "block" }}>
                      {a.where}
                      {showDetails ? <span className="details"> · {a.agent} · {a.model} · {a.time}</span> : null}
                    </span>
                  </span>
                  <span className="t-desc" style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", color: a.active ? "var(--ink)" : undefined }}>
                    <span className={a.active ? "dot agent" : "dot"} aria-hidden="true" />
                    {a.state}
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section aria-labelledby="week">
            <div className="group-title"><h2 id="week" className="t-section">This week</h2></div>
            <div className="group">
              {THIS_WEEK.map((d) => (
                <div key={d.title} className="row">
                  <span className="t-data" style={{ width: "var(--space-8)" }}>{d.day}</span>
                  <strong className="grow">{d.title}</strong>
                </div>
              ))}
            </div>
          </section>
        </div>

        <section aria-labelledby="recent">
          <div className="group-title">
            <h2 id="recent" className="t-section">Pick up again</h2>
            <button type="button" className="btn ghost" style={{ marginLeft: "auto" }} onClick={onNewPage}><Icon name="plus" size={16} />New page</button>
          </div>
          <div className="group">
            {pickUp.length === 0 ? <div className="row t-desc">{state.ready ? "Pages you open show up here." : "Opening your workspace…"}</div> : null}
            {pickUp.map((r) => (
              <button key={r.id} type="button" className="row" onClick={() => onOpenPage(r.id)}>
                <span className="tile"><Icon name={state.outline?.nodes[r.id]?.kind === "database" ? "database" : "page"} /></span>
                <strong className="grow">{state.titles.get(r.id)}</strong>
                <span className="t-desc">{sectionOf(r.id)}</span>
                <span className="t-desc" style={{ width: "var(--space-8)", textAlign: "right" }}>{relative(new Date(r.at), now)}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
