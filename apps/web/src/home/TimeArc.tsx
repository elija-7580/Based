// BSD-162 (Mockup v10): der Zeitbogen. Feine Bogenlinie mit Zeitmarken, links erledigte Karten (grau, Häkchen),
// am Scheitel „now“ die Needs-you-Karte (dunkler Rahmen, Allow / Always / No), rechts geplante Läufe (gestrichelt),
// innerer Ring = läuft gerade (Marker-Strich, pulsierender Punkt, Fortschritt). Die Lage jeder Karte rechnen die
// reinen Funktionen aus @based/brain/home; hier wird nur gemessen und gezeichnet.
import { Button } from "@astryxdesign/core/Button";
import {
  arcGeometry, arcPath, arcTicks, duration, placeSide, ringLayout, timeToT, visibleTicks,
  type ArcCard, type Box, type Frame, type HomeModel, type NeedsYou, type RingCard,
} from "@based/brain/home";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons.js";
import { when } from "./hooks.js";

/** Kartengrößen in Pixeln (CSS übernimmt sie über style). */
export const SIZES = {
  done: { w: 236, h: 60 },
  planned: { w: 208, h: 40 },
  ring: { w: 200, h: 72 },
  apex: { w: 316, h: 124 },
} as const;

export interface ArcHandlers {
  onOpenRun: (runID: string) => void;
  onOpenPage: (pageID: string) => void;
  onOpenProject: (id: string) => void;
  onUndo: (taskID: string) => void;
  onApprove: (n: Extract<NeedsYou, { kind: "approval" }>, how: "allow" | "always" | "no") => void;
  onAnswer: (taskID: string, option: string) => void;
  onConfirm: (taskID: string) => void;
  onFile: (taskID: string) => void;
  onStopRun: (runID: string) => void;
}

interface Props extends ArcHandlers {
  model: HomeModel;
  frame: Frame;
  nowMs: number;
  showDetails: boolean;
  titleOf: (pageID: string) => string | undefined;
}

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

