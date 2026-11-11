// BSD-251: Gespräche aus Claude Code und Codex im Chat von Based – als eigene Gruppe unter den Chats, zum Lesen und
// Fortsetzen. Quelle ist der CLI-Verlauf des Servers (`/coding/history`); in der Desktop-App der lokale Server.
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { List, ListItem } from "@astryxdesign/core/List";
import { cliResumeCommand, codingErrorMessage, foldTranscript, type CliSession, type TranscriptItem } from "@based/brain";
import { useEffect, useState } from "react";
import { ChatMessages } from "../chat/ChatMessages.js";
import { relative } from "../shell/format.js";
import { codingModelFor, useCodingConnection, type CodingConnection } from "./connection.js";

const TOOL = { claude: "Claude Code", codex: "Codex" } as const;
const projectOf = (cwd: string) => cwd.split("/").filter(Boolean).pop() ?? "";
/** So viele zeigt die Liste; alle stehen unter Coding → CLI history. */
const SHOWN = 40;
const noop = () => {};

export const cliKey = (x: Pick<CliSession, "tool" | "id">) => `${x.tool}:${x.id}`;

/** Gruppe „Claude Code & Codex“ in der Chat-Liste. Ohne Verbindung: in der Desktop-App ein Knopf, sonst nichts. */
export function CliChatList({ current, onOpen }: { current: string | undefined; onOpen: (x: CliSession, c: CodingConnection) => void }) {
  const { connection, local, pending, turnOnLocal } = useCodingConnection();
  const [list, setList] = useState<CliSession[]>();
  const key = connection ? `${connection.url}\n${connection.token}` : "";
  useEffect(() => {
    if (!connection) { setList(undefined); return; }
    let alive = true;
    const load = () => {
      codingModelFor(connection).client.history(200).then((l) => { if (alive) setList(l); }, () => { if (alive) setList([]); });
    };
    load();
    // Neue Gespräche aus dem Terminal tauchen auf, sobald man zu Based zurückkommt.
    window.addEventListener("focus", load);
    // … und während Based offen ist alle 10 s (neue Gespräche, neue Titel, Reihenfolge)
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, 10_000);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("focus", load); };
  }, [key]);

  if (!connection) {
    if (local.status === "unavailable" || pending) return null;
    return (
      <div className="chat-cli-offer" data-testid="cli-chats-offer">
        <p className="t-desc">Your Claude Code and Codex conversations on this Mac can show up here.</p>
        <Button size="sm" variant="ghost" label={local.status === "starting" ? "Starting…" : "Show them"} isDisabled={local.status === "starting"} onClick={() => void turnOnLocal()} />
        {local.error ?? (local.node && !local.node.ok ? local.node.message : undefined) ? <p className="t-meta" role="status">{local.error ?? local.node?.message}</p> : null}
      </div>
    );
  }
  if (!list || list.length === 0) return null;
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div data-testid="cli-chats">
      <List density="compact" header={<span className="t-meta">Claude Code &amp; Codex</span>}>
        {sorted.slice(0, SHOWN).map((x) => (
          <ListItem
            key={cliKey(x)}
            label={x.title || "Untitled"}
            description={[TOOL[x.tool], relative(new Date(x.updatedAt)), projectOf(x.cwd)].filter(Boolean).join(" · ")}
            isSelected={current === cliKey(x)}
            onClick={() => onOpen(x, connection)}
          />
        ))}
      </List>
      {sorted.length > SHOWN ? <p className="t-meta chat-cli-more">{sorted.length - SHOWN} older ones are in <a href="#coding">Coding → CLI history</a>.</p> : null}
    </div>
  );
}

/** Ein CLI-Gespräch im Chat: Kopfzeile mit Herkunft und Fortsetzen, darunter das Transkript (nur lesen). */
export function CliChatView({ session, connection }: { session: CliSession; connection: CodingConnection }) {
  const [items, setItems] = useState<TranscriptItem[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const model = codingModelFor(connection);
  // Live: läuft das Gespräch im Terminal weiter, kommt jede neue Zeile sofort dazu (Long-Poll auf die Datei).
  const [live, setLive] = useState(false);
  useEffect(() => {
    const stop = new AbortController();
    setItems(undefined);
    setError(undefined);
    setLive(false);
    void (async () => {
      let size: number | undefined;
      try {
        const r = await model.client.historyTranscript(session.tool, session.id);
        if (stop.signal.aborted) return;
        setItems(foldTranscript(r.events).items);
        size = r.size;
      } catch (e) {
        if (!stop.signal.aborted) setError(codingErrorMessage(e));
        return;
      }
      if (size === undefined) return; // älterer Server ohne Live
      let quietSince = Date.now();
      while (!stop.signal.aborted) {
        try {
          const r = await model.client.watchTranscript(session.tool, session.id, size, 25_000, stop.signal);
          if (stop.signal.aborted) return;
          if (!r.unchanged) {
            setItems(foldTranscript(r.events).items);
            quietSince = Date.now();
          }
          size = r.size;
          // „Live“, solange in den letzten zwei Minuten geschrieben wurde
          setLive(Date.now() - quietSince < 120_000 && quietSince !== 0);
        } catch {
          if (stop.signal.aborted) return;
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
    })();
    return () => stop.abort();
  }, [model, session.tool, session.id]);

  const resume = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await model.start();
      const agent = model.getState().agents.find((a) => a.id === session.tool);
      if (!agent) { setError(`${TOOL[session.tool]} isn't set up as a coding agent here. Check Coding → Setup.`); return; }
      const created = await model.create({ agent: agent.id, cwd: session.cwd, resume: session.id });
      if (created) window.location.hash = "#coding";
      else setError(model.getState().error ?? "Couldn't continue this conversation.");
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cliResumeCommand(session));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(`Copy this into a terminal: ${cliResumeCommand(session)}`);
    }
  };

  return (
    <>
      <div className="chat-cli-bar" data-testid="cli-chat-bar">
        <span className="t-meta chat-cli-origin" title={session.cwd}>{[TOOL[session.tool], session.cwd, relative(new Date(session.updatedAt))].filter(Boolean).join(" · ")}</span>
        {live ? <span className="chat-cli-live t-meta" data-testid="cli-chat-live" role="status"><span className="chat-cli-live-dot" aria-hidden="true" />Live</span> : null}
        <span className="chat-cli-actions">
          <Button size="sm" variant="ghost" label={copied ? "Copied" : "Copy terminal command"} onClick={() => void copy()} />
          <Button size="sm" variant="primary" label={busy ? "Opening…" : "Continue in Based"} isDisabled={busy} onClick={() => void resume()} />
        </span>
      </div>
      <div className="chat-scroll" data-testid="cli-chat-messages">
        {error ? <p className="chat-error t-desc" role="alert">{error}</p> : null}
        {items ? (
          <ChatMessages items={items} running={false} approvals={[]} onAnswer={noop} onRetry={noop}
            empty={<EmptyState title="Nothing to show" description="This conversation has no messages Based can read." isCompact />} />
        ) : error ? null : <p className="t-meta" role="status">Loading…</p>}
      </div>
    </>
  );
}
