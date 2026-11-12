// BSD-313: Eingabe der Coding-Konsole wie in Claude Code: „/“ öffnet die Slash-Befehle des Agenten, „@“ sucht
// Dateien im Arbeitsordner (Auswahl wird ein Chip und geht als resource_link mit), ⇧Tab schaltet durch die Modi des
// Agenten. Menüs: Pfeile wählen, Enter/Tab übernimmt, Esc schließt. ⌘Enter sendet.
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Kbd } from "@astryxdesign/core/Kbd";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Token } from "@astryxdesign/core/Token";
import type { CodingSessionView, FileMatch } from "@based/brain";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { atQuery, filterCommands, nextMode, removeAt, slashQuery } from "./composer.js";
import type { CodingModel } from "./model.js";

type Menu =
  | { kind: "slash"; items: { name: string; description: string; hint?: string }[] }
  | { kind: "file"; items: FileMatch[]; at: { start: number; query: string } };

export function Composer({ model, session }: { model: CodingModel; session: CodingSessionView }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [caret, setCaret] = useState(0);
  const [menu, setMenu] = useState<Menu>();
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const ref = useRef<HTMLTextAreaElement>(null);
  const search = useRef<AbortController>(undefined);
  const running = session.state === "running";
  const commands = session.commands ?? [];
  const modes = session.modes ?? [];
  const modeName = modes.find((m) => m.id === session.agentMode)?.name ?? session.agentMode;

  // Menü aus Text und Cursor ableiten (Dateisuche verzögert und abbrechbar).
  useEffect(() => {
    search.current?.abort();
    if (dismissed === text) { setMenu(undefined); return; }
    const slash = slashQuery(text);
    if (slash !== undefined) {
      const items = filterCommands(commands, slash);
      setMenu(items.length > 0 ? { kind: "slash", items } : undefined);
      setActive(0);
      return;
    }
    // Cursor aus dem Feld selbst (WebKit meldet ihn im change-Ereignis nicht immer schon richtig).
    const el = ref.current;
    const pos = el && el.value === text ? el.selectionStart ?? text.length : Math.min(caret, text.length);
    const at = atQuery(text, pos);
    if (!at) { setMenu(undefined); return; }
    const ctl = new AbortController();
    search.current = ctl;
    const t = setTimeout(() => {
      void model.searchFiles(at.query, ctl.signal).then((items) => {
        if (ctl.signal.aborted) return;
        setMenu(items.length > 0 ? { kind: "file", items, at } : undefined);
        setActive(0);
      });
    }, 80);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [text, caret, commands, dismissed, model]);

  // Cursor nach einer Auswahl setzen, sobald der neue Text im Feld steht (nicht per requestAnimationFrame: WebKit
  // ruft das ohne Neuzeichnen spät auf und setzte den Cursor dann mitten in später Getipptes).
  const pendingCaret = useRef<number>(undefined);
  useLayoutEffect(() => {
    const el = ref.current, pos = pendingCaret.current;
    if (!el || pos === undefined) return;
    pendingCaret.current = undefined;
    el.focus();
    el.setSelectionRange(pos, pos);
    setCaret(pos);
  }, [text]);
  const place = (pos: number) => { pendingCaret.current = pos; };

  const choose = (i: number) => {
    if (!menu) return;
    if (menu.kind === "slash") {
      const c = menu.items[i];
      if (!c) return;
      const next = `/${c.name} `;
      setText(next);
      setDismissed(next);
      place(next.length);
    } else {
      const f = menu.items[i];
      if (!f) return;
      const r = removeAt(text, menu.at);
      setText(r.text);
      setFiles((fs) => (fs.includes(f.path) ? fs : [...fs, f.path]));
      place(r.caret);
    }
    setMenu(undefined);
  };

  const send = async () => {
    if (!text.trim() || session.state !== "idle") return;
    if (await model.send(text, files)) { setText(""); setFiles([]); setDismissed(undefined); }
  };

  const cycleMode = () => { const m = nextMode(modes, session.agentMode); if (m) void model.setAgentMode(m); };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu) {
      const n = menu.items.length;
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % n); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + n) % n); return; }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); choose(active); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(text); setMenu(undefined); return; }
    }
    if (e.key === "Tab" && e.shiftKey && modes.length > 0) { e.preventDefault(); cycleMode(); return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
  };

  return (
    <VStack gap={2} className="coding-composer-wrap">
      {menu ? (
        <Card padding={1} className="coding-menu" data-testid={menu.kind === "slash" ? "coding-commands" : "coding-files"}>
          <List aria-label={menu.kind === "slash" ? "Commands" : "Files"} density="compact">
            {menu.kind === "slash"
              ? menu.items.map((c, i) => (
                <ListItem key={c.name} label={`/${c.name}`} description={c.hint ? `${c.description} · ${c.hint}` : c.description}
                  isSelected={i === active} onClick={() => choose(i)} />
              ))
              : menu.items.map((f, i) => (
                <ListItem key={f.path} label={f.name} description={f.path === f.name ? undefined : f.path} isSelected={i === active} onClick={() => choose(i)} />
              ))}
          </List>
        </Card>
      ) : null}
      {files.length > 0 ? (
        <HStack gap={1} wrap="wrap" data-testid="coding-file-chips">
          {files.map((f) => <Token key={f} size="sm" label={`@${f.slice(f.lastIndexOf("/") + 1)}`} description={f} onRemove={() => setFiles((fs) => fs.filter((x) => x !== f))} />)}
        </HStack>
      ) : null}
      <HStack gap={2} vAlign="end" className="coding-composer">
        <TextArea ref={ref} label="Message" isLabelHidden placeholder={`Ask ${session.agentName}… (/ for commands, @ for files)`} value={text} rows={2}
          onChange={(v, e) => { setText(v); setCaret(e.target.selectionStart ?? v.length); if (dismissed !== undefined && dismissed !== v) setDismissed(undefined); }}
          onKeyDown={onKeyDown} onKeyUp={(e: React.KeyboardEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={(e: React.MouseEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart ?? 0)} />
        {running
          ? <Button variant="secondary" onClick={() => void model.cancel()} label="Stop" />
          : <Button variant="primary" onClick={() => void send()} isDisabled={!text.trim() || session.state !== "idle"} data-testid="coding-send" label="Send" />}
      </HStack>
      {modes.length > 0 ? (
        <HStack gap={2} vAlign="center" data-testid="coding-agent-mode">
          <Button size="sm" variant="ghost" onClick={cycleMode} label={`Mode: ${modeName ?? "–"}`} />
          <Text type="supporting" size="sm"><Kbd keys="shift+tab" /> to switch</Text>
        </HStack>
      ) : null}
    </VStack>
  );
}
