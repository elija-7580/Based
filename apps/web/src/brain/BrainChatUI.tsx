// Oberfläche des Agent Brain im Chat: Skill-Chips über dem Eingabefeld (BSD-198), Hinweis auf sensible Stellen und
// „n details redacted“ (BSD-199), Memory-Vorschläge und Zitate mit Sprung zum Block (BSD-163).
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Token } from "@astryxdesign/core/Token";
import { citationTarget, memorySuggestionsOf, REDACT_KIND_LABELS, renderCitations, type PendingMemory, type RedactKind, type StoredChatEvent } from "@based/brain";
import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "../icons.js";
import { jumpToBlock } from "./jump.js";
import type { BrainChat, RedactionEvent, SkillsEvent } from "./runtime.js";
import "./brain.css";

export const BrainChatContext = createContext<BrainChat | undefined>(undefined);

// MARK: Composer

export function BrainComposerBar({ brain }: { brain: BrainChat }) {
  const s = useSyncExternalStore(brain.subscribe, brain.getState);
  const settings = useSyncExternalStore(brain.settings.subscribe, brain.settings.getState);
  const alts = brain.alternatives();
  const showSkills = settings.skills.auto && (s.chips.length > 0 || (s.routing?.candidates.length ?? 0) > 0);
  const sensitive = s.sensitive.length;
  if (!showSkills && sensitive === 0) return null;
  const willRedact = settings.redact.enabled || s.redactOnce;
  return (
    <div className="brain-bar" data-testid="brain-bar">
      {showSkills ? (
        <div className="brain-chips" role="group" aria-label="Skills for this message" data-testid="skill-chips">
          <span className="t-meta">Skills</span>
          {s.chips.map((c) => (
            <span key={c.id} className="brain-chip" data-testid="skill-chip" data-skill={c.name} title={c.description}>
              <DropdownMenu
                hasChevron={false}
                menuWidth={260}
                renderTrigger={(p) => (
                  <button type="button" className="brain-chip-label" aria-label={`Swap skill ${c.name}`} {...p}>
                    {c.name}
                    <Icon name="chevron" size={12} />
                  </button>
                )}
                items={alts.length > 0
                  ? alts.map((a) => ({ id: a.id, label: a.name, description: a.description, onClick: () => brain.swapChip(c.id, a) }))
                  : [{ label: "No other matching skills", isDisabled: true }]}
              />
              <button type="button" className="brain-chip-remove" aria-label={`Remove skill ${c.name}`} onClick={() => brain.removeChip(c.id)}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
          {alts.length > 0 ? (
            <DropdownMenu
              hasChevron={false}
              menuWidth={260}
              renderTrigger={(p) => (
                <button type="button" className="brain-chip-add" aria-label="Add a skill" {...p}>
                  <Icon name="plus" size={12} />
                  {s.chips.length === 0 ? <span>Add skill</span> : null}
                </button>
              )}
              items={alts.map((a) => ({ id: a.id, label: a.name, description: a.description, onClick: () => brain.swapChip(undefined, a) }))}
            />
          ) : null}
        </div>
      ) : null}
      {sensitive > 0 ? (
        <div className="brain-sensitive" data-testid="sensitive-hint">
          <Icon name="lock" size={14} />
          <span className="t-desc">
            {willRedact
              ? `${sensitive} sensitive detail${sensitive === 1 ? "" : "s"} will be redacted before sending.`
              : `${sensitive} sensitive detail${sensitive === 1 ? "" : "s"} in this message.`}
          </span>
          {!settings.redact.enabled ? (
            <Button size="sm" variant={s.redactOnce ? "ghost" : "secondary"} label={s.redactOnce ? "Don't redact" : "Redact sensitive details"} onClick={() => brain.setRedactOnce(!s.redactOnce)} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// MARK: Ergänzungen je Turn

/** Brain-Ereignisse je Nutzer-Nachricht (1, 2, …): Skills, Redaction, Memory-Vorschläge. */
export function brainEventsByTurn(events: readonly StoredChatEvent[]): Map<number, StoredChatEvent[]> {
  const out = new Map<number, StoredChatEvent[]>();
  let n = 0;
  for (const e of events) {
    if (e.type === "userMessage") n += 1;
    else if (e.type === "skills" || e.type === "redaction" || e.type === "memorySuggestion" || e.type === "memoryDecision") {
      const list = out.get(n) ?? [];
      list.push(e);
      out.set(n, list);
    }
  }
  return out;
}

export function TurnBrainExtras({ events, brain }: { events: readonly StoredChatEvent[]; brain: BrainChat }) {
  const skills = events.filter((e): e is SkillsEvent => e.type === "skills").flatMap((e) => e.skills);
  const redaction = events.find((e): e is RedactionEvent => e.type === "redaction");
  const memories = memorySuggestionsOf(events);
  if (skills.length === 0 && !redaction && memories.length === 0) return null;
  return (
    <div className="brain-turn">
      {skills.length > 0 || redaction ? (
        <div className="brain-turn-chips">
          {skills.map((k) => <Token key={k.id} size="sm" label={k.name} description={k.description} icon={<Icon name="research" size={12} />} />)}
          {redaction ? <RedactionChip ev={redaction} /> : null}
        </div>
      ) : null}
      {memories.map((m) => <MemoryCard key={m.id} m={m} brain={brain} />)}
    </div>
  );
}

function RedactionChip({ ev }: { ev: RedactionEvent }) {
  const [open, setOpen] = useState(false);
  const kinds = Object.entries(ev.kinds).map(([k, n]) => `${n} × ${REDACT_KIND_LABELS[k as RedactKind] ?? k}`).join(", ");
  return (
    <span className="brain-redacted" data-testid="redaction-chip">
      <button type="button" className="brain-chip-label" aria-expanded={open} onClick={() => setOpen(!open)} title="The model only saw placeholders for these details">
        <Icon name="lock" size={12} />
        {ev.count} detail{ev.count === 1 ? "" : "s"} redacted
      </button>
      {open ? <span className="t-meta">{kinds}. The provider saw placeholders; Based put the real values back.</span> : null}
    </span>
  );
}

function MemoryCard({ m, brain }: { m: PendingMemory; brain: BrainChat }) {
  const [busy, setBusy] = useState(false);
  const s = m.suggestion;
  const title = (s.updates ? "Update memory: " : "Remember: ") + s.title;
  if (m.state !== "pending") {
    return <p className="t-meta brain-memory-done" data-testid="memory-decided">{m.state === "saved" ? `Saved to memories: ${s.title}` : `Not saved: ${s.title}`}</p>;
  }
  return (
    <div data-testid="memory-suggestion">
      <Banner
        status={s.sensitive ? "warning" : "info"}
        title={title}
        description={(s.sensitive ? "Sensitive — saved only if you confirm. " : "") + s.body}
        collapsible={false}
        endContent={
          <span className="brain-memory-actions">
            <Button size="sm" variant="primary" label="Save" isDisabled={busy} onClick={() => { setBusy(true); void brain.saveMemory(m).finally(() => setBusy(false)); }} />
            <Button size="sm" variant="ghost" label="Dismiss" isDisabled={busy} onClick={() => { setBusy(true); void brain.dismissMemory(m).finally(() => setBusy(false)); }} />
          </span>
        }
      />
    </div>
  );
}

// MARK: Zitate

/** Text einer Antwort mit nummerierten Quellen (Marker → Links); löst unbekannte Marker im Hintergrund auf. */
export function useCitedText(text: string, streaming: boolean): string {
  const brain = useContext(BrainChatContext);
  const st = useSyncExternalStore(brain?.subscribe ?? noopSubscribe, brain?.getState ?? noState);
  return useMemo(() => {
    if (!brain || !text.includes("[[")) return text;
    brain.resolveCitations([text]);
    return renderCitations(text, (kind, id) => st?.citations.get(`${kind}:${id}`) ?? undefined, { streaming }).markdown;
  }, [brain, st?.citations, text, streaming]);
}

const noopSubscribe = () => () => undefined;
const noState = () => undefined;

/** Link-Baustein für Markdown: Quellen springen zur Seite und zum Block. */
export function CitationLink({ href, children }: { href: string; children: ReactNode }) {
  const t = citationTarget(href);
  if (!t) return null;
  const sup = typeof children === "string" ? /^[⁰¹²³⁴⁵⁶⁷⁸⁹]+$/.test(children) : Array.isArray(children) && children.length === 1 && typeof children[0] === "string" && /^[⁰¹²³⁴⁵⁶⁷⁸⁹]+$/.test(children[0]);
  return (
    <a
      href={"#page-" + t.pageID}
      className={sup ? "brain-cite" : "brain-source"}
      data-testid={sup ? "citation" : "citation-source"}
      onClick={(e) => {
        e.preventDefault();
        jumpToBlock(t.pageID, t.blockID);
      }}
    >
      {children}
    </a>
  );
}
