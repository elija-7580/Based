// BSD-159: der Chat – im rechten Panel (⌘J) und als Vollseite. Kopf mit Verlauf, neuem Chat, Einstellungen und
// Größe; darunter Verlauf, Einstellungen oder Gespräch; unten Warteschlange und Composer (Agent · Compute ·
// Permission). Zustand: ChatController (eins für Panel und Vollseite).
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Layout";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import type { ChatInfo, PermissionMode } from "@based/brain";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Composer, type ComposerOption } from "../components/Composer.js";
import { Icon } from "../icons.js";
import { relative } from "../shell/format.js";
import { AiSettingsSection, PERMISSIONS } from "./AiSettingsSection.js";
import { aiConfig, type AiConfig } from "./aiConfig.js";
import { BrainChatContext, BrainComposerBar, brainEventsByTurn, CitationLink, TurnBrainExtras, useCitedText } from "../brain/BrainChatUI.js";
import { brainChatOf } from "../brain/setup.js";
import { AnswerHooksContext, ChatMessages, usageLine, type AnswerHooks } from "./ChatMessages.js";
import { transcriptOf, type ChatController } from "./controller.js";
import "./chat.css";

/** Swift-Datum (Sekunden seit 2001) → ms seit 1970. */
const fromSwift = (t: number) => (t + 978_307_200) * 1000;

export type ChatPane = "chat" | "history" | "settings";

/** BSD-77: alte Chats der Mac-App (Datenbank „Sessions“) übernehmen – die alten Seiten bleiben unverändert. */
function ImportOldChats({ onImport }: { onImport: () => Promise<number> }) {
  const [done, setDone] = useState<string | undefined>();
  return (
    <div className="chat-import">
      <Button size="sm" variant="ghost" label="Import chats from the Mac app" clickAction={async () => {
        const n = await onImport();
        setDone(n === 0 ? "No old chats found." : `Imported ${n} chat${n === 1 ? "" : "s"}.`);
      }} />
      {done ? <span className="t-meta" role="status">{done}</span> : null}
    </div>
  );
}

export function ChatHistoryList({ chats, current, onOpen, onDelete, onImport }: { chats: readonly ChatInfo[]; current: string | undefined; onOpen: (id: string) => void; onDelete: (id: string) => void; onImport?: () => Promise<number> }) {
  const importer = onImport ? <ImportOldChats onImport={onImport} /> : null;
  if (chats.length === 0) return <><p className="t-desc chat-history-empty">No chats yet.</p>{importer}</>;
  return (
    <>
    <List density="compact" header={<span className="t-meta">Chats</span>}>
      {chats.map((c) => (
        <ListItem
          key={c.id}
          label={c.title || "New chat"}
          description={[relative(new Date(fromSwift(c.updatedAt))), usageLine(c.usage)].filter(Boolean).join(" · ")}
          isSelected={c.id === current}
          onClick={() => onOpen(c.id)}
          endContent={<IconButton size="sm" variant="ghost" label={`Delete ${c.title || "chat"}`} icon={<Icon name="trash" size={16} />} onClick={(e) => { e.stopPropagation(); onDelete(c.id); }} />}
        />
      ))}
    </List>
    {importer}
    </>
  );
}

export interface ChatViewProps {
  controller: ChatController;
  /** Alte Transkripte übernehmen; gibt die Zahl neuer Chats zurück. */
  onImport?: () => Promise<number>;
  chats: readonly ChatInfo[];
  mode: "panel" | "page";
  onClose?: () => void;
  onToggleMode?: () => void;
  config?: AiConfig;
}