export function TimeArc({ model, frame, nowMs, showDetails, titleOf, ...h }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(320, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pixel → Einheiten (Bogen ist 1000 Einheiten breit)
  const k = 1000 / width;
  const u = (s: { w: number; h: number }) => ({ w: s.w * k, h: s.h * k });
  const layout = useMemo(() => {
    const g = arcGeometry(u(SIZES.done), u(SIZES.apex), u(SIZES.ring));
    const apexBox: Box | undefined = model.needsYou.length > 0 ? { x: g.cx, y: g.cy - g.r, ...u(SIZES.apex) } : undefined;
    const blocked: Box[] = apexBox ? [apexBox] : [];
    const ring = ringLayout(model.running.map((r) => r.id), g, u(SIZES.ring), blocked);
    const ringBoxes = ring.placed.map((p) => p.box);
    const minT = 0;
    const done = placeSide(model.done.map((c) => ({ id: c.id, t: timeToT(c.atMs, nowMs, frame) })), "done", g, u(SIZES.done), [...blocked, ...ringBoxes], { minT });
    // Beide Seiten treffen sich am Scheitel (gerade fertig / jetzt fällig): Geplantes weicht dem Erledigten aus.
    const planned = placeSide(model.planned.map((c) => ({ id: c.id, t: timeToT(c.atMs, nowMs, frame) })), "planned", g, u(SIZES.planned), [...blocked, ...ringBoxes, ...done.placed.map((p) => p.box)], { minT });
    const all = [...blocked, ...ringBoxes, ...done.placed.map((p) => p.box), ...planned.placed.map((p) => p.box)];
    const endOffset = u(SIZES.done).h / 2 + 14 * k;
    const ticks = visibleTicks(arcTicks(g, frame, endOffset), all, { w: 44 * k, h: 16 * k });
    // „Running“ am Fuß des inneren Rings, wenn dort keine Karte liegt.
    const ringFoot = { x: g.cx - g.innerR, y: g.cy + endOffset };
    const ringCaption = model.running.length > 0 && visibleTicks([{ t: -1, label: "Running", at: ringFoot, now: false }], all, { w: 64 * k, h: 16 * k }).length > 0 ? ringFoot : undefined;
    return { g, apexBox, ring, done, planned, ticks, endOffset, ringCaption };
  }, [model, frame, nowMs, width]);

  const { g } = layout;
  const pos = (b: Box) => ({ left: pct(b.x - b.w / 2, g.width), top: pct(b.y - b.h / 2, g.height) });
  const doneCards = new Map(model.done.map((c) => [c.id, c]));
  const plannedCards = new Map(model.planned.map((c) => [c.id, c]));
  const ringCards = new Map(model.running.map((c) => [c.id, c]));
  const earlier = model.earlier + layout.done.overflow.length;
  const later = model.later + layout.planned.overflow.length;
  const left = { x: g.cx - g.r, y: g.cy + layout.endOffset + 18 * k };
  const right = { x: g.cx + g.r, y: left.y };

  return (
    <section ref={ref} className="arc-stage" style={{ height: (g.height / g.width) * width }} aria-label="Time arc: finished work on the left, now on top, planned on the right, running agents on the inner ring" data-testid="time-arc" data-frame={frame}>
      <svg className="arc-svg" viewBox={`0 0 ${g.width} ${g.height}`} preserveAspectRatio="none" aria-hidden="true">
        <path className="arc-line" d={arcPath(g)} />
        <path className="arc-ring" d={arcPath(g, g.innerR)} />
      </svg>
      {layout.ticks.map((t) => (
        <span key={t.t} className="arc-tick" data-now={t.now ? "" : undefined} data-end={t.t === 0 ? "done" : t.t === 1 ? "planned" : undefined} style={{ left: pct(t.at.x, g.width), top: pct(t.at.y, g.height) }}>
          {/* Die Legende steht am Bogen selbst: links erledigt, rechts geplant. */}
          {t.t === 0 ? <span className="arc-caption">Done</span> : null}{t.label}{t.t === 1 ? <span className="arc-caption">Planned</span> : null}
        </span>
      ))}
      {layout.ringCaption ? <span className="arc-tick" data-end="running" style={{ left: pct(layout.ringCaption.x, g.width), top: pct(layout.ringCaption.y, g.height) }}><span className="arc-caption">Running</span></span> : null}
      {earlier > 0 ? <span className="arc-more" style={{ left: pct(left.x, g.width), top: pct(left.y, g.height) }}>{`+${earlier} earlier`}</span> : null}
      {later > 0 ? <span className="arc-more" style={{ left: pct(right.x, g.width), top: pct(right.y, g.height) }}>{`+${later} later`}</span> : null}

      {model.empty ? (
        <section className="arc-empty" style={{ top: pct(g.cy - g.innerR * 0.9, g.height) }} data-testid="home-empty" aria-label="Nothing here yet">
          <strong className="t-section">Nothing on the arc yet</strong>
          <p className="t-desc">Finished work lands on the left, what needs you sits on top, planned runs wait on the right — and agents at work circle on the inner ring.</p>
          <p className="t-desc">Try: “Buy milk tomorrow” · “Research note-taking apps” · “Remind me daily at 7:30 to stretch”</p>
        </section>
      ) : null}

      {layout.done.placed.map((p) => {
        const c = doneCards.get(p.id)!;
        if (c.kind === "group") return <GroupCard key={p.id} card={c} style={{ ...pos(p.box), width: SIZES.done.w, height: SIZES.done.h }} titleOf={titleOf} nowMs={nowMs} {...h} />;
        return <DoneCard key={p.id} card={c} style={{ ...pos(p.box), width: SIZES.done.w, height: SIZES.done.h }} titleOf={titleOf} nowMs={nowMs} {...h} />;
      })}
      {layout.planned.placed.map((p) => {
        const c = plannedCards.get(p.id)!;
        if (c.kind === "due") {
          return (
            <button type="button" key={p.id} className="arc-card" data-state="planned" data-kind="due" data-testid="arc-due" data-overdue={c.overdue ? "" : undefined}
              style={{ ...pos(p.box), width: SIZES.planned.w, height: SIZES.planned.h }} title={`${c.title} · ${c.detail ?? ""}`}
              aria-label={`${c.title}, due ${c.allDay ? "today" : when(c.atMs, nowMs)} in ${c.detail ?? "a database"} — open`} onClick={() => c.pageID && h.onOpenPage(c.pageID)}>
              <span className="arc-row"><span className="home-mono">{c.allDay ? "today" : c.overdue ? "due" : when(c.atMs, nowMs)}</span><span className="t1">{c.title}</span></span>
            </button>
          );
        }
        return (
          <article key={p.id} className="arc-card" data-state="planned" data-testid="arc-planned" data-task-id={c.taskID} style={{ ...pos(p.box), width: SIZES.planned.w, height: SIZES.planned.h }} title={c.detail}>
            <span className="arc-row"><span className="home-mono">{when(c.atMs, nowMs)}</span><span className="t1">{c.title}</span></span>
          </article>
        );
      })}
      {layout.ring.placed.map((p) => {
        const c = ringCards.get(p.id)!;
        return <RingCardView key={p.id} card={c} style={{ ...pos(p.box), width: SIZES.ring.w, height: SIZES.ring.h }} nowMs={nowMs} showDetails={showDetails} onOpen={() => h.onOpenRun(c.runID)} />;
      })}
      {layout.ring.overflow.length > 0 ? (
        <span className="arc-more" style={{ left: pct(g.cx, g.width), top: pct(g.cy - 6 * k, g.height) }}>{`+${layout.ring.overflow.length} more running`}</span>
      ) : null}
      {layout.apexBox ? <Apex items={model.needsYou} style={{ ...pos(layout.apexBox), width: SIZES.apex.w, height: SIZES.apex.h }} {...h} /> : null}
    </section>
  );
}

function DoneCard({ card: c, style, titleOf, nowMs, ...h }: { card: ArcCard; style: React.CSSProperties; titleOf: (id: string) => string | undefined; nowMs: number } & ArcHandlers) {
  const page = c.pageID && titleOf(c.pageID) !== undefined ? c.pageID : undefined;
  return (
    <article className="arc-card" data-state={c.state} data-testid="arc-done" data-task-id={c.taskID} data-run-id={c.runID} style={style}>
      <span className="arc-row">
        <span className="arc-check" aria-label={c.state === "done" ? "Done" : c.state === "filed" ? "Filed as note" : "Failed"}><Icon name={c.state === "done" ? "check" : c.state === "filed" ? "inbox" : "close"} size={14} /></span>
        <span className="t1" title={`${c.title} · ${when(c.atMs, nowMs)}`}>{c.title}</span>
      </span>
      <span className="arc-row">
        <span className="t2" title={c.detail}><span className="home-mono arc-time">{when(c.atMs, nowMs)}</span>{c.detail ?? ""}</span>
        <span className="arc-card-actions">
          {page ? <button type="button" className="arc-link" onClick={() => h.onOpenPage(page)}>Open page</button> : null}
          {c.runID ? <button type="button" className="arc-link" onClick={() => h.onOpenRun(c.runID!)}>Details</button> : null}
          {c.canUndo && c.taskID ? <button type="button" className="arc-link" onClick={() => h.onUndo(c.taskID!)}>Undo</button> : null}
        </span>
      </span>
    </article>
  );
}

/** BSD-278: Erledigtes eines Projekts gebündelt („Publit · 3 done“); klappt die einzelnen Karten darunter auf. */
function GroupCard({ card: c, style, titleOf, nowMs, ...h }: { card: ArcCard; style: React.CSSProperties; titleOf: (id: string) => string | undefined; nowMs: number } & ArcHandlers) {
  const [open, setOpen] = useState(false);
  const items = c.items ?? [];
  return (
    <article className="arc-card arc-group" data-state={c.state} data-testid="arc-group" data-open={open ? "" : undefined} style={style}>
      <span className="arc-row">
        <span className="arc-check" aria-hidden="true"><Icon name="check" size={14} /></span>
        <button type="button" className="t1 arc-group-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={c.title}>{c.title}</button>
      </span>
      <span className="arc-row">
        <span className="t2"><span className="home-mono arc-time">{when(c.atMs, nowMs)}</span>{c.detail ?? `${items.length} cards`}</span>
        <span className="arc-card-actions">
          {c.projectID ? <button type="button" className="arc-link" onClick={() => h.onOpenProject(c.projectID!)}>Project</button> : null}
        </span>
      </span>
      {open ? (
        <ul className="arc-group-list" aria-label={`${c.title}: finished cards`}>
          {items.map((x) => {
            const page = x.pageID && titleOf(x.pageID) !== undefined ? x.pageID : undefined;
            return (
              <li key={x.id} data-testid="arc-group-item" data-state={x.state}>
                <span className="home-mono arc-time">{when(x.atMs, nowMs)}</span>
                <span className="t1" title={x.detail}>{x.title}</span>
                {page ? <button type="button" className="arc-link" onClick={() => h.onOpenPage(page)}>Open</button> : null}
                {x.runID ? <button type="button" className="arc-link" onClick={() => h.onOpenRun(x.runID!)}>Details</button> : null}
                {x.canUndo && x.taskID ? <button type="button" className="arc-link" onClick={() => h.onUndo(x.taskID!)}>Undo</button> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}

const STATUS: Record<RingCard["status"], string> = { queued: "queued", running: "working", needsYou: "needs you", done: "done", failed: "failed", cancelled: "stopped" };

function RingCardView({ card: c, style, nowMs, showDetails, onOpen }: { card: RingCard; style: React.CSSProperties; nowMs: number; showDetails: boolean; onOpen: () => void }) {
  const label = c.kind === "main" ? "Main agent" : c.kind === "schedule" ? "Scheduled run" : "Agent";
  return (
    <button type="button" className="arc-card ring" data-testid="arc-running" data-run-id={c.runID} data-task-id={c.taskID} data-status={c.status} style={style} onClick={onOpen}
      aria-label={`${c.title}, ${label}, ${STATUS[c.status]} — open details`}>
      <span className="arc-row">
        <span className={c.status === "needsYou" ? "pulse needs" : "pulse"} aria-hidden="true" />
        <span className="t1">{c.title}</span>
      </span>
      <span className="arc-row">
        <span className="t2">{`${label} · ${STATUS[c.status]}`}</span>
        {showDetails ? <span className="home-mono" data-testid="arc-running-details">{`${c.model ?? "auto"} · ${duration(nowMs - c.startedMs)}`}</span> : null}
      </span>
      {c.share !== undefined ? (
        <span className="meter" role="img" aria-label={`${Math.round(c.share * 100)}% of its budget used`}><i style={{ width: `${Math.max(4, c.share * 100)}%` }} /></span>
      ) : null}
    </button>
  );
}

function Apex({ items, style, ...h }: { items: readonly NeedsYou[]; style: React.CSSProperties } & ArcHandlers) {
  const [index, setIndex] = useState(0);
  const i = index % items.length;
  const n = items[i]!;
  return (
    <section className="arc-apex" style={style} data-testid="needs-you" data-kinds={items.map((x) => x.kind).join(",")} aria-label="Needs you">
      <span className="head">
        <span className="dot" aria-hidden="true" />Needs you
        {items.length > 1 ? <button type="button" className="arc-link" onClick={() => setIndex(i + 1)} aria-label="Show the next thing that needs you">{`${i + 1} of ${items.length}`}</button> : null}
        {/* BSD-278: der Agent steht nicht mehr zusätzlich im Ring – sein Detail ist von hier erreichbar */}
        {n.kind === "approval" ? <button type="button" className="arc-link" onClick={() => h.onOpenRun(n.runID)} aria-label={`Details for ${n.title}`}>Details</button> : null}
      </span>
      {n.kind === "approval" ? (
        <>
          <span className="body"><strong>{n.title}</strong>{` wants to use ${n.tool.replace(/_/g, " ")}.`}</span>
          <span className="buttons">
            <Button size="sm" variant="primary" label="Allow" onClick={() => h.onApprove(n, "allow")} />
            <Button size="sm" variant="secondary" label="Always" onClick={() => h.onApprove(n, "always")} />
            <Button size="sm" variant="ghost" label="No" onClick={() => h.onApprove(n, "no")} />
          </span>
        </>
      ) : n.kind === "task" ? (
        <>
          <span className="body">{n.card.question ? <><strong>{n.card.question.text}</strong>{` — ${n.card.input}`}</> : <><strong>Go ahead?</strong>{` ${n.card.plan.map((a) => a.label).join(" · ")}`}</>}</span>
          <span className="buttons">
            {n.card.question
              ? n.card.question.options.slice(0, 3).map((o) => <Button key={o} size="sm" variant="secondary" label={o} onClick={() => h.onAnswer(n.taskID, o)} />)
              : <>
                  {n.card.canConfirm ? <Button size="sm" variant="primary" label="Go ahead" onClick={() => h.onConfirm(n.taskID)} /> : null}
                  <Button size="sm" variant="ghost" label="File as note" onClick={() => h.onFile(n.taskID)} />
                </>}
          </span>
        </>
      ) : (
        <>
          <span className="body"><strong>{n.title}</strong> was waiting for an approval when Based reloaded.</span>
          <span className="buttons">
            <Button size="sm" variant="secondary" label="Open" onClick={() => h.onOpenRun(n.runID)} />
            <Button size="sm" variant="ghost" label="Stop" onClick={() => h.onStopRun(n.runID)} />
          </span>
        </>
      )}
    </section>
  );
}
