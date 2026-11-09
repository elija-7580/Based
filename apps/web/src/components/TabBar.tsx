// Tabs der Shell (wie Notion/Browser): erscheinen ab dem zweiten Tab über der Seite. Klick wechselt, Mittelklick
// oder × schließt, Ziehen sortiert um, + öffnet einen neuen Tab. Jeder Tab hat seinen eigenen Verlauf (router.ts).
import { useState, useSyncExternalStore, type DragEvent } from "react";
import { Icon } from "../icons.js";
import type { History, Route } from "../shell/router.js";

const DRAG_TYPE = "application/x-based-tab";

export function routeTitle(r: Route, titles: ReadonlyMap<string, string>): string {
  switch (r.name) {
    case "page": return titles.get(r.id) || "Untitled";
    case "home": return "Home";
    case "trash": return "Trash";
    case "settings": return "Settings";
    case "graph": return "Graph";
  }
}

export function TabBar({ history, titles }: { history: History; titles: ReadonlyMap<string, string> }) {
  const tabs = useSyncExternalStore(history.subscribe, () => history.tabs);
  const active = useSyncExternalStore(history.subscribe, () => history.activeID);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | undefined>();
  if (tabs.length < 2) return null;

  const onDragOver = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const box = e.currentTarget.getBoundingClientRect();
    const after = e.clientX > box.left + box.width / 2;
    if (drop?.id !== id || drop.after !== after) setDrop({ id, after });
  };
  const onDrop = (e: DragEvent<HTMLDivElement>, id: string) => {
    const dragged = e.dataTransfer.getData(DRAG_TYPE);
    setDrop(undefined);
    if (!dragged) return;
    e.preventDefault();
    const from = tabs.findIndex((t) => t.id === dragged);
    const box = e.currentTarget.getBoundingClientRect();
    const slot = tabs.findIndex((t) => t.id === id) + (e.clientX > box.left + box.width / 2 ? 1 : 0);
    history.move(dragged, slot > from ? slot - 1 : slot);
  };

  return (
    <div className="tabbar" role="tablist" aria-label="Tabs">
      {tabs.map((t) => {
        const title = routeTitle(t.route, titles);
        const selected = t.id === active;
        const mark = drop?.id === t.id ? (drop.after ? " drop-after" : " drop-before") : "";
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={selected}
            aria-label={title}
            tabIndex={selected ? 0 : -1}
            className={"tab" + (selected ? " active" : "") + mark}
            title={title}
            draggable
            data-tab-id={t.id}
            onClick={() => history.activate(t.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                history.activate(t.id);
              } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                history.cycle(e.key === "ArrowRight" ? 1 : -1);
                (e.currentTarget.parentElement?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'))?.focus();
              }
            }}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              history.close(t.id);
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, t.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => onDragOver(e, t.id)}
            onDragLeave={() => setDrop(undefined)}
            onDrop={(e) => onDrop(e, t.id)}
            onDragEnd={() => setDrop(undefined)}
          >
            <Icon name={t.route.name === "page" ? "page" : t.route.name === "trash" ? "trash" : t.route.name === "settings" ? "settings" : t.route.name === "graph" ? "graph" : "home"} size={14} />
            <span className="tab-title">{title}</span>
            <button
              type="button"
              className="tab-close"
              aria-label="Close tab"
              title="Close tab (⌘W)"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                history.close(t.id);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
      <button type="button" className="icon-btn ghost tab-new" aria-label="New tab" title="New tab (⌘T)" onClick={() => history.openTab()}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}