export function ChatView({ controller, chats, mode, onClose, onToggleMode, onImport, config = aiConfig() }: ChatViewProps) {
  const s = useSyncExternalStore(controller.subscribe, controller.getState);
  const ai = useSyncExternalStore(config.subscribe, config.getState);
  const [pane, setPane] = useState<ChatPane>("chat");
  const t = useMemo(() => transcriptOf(s.events), [s.events]);
  const info = chats.find((c) => c.id === s.chatID);
  const title = info?.title || (t.items[0]?.kind === "user" ? t.items[0].text : "") || "New chat";
  const total = usageLine(t.usage);
  const brain = brainChatOf(controller);
  const brainEvents = useMemo(() => brainEventsByTurn(s.events), [s.events]);
  const answerHooks = useMemo<AnswerHooks>(() => (brain ? {
    useText: useCitedText,
    Link: CitationLink,
    turnExtras: (n) => {
      const ev = brainEvents.get(n);
      return ev ? <TurnBrainExtras events={ev} brain={brain} /> : null;
    },
  } : { useText: (x: string) => x }), [brain, brainEvents]);

  useEffect(() => {
    if (!ai.loaded) void config.load();
  }, [ai.loaded, config]);

  const models = config.models().filter((m) => m.usable);
  const active = config.activeModel();
  const computeOptions: ComposerOption[] = models.map((m) => ({ name: m.ref, desc: m.kind === "ollama" ? "On this computer" : "Your API key", icon: m.kind === "ollama" ? "fast" : "model" }));
  const permissionOptions: ComposerOption[] = PERMISSIONS.map((p) => ({ name: p.name, desc: p.desc, icon: p.mode === "free" ? "free" : p.mode === "ask" || p.mode === "plan" ? "ask" : "perm" }));
  const permissionName = PERMISSIONS.find((p) => p.mode === ai.settings.permission)?.name ?? "Ask before edits";

  const empty = s.ready ? (
    <EmptyState title="Ask Based" description="Ask about your notes, or tell Based what to write. It can search, read and change pages and databases." isCompact />
  ) : (
    <EmptyState
      title="No model set up"
      description="Add an API key or a local model to start chatting. Nothing is sent anywhere until you do."
      isCompact
      actions={<Button variant="primary" label="Set up a model" onClick={() => setPane("settings")} />}
    />
  );

  const showSettings = pane === "settings";
  return (
    <BrainChatContext.Provider value={brain}>
    <AnswerHooksContext.Provider value={answerHooks}>
    <section className={`chat-view chat-${mode}`} aria-label="Chat with Based" data-testid={mode === "panel" ? "chat-panel" : "chat-page"}>
      <header className="chat-head">
        <span className="chat-title t-section" title={title}>{showSettings ? "Chat settings" : pane === "history" && mode === "panel" ? "Chats" : title}</span>
        <span className="chat-head-actions">
          {mode === "panel" ? (
            <IconButton size="sm" variant="ghost" label="Chats" icon={<Icon name="history" size={18} />} onClick={() => setPane(pane === "history" ? "chat" : "history")} />
          ) : null}
          <IconButton size="sm" variant="ghost" label="New chat" icon={<Icon name="plus" size={18} />} onClick={() => { controller.newChat(); setPane("chat"); }} />
          <IconButton size="sm" variant="ghost" label="Chat settings" icon={<Icon name="settings" size={18} />} onClick={() => setPane(showSettings ? "chat" : "settings")} />
          {onToggleMode ? (
            <IconButton size="sm" variant="ghost" label={mode === "panel" ? "Open as page" : "Open as side panel"} icon={<Icon name={mode === "panel" ? "expand" : "collapse"} size={18} />} onClick={onToggleMode} />
          ) : null}
          {onClose ? <IconButton size="sm" variant="ghost" label="Close chat" icon={<Icon name="close" size={18} />} onClick={onClose} /> : null}
        </span>
      </header>
      <div className="chat-body">
        {mode === "page" && !showSettings ? (
          <aside className="chat-side" aria-label="Chats">
            <ChatHistoryList chats={chats} current={s.chatID} onOpen={(id) => void controller.open(id)} onDelete={(id) => void controller.remove(id)} {...(onImport ? { onImport } : {})} />
          </aside>
        ) : null}
        <div className="chat-main">
          {showSettings ? (
            <div className="chat-scroll"><AiSettingsSection config={config} compact={mode === "panel"} /></div>
          ) : pane === "history" && mode === "panel" ? (
            <div className="chat-scroll">
              <ChatHistoryList chats={chats} current={s.chatID} onOpen={(id) => { void controller.open(id); setPane("chat"); }} onDelete={(id) => void controller.remove(id)} {...(onImport ? { onImport } : {})} />
            </div>
          ) : (
            <>
              <div className="chat-scroll" data-testid="chat-messages">
                {s.error ? <p className="chat-error t-desc" role="alert">{s.error}</p> : null}
                {s.loading ? <p className="t-meta" role="status">Loading…</p> : (
                  <ChatMessages items={t.items} running={s.running} approvals={s.approvals} onAnswer={(id, ok) => controller.answer(id, ok)} onRetry={() => controller.retry()} empty={empty} />
                )}
              </div>
              {s.waiting.length > 0 ? (
                <ul className="chat-queue" aria-label="Waiting messages" data-testid="chat-queue">
                  {s.waiting.map((w) => (
                    <li key={w.id} className="chat-queued">
                      <span className="t-meta">Waiting</span>
                      <span className="chat-queued-text">{w.text}</span>
                      <Button size="sm" variant="ghost" label="Send now" onClick={() => controller.sendNow(w.id)} />
                      <IconButton size="sm" variant="ghost" label="Remove waiting message" icon={<Icon name="close" size={14} />} onClick={() => controller.removeQueued(w.id)} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {s.plan && s.plan.chatID === s.chatID && !s.running ? (
                // BSD-245: Plan-Modus – gesammelte Schritte erst nach „Run plan“ ausführen.
                <Banner
                  status="info"
                  data-testid="chat-plan"
                  title={`Plan ready: ${s.plan.steps.length} ${s.plan.steps.length === 1 ? "change" : "changes"}`}
                  description={s.plan.steps.map((x, i) => `${i + 1}. ${x.name.replace(/_/g, " ")}`).join(" · ")}
                  endContent={
                    <HStack gap={2}>
                      <Button size="sm" variant="primary" label="Run plan" onClick={() => void controller.runPlan()} />
                      <Button size="sm" variant="ghost" label="Dismiss" onClick={() => controller.dismissPlan()} />
                    </HStack>
                  }
                />
              ) : null}
              {brain ? <BrainComposerBar brain={brain} /> : null}
              <div className="chat-composer">
                <Composer
                  onDraftChange={brain ? (text) => brain.setDraft(text) : undefined}
                  showDetails={mode === "page" || !!total}
                  inputID={`chat-input-${mode}`}
                  autoFocus
                  placeholder={s.running ? "Queue a message for when Based is done" : "Ask your notes, or tell Based what to do"}
                  onSubmit={(text) => {
                    brain?.captureSend(text);
                    void controller.send(text);
                  }}
                  busy={s.running}
                  onStop={() => controller.stop()}
                  disabled={!s.ready}
                  hide={["agent"]}
                  options={{ compute: computeOptions.length > 0 ? computeOptions : [{ name: "Set up a model…", desc: "Add a key or a local model", icon: "pick" }], permission: permissionOptions }}
                  foot={{ compute: "Models come from your providers in chat settings.", permission: "Every change by Based is one undo step." }}
                  picked={{ compute: active?.ref ?? (s.ready ? "Scripted" : "No model"), permission: permissionName }}
                  onPick={(key, name) => {
                    if (key === "compute") {
                      if (models.some((m) => m.ref === name)) config.setModel(name);
                      else setPane("settings");
                    } else if (key === "permission") {
                      const p = PERMISSIONS.find((x) => x.name === name);
                      if (p) config.setPermission(p.mode as PermissionMode);
                    }
                  }}
                  details={total ? <span data-testid={mode === "panel" ? "chat-usage" : undefined} title="Tokens and estimated cost of this chat">{total}</span> : s.ready ? "" : "no model set up"}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
    </AnswerHooksContext.Provider>
    </BrainChatContext.Provider>
  );
}
