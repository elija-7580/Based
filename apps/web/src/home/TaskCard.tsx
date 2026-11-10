// BSD-197 (Mockup v10, TaskCardsV10): die Auftragskarte direkt über dem Composer. Zeigt live den Zustand aus dem
// Record (Received → Understanding → Rückfrage · Vorschlag → läuft → erledigt / beantwortet / Fallback). Skill-Chips
// und Redact-Platzhalter liefert der Kern noch nicht – sie erscheinen hier deshalb (noch) nicht.
import { Button } from "@astryxdesign/core/Button";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import type { TaskCardView } from "@based/brain/home";
import { Icon } from "../icons.js";

export interface TaskCardHandlers {
  onAnswer: (option: string) => void;
  onConfirm: () => void;
  onFile: () => void;
  onUndo: () => void;
  onRetry: () => void;
  onClose: () => void;
  onOpenPage: (id: string) => void;
  onSaveAsPage: () => void;
  onContinueInChat: () => void;
  onRaiseBudget: () => void;
  onSetUpModel: () => void;
  onOpenRun: (runID: string) => void;
  onOpenProject: (id: string) => void;
}

const WORKING = new Set(["understanding", "executing", "handedOff"]);

export function TaskCard({ card, projectName, ...h }: { card: TaskCardView; projectName: (id: string) => string | undefined } & TaskCardHandlers) {
  const p = card.phase;
  const closable = p === "done" || p === "answered" || p === "fallback" || p === "undone";
  return (
    <article className="task-cardx" data-testid="home-task-card" data-phase={p} data-task-id={card.id} data-working={WORKING.has(p) ? "" : undefined} aria-label="Task card" aria-live="polite">
      <header className="head">
        {WORKING.has(p) ? <span className="pulse" aria-hidden="true" /> : p === "question" || p === "proposal" ? <span className="dot pulse needs" aria-hidden="true" /> : null}
        <span className="grow" data-testid="home-task-head">{card.head}</span>
        {closable ? <button type="button" className="x-btn" aria-label="Put card away" onClick={h.onClose}><Icon name="close" size={16} /></button> : null}
      </header>
      <span className="input">{card.input}</span>
      <section className="phase" key={p} aria-label={p}>
        {p === "received" && card.waiting === "no model set up" ? (
          <span className="task-actions"><Button size="sm" variant="secondary" label="Set up a model" onClick={h.onSetUpModel} /></span>
        ) : null}

        {p === "understanding" || p === "executing" ? (
          <span aria-label="Understanding" role="status" style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <Skeleton height={10} width="72%" />
            <Skeleton height={10} width="46%" index={1} />
          </span>
        ) : null}

        {card.plan.length > 0 && (p === "proposal" || p === "executing" || p === "question") ? (
          <ul className="task-tiles" aria-label="Plan">
            {card.plan.map((a) => (
              <li key={a.id} className="task-tile" data-blocked={a.blocked ? "" : undefined}>
                {a.applied ? <Icon name="check" size={14} /> : null}
                {a.label}
                {a.needsOK && !a.applied ? <span className="t-meta">· needs OK</span> : null}
                {a.blocked ? <span className="t-meta">· blocked</span> : null}
              </li>
            ))}
          </ul>
        ) : null}

        {p === "question" && card.question ? (
          <>
            <strong>{card.question.text}</strong>
            <span className="task-actions">
              {card.question.options.map((o) => <Button key={o} size="sm" variant="secondary" label={o} onClick={() => h.onAnswer(o)} />)}
              <Button size="sm" variant="ghost" label="File as note" onClick={h.onFile} />
            </span>
          </>
        ) : null}

        {p === "proposal" ? (
          <>
            {card.reasons.length > 0 ? <ul className="task-reasons">{card.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
            <span className="task-actions">
              {card.canConfirm ? <Button size="sm" variant="primary" label="Go ahead" onClick={h.onConfirm} /> : null}
              {card.aboutBudget ? <Button size="sm" variant="secondary" label="Raise budget" onClick={h.onRaiseBudget} /> : null}
              <Button size="sm" variant="ghost" label="File as note" onClick={h.onFile} />
            </span>
          </>
        ) : null}

        {p === "answered" && card.answer !== undefined ? (
          <>
            <span className="task-answer-x" data-testid="home-task-answer">{card.answer}</span>
            <span className="task-actions">
              <Button size="sm" variant="secondary" label="Save as page" onClick={h.onSaveAsPage} />
              <Button size="sm" variant="ghost" label="Continue in chat" onClick={h.onContinueInChat} />
            </span>
          </>
        ) : null}

        {p === "done" || p === "undone" || p === "handedOff" ? (
          <>
            {card.result ? <span className="task-tile" style={{ alignSelf: "flex-start" }}>{p === "done" ? <Icon name="check" size={14} /> : null}<span data-testid="home-task-result">{card.result}</span></span> : null}
            <span className="task-actions">
              {p === "done" && card.pageID ? <Button size="sm" variant="secondary" label="Open page" onClick={() => h.onOpenPage(card.pageID!)} /> : null}
              {card.canUndo ? <Button size="sm" variant="ghost" label="Undo" onClick={h.onUndo} /> : null}
              {card.runID ? <Button size="sm" variant="secondary" label="Open agent" onClick={() => h.onOpenRun(card.runID!)} /> : null}
              {card.projectID && projectName(card.projectID) ? <Button size="sm" variant="ghost" label={`Open ${projectName(card.projectID)}`} onClick={() => h.onOpenProject(card.projectID!)} /> : null}
            </span>
          </>
        ) : null}

        {p === "fallback" ? (
          <>
            <span className="t-desc" data-testid="home-task-result">{card.result ?? card.error ?? "Something went wrong."}</span>
            <span className="task-actions"><Button size="sm" variant="secondary" label="Try again" onClick={h.onRetry} /></span>
          </>
        ) : null}
      </section>
    </article>
  );
}
