// BSD-281: Reiter „Meetings“ der Library – alle Meeting-Notizen (Meeting-Blöcke) mit Seite, Datum, Dauer und Zustand,
// neueste zuerst. Ein Klick öffnet die Seite; „New meeting“ legt wie ⌘N → Meeting notes eine neue an.
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { List, ListItem } from "@astryxdesign/core/List";
import { useEffect, useState } from "react";
import { LibraryTabs } from "../components/LibraryTabs.js";
import { Icon } from "../icons.js";
import type { ShellState, StoreClient } from "../worker/client.js";
import type { MeetingListItem } from "../worker/protocol.js";
import "./library.css";

interface Props {
  client: StoreClient;
  state: ShellState;
  onOpenPage: (id: string) => void;
  onSwitch: (to: "library" | "graph" | "meetings") => void;
  onNewMeeting: () => void;
}

const STATUS: Record<string, string> = { ready: "Not recorded", recording: "Recording", paused: "Paused", processing: "Processing", done: "Recorded", failed: "Failed" };

function minutes(sec: number): string {
  const m = Math.round(sec / 60);
  return m < 1 ? "< 1 min" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function Meetings({ client, state, onOpenPage, onSwitch, onNewMeeting }: Props) {
  const [items, setItems] = useState<MeetingListItem[] | undefined>();
  useEffect(() => {
    if (!state.ready) return;
    let live = true;
    client.meetings().then((m) => { if (live) setItems(m); }, () => { if (live) setItems([]); });
    return () => { live = false; };
  }, [client, state.ready, state.titles, state.outline]);

  return (
    <div className="lib" data-testid="meetings" data-loaded={items ? "" : undefined}>
      <header className="lib-head">
        <LibraryTabs value="meetings" onNavigate={onSwitch} />
        <h1 className="t-title">Meetings</h1>
        <p className="t-desc" role="status" aria-live="polite">{items === undefined ? "Loading…" : `${items.length} ${items.length === 1 ? "meeting" : "meetings"}`}</p>
        <span className="grow" />
        <Button size="sm" variant="secondary" label="New meeting" onClick={onNewMeeting} />
      </header>
      {items && items.length === 0 ? (
        <EmptyState title="No meeting notes yet" description="Start one with ⌘N → Meeting notes or /meet on any page. Recordings, notes and summaries show up here." />
      ) : (
        <List density="compact" hasDividers edge="flush" header={<span className="sr-only">All meeting notes</span>}>
          {(items ?? []).map((m) => (
            <ListItem key={m.meetingID} label={m.title} onClick={() => onOpenPage(m.pageID)}
              description={`${m.pageTitle} · ${new Date(m.atMs).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${m.duration ? ` · ${minutes(m.duration)}` : ""}`}
              startContent={<Icon name="mic" size={16} />} endContent={<span className="t-meta">{STATUS[m.status] ?? m.status}</span>} />
          ))}
        </List>
      )}
    </div>
  );
}
