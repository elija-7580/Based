// BSD-159: ⌘J öffnet den Chat als rechtes Panel (Breite ziehbar, gemerkt) bzw. schließt es; „Open as page“ zeigt
// ihn als Vollseite (Route #chat). Die Chat-Liste hält der Store-Worker aktuell (`chats`-Ereignis).
import type { ChatInfo } from "@based/brain";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { History, Route } from "../shell/router.js";
import type { StoreClient } from "../worker/client.js";
import { chatController, onOpenChatPanel, openChatPanel, restoreLastChat } from "./runtime.js";
// BSD-280: die Chat-Ansicht (Markdown, Code) erst laden, wenn der Chat aufgeht – nicht im Start-Bundle.
const ChatView = lazy(() => import("./ChatView.js").then((m) => ({ default: m.ChatView })));

const WIDTH_KEY = "based.chatWidth";
const OPEN_KEY = "based.chatOpen";
const MIN = 320;
const MAX = 900;

function readNumber(key: string, fallback: number): number {
  try {
    const n = Number(globalThis.localStorage?.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, v: string) {
  try {
    globalThis.localStorage?.setItem(key, v);
  } catch {
    // nur für diese Sitzung
  }
}


function useChats(client: StoreClient): readonly ChatInfo[] {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  useEffect(() => {
    if (state.ready && !state.chats) {
      void client.chatList().catch(() => undefined);
      restoreLastChat(chatController(client));
    }
  }, [client, state.ready, state.chats]);
  return state.chats ?? [];
}

export function ChatDock({ client, history, route }: { client: StoreClient; history: History; route: Route }) {
  const controller = chatController(client);
  const chats = useChats(client);
  const [open, setOpen] = useState(() => readNumber(OPEN_KEY, 0) === 1);
  const [width, setWidth] = useState(() => Math.min(MAX, Math.max(MIN, readNumber(WIDTH_KEY, 420))));
  const onPage = route.name === "chat";

  const setOpenSaved = useCallback((v: boolean) => {
    setOpen(v);
    write(OPEN_KEY, v ? "1" : "0");
  }, []);

  useEffect(() => onOpenChatPanel(setOpenSaved), [setOpenSaved]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        if (onPage) history.back();
        else setOpenSaved(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onPage, history, setOpenSaved]);

  // Breite ziehen (Zeiger) oder mit den Pfeiltasten am Griff ändern.
  const drag = useRef<{ x: number; w: number } | undefined>(undefined);
  const resize = (w: number) => {
    const v = Math.round(Math.min(MAX, Math.max(MIN, w)));
    setWidth(v);
    write(WIDTH_KEY, String(v));
  };

  if (onPage || !open) return null;
  return (
    <aside className="chat-dock" style={{ width }} data-testid="chat-dock">
      <div
        className="chat-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, w: width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) resize(drag.current.w + drag.current.x - e.clientX);
        }}
        onPointerUp={() => { drag.current = undefined; }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") resize(width + 24);
          else if (e.key === "ArrowRight") resize(width - 24);
        }}
      />
      <Suspense fallback={<div className="screen-loading" role="status" aria-label="Loading chat" />}>
        <ChatView controller={controller} chats={chats} onImport={() => client.chatImportLegacy().then((r) => r.length)} mode="panel" onClose={() => setOpenSaved(false)} onToggleMode={() => { setOpenSaved(false); history.navigate({ name: "chat" }); }} />
      </Suspense>
    </aside>
  );
}

/** Vollseiten-Chat (Route #chat). */
export function ChatPage({ client, history }: { client: StoreClient; history: History }) {
  const controller = chatController(client);
  const chats = useChats(client);
  return (
    <Suspense fallback={<div className="screen-loading" role="status" aria-label="Loading chat" />}>
      <ChatView controller={controller} chats={chats} onImport={() => client.chatImportLegacy().then((r) => r.length)} mode="page" onToggleMode={() => { openChatPanel(); history.back(); }} />
    </Suspense>
  );
}
