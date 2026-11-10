// BSD-133: Timeline „who did what, when“ – eine Spur je Beteiligtem, Jetzt-Linie; Balken: erledigt grau, läuft
// Marker, wartet auf dich dunkel, geplant gestrichelt. Lage in % rechnet @based/brain/home.
import type { Timeline as TimelineData } from "@based/brain/home";
import { clock } from "./hooks.js";

const KIND_TEXT = { done: "done", running: "running", needsYou: "waiting for you", planned: "planned", failed: "failed" } as const;

export function Timeline({ data, axis }: { data: TimelineData; axis?: [string, string, string] }) {
  const now = Math.min(100, Math.max(0, data.now));
  const labels = axis ?? [clock(data.fromMs), "now", clock(data.toMs)];
  return (
    <section aria-label="Timeline" data-testid="timeline">
      <div className="timeline" role="list">
        {data.lanes.map((l) => (
          <div key={l.id} role="listitem" style={{ display: "contents" }}>
            <span className="lane-label" title={l.label}>{l.label}</span>
            <span className="track">
              {l.bars.map((b) => (
                <span key={b.id} className="bar" data-kind={b.kind} data-dot={b.dot ? "" : undefined} style={{ left: `${b.left}%`, width: `${b.width}%` }} title={`${b.label} · ${KIND_TEXT[b.kind]}`} />
              ))}
              <span className="now" style={{ left: `${now}%` }} aria-hidden="true" />
            </span>
          </div>
        ))}
        <span />
        <span className="axis t-data" style={{ position: "relative" }}>
          <span>{labels[0]}</span>
          <span style={{ position: "absolute", left: `${now}%`, transform: "translateX(-50%)" }}>{labels[1]}</span>
          <span>{labels[2]}</span>
        </span>
      </div>
      <p className="timeline-legend t-meta" style={{ marginTop: "var(--space-2)" }}>
        <span><i data-kind="done" />done</span><span><i data-kind="running" />running</span><span><i data-kind="needsYou" />waiting for you</span><span><i data-kind="planned" />planned</span>
      </p>
    </section>
  );
}
