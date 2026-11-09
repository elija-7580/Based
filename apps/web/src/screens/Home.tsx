// Home: Begrüßung, Hauptagent (Nachricht + Composer), „Based is working on“, „This week“, „Pick up again“.
// Listen als Flächen (v8), keine Karten. Agent-Details nur mit „Show agent details“.
import { AgentBar } from "../components/AgentMark.js";
import { Composer } from "../components/Composer.js";
import { AGENT_TASKS, RECENT, THIS_WEEK, type Screen } from "../data.js";
import { Icon } from "../icons.js";

function greeting(now: Date) {
  const h = now.getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Home({ showDetails, onNavigate, now = new Date() }: { showDetails: boolean; onNavigate: (s: Screen) => void; now?: Date }) {
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
              <button type="button" className="btn" onClick={() => onNavigate("page")}>Open summary</button>
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
          <div className="group-title"><h2 id="recent" className="t-section">Pick up again</h2></div>
          <div className="group">
            {RECENT.map((r) => (
              <button key={r.title} type="button" className="row" onClick={() => onNavigate(r.go)}>
                <span className="tile"><Icon name={r.icon} /></span>
                <strong className="grow">{r.title}</strong>
                <span className="t-desc">{r.space}</span>
                <span className="t-desc" style={{ width: "var(--space-8)", textAlign: "right" }}>{r.when}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
