// ADR 0016: Block-Editor nach dem Anytype-Prinzip (Clean-Room). Die Seite ist der Baum der Block-Records; jeder
// Textblock hat ein eigenes contenteditable, dessen DOM nur aus dem Modell geschrieben wird. Eingaben werden als
// Befehle aus @based/core ausgeführt (ein Befehl = ein Undo-Schritt). Griff, Ziehen und Blockauswahl liegen in einer
// eigenen Schicht: der Griff sitzt an der ersten Zeile, Ziehziele werden beim Start einmal vermessen und danach nur
// gegen diesen Zwischenspeicher geprüft (höchstens einmal pro Frame), Auswahl ist eine Menge von Block-IDs.
import { blockCommands as cmd, CODE_LANGUAGES, dateMentionValue, dateSuggestions, plainText, type Block, type BlockDropZone, type EditorFocus, type EditorTextRange, type WorkspaceStore } from "@based/core";
import { mermaidPreview } from "../schema/mermaid.js";
import type { PageRef } from "../ui/env.js";
import { createContext, Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PageEditorProps } from "../ui/PageEditor.js";
import { ASSET_URL_PREFIX } from "../mapping/bn.js";
import { ChevronIcon, GripIcon, PlusIcon } from "../ui/icons.js";
import { EmojiPicker } from "../ui/EmojiPicker.js";
import { IconView } from "../ui/phosphor.js";
import { EditorController, scrollParent, type Caret } from "./controller.js";
import { caretOnEdgeLine, caretX, offsetOf, renderRich, selectionIn } from "./dom.js";
import { SLASH_ITEMS, filterSlash, type SlashItem } from "./slash.js";
import { PresenceLayer, useRealtime } from "./realtime.js";
import { highlightCode } from "./highlight.js";
import "./blocks.css";

interface Ctx {
  ctrl: EditorController;
  store: WorkspaceStore;
  props: PageEditorProps;
  editable: boolean;
}
const EditorCtx = createContext<Ctx | null>(null);
const useCtx = () => useContext(EditorCtx)!;

// MARK: Store-Abos (pro Block nur, was sich an ihm ändert)

const subs = new WeakMap<WorkspaceStore, (fn: () => void) => () => void>();
function storeSubscribe(store: WorkspaceStore) {
  let s = subs.get(store);
  if (!s) {
    s = (fn) => store.observe(() => fn());
    subs.set(store, s);
  }
  return s;
}
const useBlock = (store: WorkspaceStore, id: string) => useSyncExternalStore(storeSubscribe(store), () => store.blocks.get(id));
const useKids = (store: WorkspaceStore, id: string): string[] => {
  const key = useSyncExternalStore(storeSubscribe(store), () =>
    store.children("b:" + id).filter((k) => store.blocks.get(k)?.trashedAt === undefined).join("\n"));
  return useMemo(() => (key ? key.split("\n") : []), [key]);
};
const useSelected = (ctrl: EditorController, id: string) => useSyncExternalStore(ctrl.subscribe, () => ctrl.isSelected(id));

const PLACEHOLDER: Record<string, string> = {
  heading1: "Heading 1", heading2: "Heading 2", heading3: "Heading 3", heading4: "Heading 4", bulletedList: "List", numberedList: "List",
  todo: "To-do", toggle: "Toggle", quote: "Empty quote", callout: "Callout", code: "Code",
};

// MARK: Editor

export function BlockEditor(props: PageEditorProps) {
  const { store, pageID } = props;
  const editable = props.editable ?? true;
  const ctrl = useMemo(() => new EditorController(store, pageID), [store, pageID]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [slash, setSlash] = useState<SlashState | undefined>();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | undefined>();
  const [toolbar, setToolbar] = useState<{ x: number; y: number } | undefined>();
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const [mention, setMention] = useState<MentionState | undefined>();
  const mentionRef = useRef(mention);
  mentionRef.current = mention;
  const [link, setLinkState] = useState<{ caret: Caret; x: number; y: number; value: string } | undefined>();

  useLayoutEffect(() => {
    ctrl.root = rootRef.current;
    return () => { ctrl.root = null; };
  }, [ctrl]);

  // Titel ↔ Text wie Notion (PageView): „bx:focus“ kommt vom Titel (Enter, ↓, Klick unter die Seite).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ at: "start" | "end"; insert?: boolean; text?: string }>).detail;
      e.preventDefault();
      const order = ctrl.order();
      if (d.at === "start") {
        if (d.insert && editable) {
          run(cmd.insertBlock(store, { inside: pageID, at: "start" }, "text", d.text ? { text: d.text } : {}));
          const f = store.children("b:" + pageID)[0];
          if (f) ctrl.setCaret({ id: f, from: 0, to: 0 });
          return;
        }
        const first = order.find((x) => cmd.isTextBlock(store.blocks.get(x)));
        if (first) ctrl.setCaret({ id: first, from: 0, to: 0 });
        else if (editable) run(cmd.insertBlock(store, { inside: pageID, at: "start" }, "text"));
        return;
      }
      onTailClick();
    };
    root.addEventListener("bx:focus", on);
    return () => root.removeEventListener("bx:focus", on);
  });
  /** Am Anfang der Seite nach oben: in den Titel (PageView fängt „bx:leave-top“). */
  const leaveTop = (): boolean => !(rootRef.current?.dispatchEvent(new CustomEvent("bx:leave-top", { bubbles: true, cancelable: true })) ?? true);

  // BSD-101: zu einem Block springen
  useEffect(() => {
    if (!props.focusBlock) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(props.focusBlock)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("bx2-flash");
    const t = setTimeout(() => el.classList.remove("bx2-flash"), 1600);
    return () => clearTimeout(t);
  }, [props.focusBlock]);

  const run = useCallback((f: EditorFocus | undefined) => ctrl.apply(f), [ctrl]);
  /** ⌘B/⌘I/… über die Auswahl im Block (ohne Auswahl: nichts – das übernimmt „stored“). */
  const format = (c: Caret, key: cmd.MarkKey) => (c.from === c.to ? undefined : cmd.formatText(store, [R(c)], key));

  // MARK: Eingabe (beforeinput – das Modell entscheidet, das DOM folgt)

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const idOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>("[data-editable-id]")?.dataset.editableId : undefined);
    let compStart: Caret | undefined;

    const onBeforeInput = (e: InputEvent) => {
      const id = idOf(e.target);
      if (!id) return;
      if (!editable) { e.preventDefault(); return; }
      if (e.inputType === "insertCompositionText" || e.inputType === "insertFromComposition" || e.inputType === "deleteCompositionText") return;
      const c = ctrl.readCaret(id);
      if (!c) return;
      const el = ctrl.editable(id)!;
      const tr = e.getTargetRanges?.()[0];
      const target: Caret = tr ? { id, from: offsetOf(el, tr.startContainer, tr.startOffset), to: offsetOf(el, tr.endContainer, tr.endOffset) } : c;
      e.preventDefault();
      switch (e.inputType) {
        case "insertText": {
          const data = e.data ?? "";
          const st = ctrl.stored && ctrl.stored.id === c.id && ctrl.stored.at === c.from && c.from === c.to ? ctrl.stored.marks : undefined;
          const f = cmd.replaceText(store, R(c), data, st !== undefined ? { marks: (st ?? {}) as cmd.Marks } : {});
          const pos = f && "offset" in f ? f.offset : undefined;
          if (st !== undefined && pos !== undefined) ctrl.stored = { id: c.id, at: pos, marks: st };
          else ctrl.stored = undefined;
          run(f);
          // Kürzel am Blockanfang („## “, „- “, „---“, „```“), sonst Inline-Markdown beim schließenden Zeichen
          const block = pos !== undefined && (data === " " || data === "-" || data === "`") ? cmd.applyMarkdownShortcut(store, c.id, pos) : undefined;
          if (block) run(block);
          else if (pos !== undefined && (data === "*" || data === "`" || data === "~" || data === "_")) {
            const s = cmd.applyInlineMarkdown(store, c.id, pos);
            if (s) {
              run(s);
              if ("offset" in s) ctrl.stored = { id: s.blockId, at: s.offset, marks: null };
            }
          }
          if (data === "/" && pos !== undefined && !block) openSlash(id, pos - 1);
          else if (slashRef.current) updateSlash(id);
          if (data === "@" && pos !== undefined && props.pages) openMention(id, pos - 1);
          else if (mentionRef.current) updateMention(id);
          break;
        }
        case "insertReplacementText": {
          const t = e.dataTransfer?.getData("text/plain") ?? e.data ?? "";
          run(cmd.replaceText(store, R(target), t, { coalesce: null }));
          break;
        }
        case "insertParagraph":
          run(cmd.splitBlock(store, c.id, c.from, c.to));
          break;
        case "insertLineBreak":
          run(cmd.replaceText(store, R(c), "\n"));
          break;
        case "deleteContentBackward":
          run(cmd.deleteBackward(store, R(c)));
          if (slashRef.current) updateSlash(id);
          if (mentionRef.current) updateMention(id);
          break;
        case "deleteContentForward":
          run(cmd.deleteForward(store, R(c)));
          break;
        case "deleteWordBackward": case "deleteSoftLineBackward": case "deleteHardLineBackward":
        case "deleteWordForward": case "deleteSoftLineForward": case "deleteHardLineForward": case "deleteContent": case "deleteByCut":
          if (target.from !== target.to) run(cmd.deleteBackward(store, R(target)));
          else run(e.inputType.endsWith("Forward") ? cmd.deleteForward(store, R(c)) : cmd.deleteBackward(store, R(c)));
          if (slashRef.current) updateSlash(id);
          break;
        case "formatBold": run(format(c, "b")); break;
        case "formatItalic": run(format(c, "i")); break;
        case "formatUnderline": run(format(c, "u")); break;
        case "formatStrikeThrough": run(format(c, "s")); break;
        case "historyUndo": undo(); break;
        case "historyRedo": redo(); break;
        case "insertFromDrop": {
          const t = e.dataTransfer?.getData("text/plain");
          if (t) run(cmd.replaceText(store, R(target), t.replace(/\r\n?/g, "\n"), { coalesce: null }));
          break;
        }
        default:
          break;
      }
    };

    const onCompositionStart = (e: CompositionEvent) => {
      const id = idOf(e.target);
      if (!id) return;
      ctrl.composing = id;
      compStart = ctrl.readCaret(id);
    };
    const onCompositionEnd = (e: CompositionEvent) => {
      const id = idOf(e.target);
      ctrl.composing = undefined;
      if (!id || !compStart || compStart.id !== id) return;
      const start = compStart;
      compStart = undefined;
      const el = ctrl.editable(id);
      if (e.data) run(cmd.replaceText(store, R(start), e.data));
      else if (el) {
        renderRich(el, store.blocks.get(id)?.text, atomRenderer(props));
        ctrl.setCaret(start);
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      const id = idOf(e.target);
      const data = e.clipboardData;
      if (!data || !editable) return;
      const anchor = id ?? ctrl.selected[ctrl.selected.length - 1];
      if (!anchor) return;
      e.preventDefault();
      let based: cmd.BasedClipboard | undefined;
      try {
        const raw = data.getData(cmd.BASED_CLIPBOARD_MIME);
        const v: unknown = raw ? JSON.parse(raw) : undefined;
        if (cmd.isBasedClipboard(v)) based = v;
      } catch { based = undefined; }
      const text = data.getData("text/plain");
      const html = data.getData("text/html");
      const image = !html && !based ? Array.from(data.files ?? []).find((f) => f.type.startsWith("image/")) : undefined;
      if (image && props.uploadFile) { insertImage(anchor, image); return; }
      const content: cmd.PasteContent = { based, text: text || undefined, html: html || undefined };
      const opts = { pageExists: (x: string) => store.blocks.has(x) || props.pages?.get(x) !== undefined };
      const c = id ? ctrl.readCaret(id) : undefined;
      if (!c) { run(cmd.insertContentAfter(store, anchor, content, opts)); return; }
      // URL über markiertem Text: Link setzen (wie Notion)
      if (c.from !== c.to && /^https?:\/\/\S+$/.test(text.trim())) { run(cmd.formatText(store, [R(c)], "link", text.trim())); return; }
      run(cmd.insertContent(store, R(c), content, opts));
    };

    // Bild einfügen (Zwischenablage, Ablegen): Bildblock sofort, Hochladen danach
    const insertImage = (anchor: string, file: File) => {
      const a = store.blocks.get(anchor);
      const empty = a?.type === "text" && plainText(a.text).length === 0;
      const f = empty ? cmd.convertEmptyBlock(store, anchor, "image") : cmd.insertBlock(store, { after: anchor }, "image");
      if (!f) return;
      run(f);
      void props.uploadFile?.(file, f.blockId).then((url) => cmd.setBlockProps(store, [f.blockId], { url }, "Add image")).catch(() => undefined);
    };
    const onDrop = (e: DragEvent) => {
      const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (!file || !editable || !props.uploadFile || (e.target instanceof Element && e.target.closest(".bx2-image"))) return;
      const at = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-block-id]")?.dataset.blockId : undefined;
      const anchor = at ?? ctrl.order()[ctrl.order().length - 1];
      if (!anchor) return;
      e.preventDefault();
      insertImage(anchor, file);
    };
    const onDragOver = (e: DragEvent) => { if (editable && props.uploadFile && e.dataTransfer?.types.includes("Files")) e.preventDefault(); };

    const onCopy = (e: ClipboardEvent) => {
      if (!ctrl.selected.length || !e.clipboardData) return;
      e.preventDefault();
      writeBlocksClipboard(store, ctrl.selected, e.clipboardData);
      if (e.type === "cut" && editable) {
        const f = cmd.deleteBlocks(store, ctrl.selected);
        ctrl.clearSelection();
        run(f);
      }
    };

    root.addEventListener("beforeinput", onBeforeInput);
    root.addEventListener("compositionstart", onCompositionStart);
    root.addEventListener("compositionend", onCompositionEnd);
    root.addEventListener("paste", onPaste);
    root.addEventListener("copy", onCopy);
    root.addEventListener("cut", onCopy);
    root.addEventListener("drop", onDrop);
    root.addEventListener("dragover", onDragOver);
    return () => {
      root.removeEventListener("beforeinput", onBeforeInput);
      root.removeEventListener("compositionstart", onCompositionStart);
      root.removeEventListener("compositionend", onCompositionEnd);
      root.removeEventListener("paste", onPaste);
      root.removeEventListener("copy", onCopy);
      root.removeEventListener("cut", onCopy);
      root.removeEventListener("drop", onDrop);
      root.removeEventListener("dragover", onDragOver);
    };
  }, [ctrl, store, pageID, editable]);

  const undo = () => {
    const keep = ctrl.caret;
    store.undo();
    if (keep && store.blocks.has(keep.id)) ctrl.setCaret(clampCaret(store, keep));
  };
  const redo = () => {
    const keep = ctrl.caret;
    store.redo();
    if (keep && store.blocks.has(keep.id)) ctrl.setCaret(clampCaret(store, keep));
  };

  // MARK: Slash-Menü

  const openSlash = (id: string, at: number) => {
    const el = ctrl.editable(id);
    if (!el) return;
    const r = el.ownerDocument.getSelection()?.getRangeAt(0).getBoundingClientRect();
    const box = r && (r.width || r.height) ? r : el.getBoundingClientRect();
    setSlash({ id, at, query: "", index: 0, x: box.left, y: box.bottom + 6 });
  };
  const updateSlash = (id: string) => {
    const s = slashRef.current;
    if (!s || s.id !== id) return;
    const text = plainText(store.blocks.get(id)?.text);
    const c = ctrl.caret;
    if (!c || c.from <= s.at || text[s.at] !== "/") { setSlash(undefined); return; }
    const query = text.slice(s.at + 1, c.from);
    if (/\s\s/.test(query) || query.length > 24) { setSlash(undefined); return; }
    setSlash({ ...s, query, index: 0 });
  };
  const chooseSlash = (item: SlashItem) => {
    const s = slashRef.current;
    setSlash(undefined);
    if (!s) return;
    const b = store.blocks.get(s.id);
    if (!b) return;
    const end = s.at + 1 + s.query.length;
    cmd.replaceText(store, { blockId: s.id, from: s.at, to: end }, "");
    const empty = textLen(store, s.id) === 0;
    if (item.page) {
      const created = item.page(store, empty ? s.id : undefined, s.id);
      if (created && props.onOpenPage) props.onOpenPage(created);
      return;
    }
    if (item.columns) {
      run(cmd.insertColumns(store, s.id, item.columns, empty));
      return;
    }
    if (item.create) {
      const created = item.create(store, s.id, empty);
      if (created) ctrl.select([created]);
      return;
    }
    if (empty) run(cmd.convertEmptyBlock(store, s.id, item.type, item.props ?? {}));
    else run(cmd.insertBlock(store, { after: s.id }, item.type, item.props ? { props: item.props } : {}));
  };

  // MARK: @-Erwähnungen

  const openMention = (id: string, at: number) => {
    const el = ctrl.editable(id);
    if (!el) return;
    const r = el.ownerDocument.getSelection()?.getRangeAt(0).getBoundingClientRect();
    const box = r && (r.width || r.height) ? r : el.getBoundingClientRect();
    const st: MentionState = { id, at, query: "", index: 0, x: box.left, y: box.bottom + 6, items: [] };
    setMention(st);
    void searchMention(st);
  };
  const searchMention = async (st: MentionState) => {
    const pages = await (props.pages?.search(st.query) ?? Promise.resolve([] as PageRef[])).catch(() => [] as PageRef[]);
    const dates = dateSuggestions(st.query, new Date()).slice(0, st.query ? 3 : 2);
    const items: MentionItem[] = [...pages.slice(0, 8).map((ref) => ({ kind: "page" as const, ref })), ...dates.map((d) => ({ kind: "date" as const, label: d.label, date: d.date }))];
    setMention((cur) => (cur && cur.id === st.id && cur.at === st.at && cur.query === st.query ? { ...cur, items, index: 0 } : cur));
  };
  const updateMention = (id: string) => {
    const s = mentionRef.current;
    if (!s || s.id !== id) return;
    const text = plainText(store.blocks.get(id)?.text);
    const c = ctrl.caret;
    if (!c || c.from <= s.at || text[s.at] !== "@") { setMention(undefined); return; }
    const query = text.slice(s.at + 1, c.from);
    if (/\s\s/.test(query) || query.length > 40) { setMention(undefined); return; }
    const next = { ...s, query };
    setMention(next);
    void searchMention(next);
  };
  const chooseMention = (item: MentionItem) => {
    const s = mentionRef.current;
    setMention(undefined);
    if (!s) return;
    const range = { blockId: s.id, from: s.at, to: s.at + 1 + s.query.length };
    if (item.kind === "page") run(cmd.insertMention(store, range, { page: { _0: item.ref.id } }, item.ref.title || "Untitled"));
    else run(cmd.insertMention(store, range, { date: { _0: dateMentionValue(item.date) } }, "@" + item.label));
  };

  // MARK: Link (⌘K)

  const openLink = (c: Caret) => {
    const doc = rootRef.current!.ownerDocument;
    const r = doc.getSelection()?.rangeCount ? doc.getSelection()!.getRangeAt(0).getBoundingClientRect() : undefined;
    const b = store.blocks.get(c.id);
    const current = linkIn(b?.text, c.from, c.to);
    setLinkState({ caret: c, x: r?.left ?? 100, y: (r?.bottom ?? 100) + 8, value: typeof current === "string" ? current : "" });
  };
  const commitLink = (value: string | undefined) => {
    const l = link;
    setLinkState(undefined);
    if (!l) return;
    if (value !== undefined) {
      cmd.formatText(store, [R(l.caret)], "link", value.trim() || false);
      ctrl.setCaret({ id: l.caret.id, from: l.caret.to, to: l.caret.to });
    } else ctrl.setCaret(l.caret);
  };

  // MARK: Tastatur

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const s = slashRef.current;
    if (s) {
      const items = filterSlash(SLASH_ITEMS, s.query);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = items.length || 1;
        setSlash({ ...s, index: (s.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = items[s.index];
        if (item) chooseSlash(item);
        else setSlash(undefined);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setSlash(undefined); return; }
    }
    const m = mentionRef.current;
    if (m && m.items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = m.items.length;
        setMention({ ...m, index: (m.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseMention(m.items[m.index]!); return; }
    }
    if (m && e.key === "Escape") { e.preventDefault(); setMention(undefined); return; }
    // ⌘⌥T gilt überall im Editor (auch nach einem Klick auf einen Pfeil)
    if (e.code === "KeyT" && blockShortcut(e, [])) return;
    const target = e.target as HTMLElement;
    // Eingabefelder in Blöcken (Gleichung, Link, Datenbank-Zellen) behalten ihre Tasten
    if (target.matches("input, textarea, select") || (target.isContentEditable && !target.dataset.editableId)) return;
    const id = target.dataset.editableId;
    if (id) return onFieldKey(e, id, mod);
    if (ctrl.selected.length) return onSelectionKey(e, mod);
  };

  /** ⌘⌥0–9 (wie Notion): Text, H1–H3, To-do, Liste, Nummern, Toggle, Code, Seite. ⌘⌥T: alle Toggles auf/zu. */
  const blockShortcut = (e: React.KeyboardEvent, ids: readonly string[]): boolean => {
    if (!(e.metaKey || e.ctrlKey) || !e.altKey || !editable) return false;
    if (e.code === "KeyT") {
      e.preventDefault();
      const toggles = ctrl.order().map((x) => store.blocks.get(x)!).filter((x) => cmd.isToggle(x));
      const anyClosed = toggles.some((x) => x.props?.isOpen !== true);
      const all = [...store.children("b:" + pageID)].flatMap(function walk(x: string): string[] { return [x, ...store.children("b:" + x).flatMap(walk)]; }).filter((x) => cmd.isToggle(store.blocks.get(x)!));
      cmd.setBlockProps(store, all, { isOpen: anyClosed ? true : undefined }, anyClosed ? "Expand all" : "Collapse all");
      return true;
    }
    const m = /^Digit([0-9])$/.exec(e.code);
    if (!m) return false;
    const types = ["text", "heading1", "heading2", "heading3", "todo", "bulletedList", "numberedList", "toggle", "code", "page"] as const;
    const type = types[Number(m[1])]!;
    e.preventDefault();
    const targets = ids.filter((x) => cmd.isTextBlock(store.blocks.get(x)));
    if (type === "page" || targets.length === 0) return true;
    const c = ctrl.caret;
    cmd.turnInto(store, targets, type);
    if (c && targets.includes(c.id)) ctrl.setCaret(clampCaret(store, c));
    return true;
  };

  const onFieldKey = (e: React.KeyboardEvent, id: string, mod: boolean) => {
    const el = ctrl.editable(id);
    if (!el) return;
    const c = ctrl.readCaret(id);
    if (!c) return;
    const len = textLen(store, id);
    const key = e.key;
    if (blockShortcut(e, [id])) return;
    // WebKit schickt am Anfang/Ende eines Felds kein beforeinput (nichts zu löschen) – hier selbst behandeln
    if (key === "Backspace" && !mod && !e.altKey && c.from === 0 && c.to === 0) {
      e.preventDefault();
      // Leere erste Zeile: in den Titel (der leere Block bleibt nicht stehen, wenn noch etwas folgt)
      if (len === 0 && store.blocks.get(id)?.type === "text" && ctrl.order()[0] === id && leaveTop()) {
        if (editable && ctrl.order().length > 1) cmd.deleteBlocks(store, [id]);
        ctrl.caret = undefined;
        return;
      }
      if (editable) run(cmd.deleteBackward(store, R(c)));
      return;
    }
    if (key === "Delete" && !mod && !e.altKey && c.from === len && c.to === len) {
      e.preventDefault();
      if (editable) run(cmd.deleteForward(store, R(c)));
      return;
    }
    if (key === "Tab") {
      e.preventDefault();
      if (!editable) return;
      if (e.shiftKey) cmd.outdentBlocks(store, [id]);
      else cmd.indentBlocks(store, [id]);
      ctrl.setCaret(c);
      return;
    }
    if (key === "Escape") {
      e.preventDefault();
      setToolbar(undefined);
      ctrl.select([id]);
      return;
    }
    if (mod && !e.altKey) {
      const k = key.toLowerCase();
      const mark = k === "b" ? "b" : k === "i" ? "i" : k === "u" ? "u" : k === "e" ? "c" : e.shiftKey && k === "s" ? "s" : e.shiftKey && k === "x" ? "s" : undefined;
      if (mark && !(e.shiftKey && (k === "b" || k === "i" || k === "u" || k === "e"))) {
        e.preventDefault();
        if (!editable) return;
        if (c.from === c.to) {
          // ohne Auswahl: gilt für die nächsten Zeichen an dieser Stelle (wie Notion)
          const base = ctrl.stored && ctrl.stored.id === c.id && ctrl.stored.at === c.from ? ctrl.stored.marks ?? {} : { ...cmd.marksAt(cmd.runsOf(store.blocks.get(id)?.text), c.from) };
          const next: Record<string, unknown> = { ...base };
          if (next[mark]) delete next[mark];
          else next[mark] = true;
          ctrl.stored = { id: c.id, at: c.from, marks: Object.keys(next).length ? next : null };
          return;
        }
        run(format(c, mark));
        return;
      }
      if (k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (k === "k" && editable && c.from !== c.to) { e.preventDefault(); e.stopPropagation(); openLink(c); return; }
      if (k === "y") { e.preventDefault(); redo(); return; }
      if (k === "a" && c.from === 0 && c.to === len) {
        e.preventDefault();
        ctrl.select(ctrl.order());
        return;
      }
      if (k === "d" && editable) {
        e.preventDefault();
        const [copy] = duplicate(store, [id]);
        if (copy) ctrl.setCaret({ id: copy, from: c.from, to: c.to });
        return;
      }
      if (key === "Enter" && editable) {
        e.preventDefault();
        const b = store.blocks.get(id)!;
        if (b.type === "todo") cmd.setChecked(store, id, !b.props?.checked);
        else if (cmd.isToggle(b)) cmd.setBlockProps(store, [id], { isOpen: !b.props?.isOpen }, "Toggle");
        return;
      }
      if (e.shiftKey && (key === "ArrowUp" || key === "ArrowDown") && editable) {
        e.preventDefault();
        if (cmd.moveBlocksBy(store, [id], key === "ArrowUp" ? "up" : "down")) ctrl.setCaret(c);
        return;
      }
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      const dir = key === "ArrowUp" ? -1 : 1;
      if (!caretOnEdgeLine(el, dir < 0 ? "first" : "last")) return;
      if (e.shiftKey) {
        const n = ctrl.order();
        const other = n[n.indexOf(id) + dir];
        if (other) { e.preventDefault(); ctrl.selectRange(id, other); }
        return;
      }
      if (e.altKey || mod) return;
      const next = ctrl.neighbourText(id, dir);
      if (!next) {
        if (dir < 0 && ctrl.order()[0] === id && leaveTop()) e.preventDefault();
        return;
      }
      e.preventDefault();
      const x = caretX(el) ?? el.getBoundingClientRect().left;
      ctrl.setCaret({ id: next, from: 0, to: 0 }, { x, edge: dir < 0 ? "last" : "first" });
      return;
    }
    if ((key === "ArrowLeft" && c.from === 0 && c.to === 0) || (key === "ArrowRight" && c.from === len && c.to === len)) {
      if (e.shiftKey || e.altKey || mod) return;
      const dir = key === "ArrowLeft" ? -1 : 1;
      const next = ctrl.neighbourText(id, dir);
      if (!next) return;
      e.preventDefault();
      ctrl.setCaret(dir < 0 ? endCaret(store, next) : { id: next, from: 0, to: 0 });
    }
  };

  const onSelectionKey = (e: React.KeyboardEvent, mod: boolean) => {
    const sel = ctrl.selected;
    const key = e.key;
    const order = ctrl.order();
    if (blockShortcut(e, sel)) return;
    if (key === "Escape") { e.preventDefault(); ctrl.clearSelection(); return; }
    if ((key === "Backspace" || key === "Delete") && editable) {
      e.preventDefault();
      const f = cmd.deleteBlocks(store, sel);
      ctrl.clearSelection();
      run(f);
      return;
    }
    if (key === "Enter") {
      e.preventDefault();
      const first = sel.find((x) => cmd.isTextBlock(store.blocks.get(x)));
      if (first) ctrl.setCaret(endCaret(store, first));
      return;
    }
    if (key === "Tab" && editable) {
      e.preventDefault();
      if (e.shiftKey) cmd.outdentBlocks(store, sel);
      else cmd.indentBlocks(store, sel);
      ctrl.select(sel);
      return;
    }
    if (mod && key.toLowerCase() === "a") { e.preventDefault(); ctrl.select(order); return; }
    if (mod && key.toLowerCase() === "d" && editable) { e.preventDefault(); ctrl.select(duplicate(store, sel)); return; }
    if (mod && e.shiftKey && (key === "ArrowUp" || key === "ArrowDown") && editable) {
      e.preventDefault();
      cmd.moveBlocksBy(store, sel, key === "ArrowUp" ? "up" : "down");
      ctrl.select(sel);
      return;
    }
    if (mod && key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
    if (key === "ArrowUp" || key === "ArrowDown") {
      e.preventDefault();
      const dir = key === "ArrowUp" ? -1 : 1;
      if (e.shiftKey) {
        const anchor = ctrl.anchor ?? sel[0]!;
        const headEdge = order.indexOf(anchor) <= order.indexOf(sel[0]!) && sel.length > 1 && dir < 0 && anchor === sel[0] ? sel[sel.length - 1]! : (dir < 0 ? sel[0]! : sel[sel.length - 1]!);
        const head = order[order.indexOf(headEdge) + dir];
        if (head) ctrl.selectRange(anchor, head);
        return;
      }
      const edge = dir < 0 ? sel[0]! : sel[sel.length - 1]!;
      const next = order[order.indexOf(edge) + dir];
      ctrl.select([next ?? edge]);
    }
  };

  // MARK: Auswahlleiste für Text (B I U S Code)

  useEffect(() => {
    const doc = rootRef.current?.ownerDocument;
    if (!doc) return;
    const onSel = () => {
      const active = doc.activeElement as HTMLElement | null;
      const id = active?.dataset?.editableId;
      if (!id || !rootRef.current?.contains(active)) { setToolbar(undefined); return; }
      const s = selectionIn(active);
      if (!s) return;
      ctrl.caret = { id, from: s.from, to: s.to };
      if (s.from === s.to || store.blocks.get(id)?.type === "code") { setToolbar(undefined); return; }
      const r = doc.getSelection()!.getRangeAt(0).getBoundingClientRect();
      setToolbar({ x: r.left + r.width / 2, y: r.top });
    };
    doc.addEventListener("selectionchange", onSel);
    return () => doc.removeEventListener("selectionchange", onSel);
  }, [ctrl, store]);

  // MARK: Zeiger: Hover, Ziehen am Griff, Rechteck-Auswahl, Ziehen über Blöcke

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let hovered: HTMLElement | null = null;
    const onOver = (e: MouseEvent) => {
      const b = (e.target as Element).closest?.<HTMLElement>(".bx2-block");
      if (b === hovered) return;
      hovered?.removeAttribute("data-hover");
      hovered = b && root.contains(b) ? b : null;
      hovered?.setAttribute("data-hover", "");
    };
    const onLeave = () => { hovered?.removeAttribute("data-hover"); hovered = null; };
    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseleave", onLeave);
    return () => { root.removeEventListener("mouseover", onOver); root.removeEventListener("mouseleave", onLeave); };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    const handle = t.closest<HTMLElement>("[data-handle]");
    if (handle) return startHandle(e, handle.dataset.handle!);
    const field = t.closest<HTMLElement>("[data-editable-id]");
    if (field) {
      ctrl.clearSelection();
      return startTextDrag(e, field.dataset.editableId!);
    }
    if (t.closest("button, a, input, select, textarea, [data-embed], .bx2-menu")) return;
    // Klick rechts neben dem Text einer Zeile: Cursor ans Ende
    const row = t.closest<HTMLElement>(".bx2-row");
    const rowField = row?.querySelector<HTMLElement>(":scope > [data-editable-id], :scope > .bx2-field-wrap > [data-editable-id]");
    if (rowField && editable) {
      e.preventDefault();
      ctrl.setCaret(endCaret(store, rowField.dataset.editableId!));
      return;
    }
    startMarquee(e);
  };

  /** Zeilen aller Blöcke einmal vermessen (Inhalts-Koordinaten des Scrollbereichs). */
  const measure = (exclude: ReadonlySet<string>): Measured[] => {
    const root = rootRef.current!;
    const scroller = scrollParent(root) ?? root.ownerDocument.documentElement;
    const sb = scroller.getBoundingClientRect();
    const out: Measured[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(".bx2-block"))) {
      const id = el.dataset.blockId!;
      if (el.closest("[data-dragging]") || exclude.has(id)) continue;
      const row = el.querySelector<HTMLElement>(":scope > .bx2-row") ?? el;
      const r = row.getBoundingClientRect();
      const whole = el.getBoundingClientRect();
      const b = store.blocks.get(id);
      out.push({
        id, el,
        top: r.top - sb.top + scroller.scrollTop, bottom: r.bottom - sb.top + scroller.scrollTop,
        wholeBottom: whole.bottom - sb.top + scroller.scrollTop,
        left: r.left, right: r.right,
        nestable: cmd.canNestUnder(b),
        columnable: isColumnable(store, id, pageID),
      });
    }
    return out;
  };

  const startHandle = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const root = rootRef.current!;
    const doc = root.ownerDocument;
    const scroller = scrollParent(root) ?? doc.documentElement;
    const ids = ctrl.isSelected(id) ? [...ctrl.selected] : [id];
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let rows: Measured[] = [];
    let drop: { id: string; side: BlockDropZone } | undefined;
    let frame = 0;
    let last = { x: e.clientX, y: e.clientY };
    const indicator = doc.createElement("div");
    indicator.className = "bx2-drop";
    const ghost = doc.createElement("div");
    ghost.className = "bx2-ghost";

    const update = () => {
      frame = 0;
      const sb = scroller.getBoundingClientRect();
      // Auto-Scroll am Rand
      const edge = 56;
      if (last.y < sb.top + edge) scroller.scrollTop -= Math.ceil((sb.top + edge - last.y) / 4);
      else if (last.y > sb.bottom - edge) scroller.scrollTop += Math.ceil((last.y - (sb.bottom - edge)) / 4);
      const y = last.y - sb.top + scroller.scrollTop;
      drop = dropTarget(rows, last.x, y);
      ghost.style.transform = `translate(${last.x + 12}px, ${last.y + 8}px)`;
      if (!drop) { indicator.style.display = "none"; }
      else {
        const m = rows.find((r) => r.id === drop!.id)!;
        const top = (drop.side === "before" ? m.top : drop.side === "left" || drop.side === "right" ? m.top : m.wholeBottom) - scroller.scrollTop + sb.top;
        indicator.style.display = "block";
        if (drop.side === "left" || drop.side === "right") {
          indicator.className = "bx2-drop bx2-drop-v";
          indicator.style.left = `${(drop.side === "left" ? m.left - 6 : m.right + 4)}px`;
          indicator.style.top = `${top}px`;
          indicator.style.height = `${m.bottom - m.top}px`;
          indicator.style.width = "";
        } else {
          indicator.className = "bx2-drop";
          const indent = drop.side === "inside" ? 28 : 0;
          indicator.style.left = `${m.left + indent}px`;
          indicator.style.top = `${top - 2}px`;
          indicator.style.width = `${m.right - m.left - indent}px`;
          indicator.style.height = "";
        }
      }
      if (dragging && (last.y < sb.top + edge || last.y > sb.bottom - edge)) frame = requestAnimationFrame(update);
    };
    const onMove = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        dragging = true;
        for (const x of ids) root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(x)}"]`)?.setAttribute("data-dragging", "");
        rows = measure(new Set(ids));
        ghost.textContent = ids.map((x) => plainText(store.blocks.get(x)?.text) || labelOf(store.blocks.get(x))).join(" · ").slice(0, 80) || "Block";
        doc.body.append(indicator, ghost);
        doc.documentElement.classList.add("bx2-is-dragging");
      }
      if (!frame) frame = requestAnimationFrame(update);
    };
    const finish = (ev: PointerEvent) => {
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", finish);
      doc.removeEventListener("pointercancel", finish);
      if (frame) cancelAnimationFrame(frame);
      // letzte Position sicher auswerten (schnelle Bewegungen, gedrosseltes rAF)
      if (dragging) { last = { x: ev.clientX, y: ev.clientY }; update(); if (frame) cancelAnimationFrame(frame); }
      indicator.remove();
      ghost.remove();
      doc.documentElement.classList.remove("bx2-is-dragging");
      root.querySelectorAll("[data-dragging]").forEach((x) => x.removeAttribute("data-dragging"));
      if (!dragging) {
        // Klick auf den Griff: Block wählen und Blockmenü öffnen (die Seite bewegt sich nicht)
        ctrl.select(ids);
        setMenu({ id, x: ev.clientX, y: ev.clientY });
        return;
      }
      if (drop && editable) {
        cmd.moveBlocks(store, ids, drop.id, drop.side);
        ctrl.select(ids);
      }
    };
    doc.addEventListener("pointermove", onMove);
    doc.addEventListener("pointerup", finish);
    doc.addEventListener("pointercancel", finish);
  };

  /** Text-Auswahl, die einen anderen Block erreicht, wird zur Blockauswahl (wie Notion). */
  const startTextDrag = (e: React.PointerEvent, origin: string) => {
    const doc = rootRef.current!.ownerDocument;
    let blocks = false;
    const onMove = (ev: PointerEvent) => {
      if ((ev.buttons & 1) === 0) return done();
      const over = doc.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".bx2-block");
      const id = over?.dataset.blockId;
      if (!id || !rootRef.current?.contains(over!)) return;
      const originEl = rootRef.current.querySelector(`[data-block-id="${CSS.escape(origin)}"]`);
      if (id === origin || originEl?.contains(over!) || over!.contains(originEl)) {
        if (blocks && id === origin) { blocks = false; ctrl.clearSelection(); }
        return;
      }
      blocks = true;
      ctrl.selectRange(origin, id);
      doc.getSelection()?.removeAllRanges();
    };
    const done = () => {
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", done);
    };
    void e;
    doc.addEventListener("pointermove", onMove);
    doc.addEventListener("pointerup", done);
  };

  const startMarquee = (e: React.PointerEvent) => {
    const root = rootRef.current!;
    const doc = root.ownerDocument;
    const scroller = scrollParent(root) ?? doc.documentElement;
    const startY = e.clientY - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const startX = e.clientX;
    let rows: Measured[] | undefined;
    let box: HTMLDivElement | undefined;
    let frame = 0;
    let last = { x: e.clientX, y: e.clientY };
    ctrl.clearSelection();
    const update = () => {
      frame = 0;
      const sb = scroller.getBoundingClientRect();
      const y = last.y - sb.top + scroller.scrollTop;
      const top = Math.min(startY, y), bottom = Math.max(startY, y);
      const left = Math.min(startX, last.x), right = Math.max(startX, last.x);
      box!.style.left = `${left}px`;
      box!.style.width = `${right - left}px`;
      box!.style.top = `${top - scroller.scrollTop + sb.top}px`;
      box!.style.height = `${bottom - top}px`;
      const hit = rows!.filter((r) => r.bottom > top && r.top < bottom && r.right > left - 400 && r.left < right + 400).map((r) => r.id);
      if (hit.length) ctrl.select(hit);
      else ctrl.clearSelection();
    };
    const onMove = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!box) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        rows = measure(new Set());
        box = doc.createElement("div");
        box.className = "bx2-marquee";
        doc.body.append(box);
        doc.getSelection()?.removeAllRanges();
      }
      if (!frame) frame = requestAnimationFrame(update);
    };
    const done = (ev: PointerEvent) => {
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", done);
      if (frame) cancelAnimationFrame(frame);
      if (box) { last = { x: ev.clientX, y: ev.clientY }; update(); }
      box?.remove();
      if (!box && !ctrl.selected.length) root.focus({ preventScroll: true });
    };
    doc.addEventListener("pointermove", onMove);
    doc.addEventListener("pointerup", done);
  };

  const onTailClick = () => {
    if (!editable) return;
    const kids = store.children("b:" + pageID).filter((k) => store.blocks.get(k)?.trashedAt === undefined);
    const last = kids[kids.length - 1];
    const lb = last ? store.blocks.get(last) : undefined;
    if (lb && lb.type === "text" && plainText(lb.text).length === 0) { ctrl.setCaret({ id: last!, from: 0, to: 0 }); return; }
    run(cmd.insertBlock(store, { inside: pageID }, "text"));
  };

  const ctx = useMemo<Ctx>(() => ({ ctrl, store, props, editable }), [ctrl, store, props, editable]);
  // ADR 0016 (E7): Echtzeit-Text und Präsenz über /collab (Dokument `text:<seite>`)
  const presence = useRealtime(store, pageID, props.collab, ctrl, props.presenceName);
  const slashItems = slash ? filterSlash(SLASH_ITEMS, slash.query) : [];

  return (
    <EditorCtx.Provider value={ctx}>
      <div ref={rootRef} className={"bx2-editor" + (props.className ? " " + props.className : "")} data-testid="block-editor" data-theme={props.theme} data-collab={presence ? "" : undefined}
        tabIndex={-1} onKeyDown={onKeyDown} onPointerDown={onPointerDown} writingsuggestions="false">
        <BlockList parent={pageID} depth={0} />
        {editable ? <div className="bx2-tail" onClick={onTailClick} data-testid="block-editor-tail" /> : null}
        {presence ? <PresenceLayer presence={presence} ctrl={ctrl} store={store} root={rootRef.current} /> : null}
      </div>
      {slash && slashItems.length ? <SlashMenu items={slashItems} state={slash} onChoose={chooseSlash} onHover={(i) => setSlash({ ...slash, index: i })} /> : null}
      {menu ? <BlockMenu id={menu.id} x={menu.x} y={menu.y} onClose={() => setMenu(undefined)} /> : null}
      {mention && mention.items.length ? <MentionMenu state={mention} onChoose={chooseMention} onHover={(i) => setMention({ ...mention, index: i })} /> : null}
      {link ? <LinkPopover x={link.x} y={link.y} value={link.value} onDone={commitLink} /> : null}
      {toolbar && editable && ctrl.caret ? <FormatBar x={toolbar.x} y={toolbar.y} onMark={(m) => { const c = ctrl.caret; if (c) run(format(c, m)); }}
        onColor={(color) => { const c = ctrl.caret; if (c && c.from !== c.to) run(cmd.formatText(store, [R(c)], "color", color ?? false)); }} /> : null}
    </EditorCtx.Provider>
  );
}

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> {
    writingsuggestions?: "true" | "false";
  }
}

// MARK: Ziehen – Ziel aus den vermessenen Zeilen

interface Measured {
  id: string;
  el: HTMLElement;
  top: number;
  bottom: number;
  wholeBottom: number;
  left: number;
  right: number;
  nestable: boolean;
  columnable: boolean;
}

/** Reine Regel: welcher Block, welche Seite. Exportiert für Tests. */
export function dropTarget(rows: readonly Pick<Measured, "id" | "top" | "bottom" | "wholeBottom" | "left" | "right" | "nestable" | "columnable">[], x: number, y: number): { id: string; side: BlockDropZone } | undefined {
  if (!rows.length) return undefined;
  // Zeilen, die horizontal passen (Spalten nebeneinander), dann die mit dem kleinsten Abstand in y
  const near = rows.filter((r) => x >= r.left - 48 && x <= r.right + 48);
  const pool = near.length ? near : rows;
  let best = pool[0]!;
  let bestD = Infinity;
  for (const r of pool) {
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    // innerste Zeile bevorzugen (kleinere Höhe bei gleichem Abstand)
    if (d < bestD || (d === bestD && r.bottom - r.top < best.bottom - best.top)) { best = r; bestD = d; }
  }
  const r = best;
  if (r.columnable && y >= r.top && y <= r.bottom) {
    if (x < r.left + 24) return { id: r.id, side: "left" };
    if (x > r.right - 24) return { id: r.id, side: "right" };
  }
  const upper = y < (r.top + r.bottom) / 2;
  if (upper) return { id: r.id, side: "before" };
  if (r.nestable && x > r.left + 48) return { id: r.id, side: "inside" };
  return { id: r.id, side: "after" };
}

/** Spalten nur für Blöcke direkt auf der Seite oder direkt in einer Spalte. */
function isColumnable(store: WorkspaceStore, id: string, pageID: string): boolean {
  const b = store.blocks.get(id);
  if (!b) return false;
  if (b.parent === "b:" + pageID) return true;
  const p = store.blocks.get(b.parent.slice(2));
  return p?.type === "column";
}

// MARK: Blöcke

const BlockList = memo(function BlockList({ parent, depth }: { parent: string; depth: number }) {
  const { store } = useCtx();
  const kids = useKids(store, parent);
  let num = 0;
  return (
    <>
      {kids.map((k) => {
        const t = store.blocks.get(k)?.type;
        num = t === "numberedList" ? num + 1 : 0;
        return <BlockView key={k} id={k} depth={depth} number={num} />;
      })}
    </>
  );
});

const BlockView = memo(function BlockView({ id, depth, number }: { id: string; depth: number; number: number }) {
  const { store, ctrl } = useCtx();
  const b = useBlock(store, id);
  const selected = useSelected(ctrl, id);
  if (!b || b.trashedAt !== undefined) return null;
  if (b.type === "columnList") return <Columns block={b} depth={depth} />;
  const showKids = cmd.visibleChildren(store, b).length > 0 && b.type !== "callout" && b.type !== "syncedBlock" && b.type !== "table";
  const color = typeof b.props?.color === "string" && b.props.color !== "default" ? b.props.color : undefined;
  // Abschnitt (Entscheidung 14. 11.): Toggle-Überschrift mit Hintergrundfarbe färbt den ganzen Block samt Inhalt als Fläche.
  const section = sectionColor(b);
  return (
    <div className={"bx2-block" + (section ? " bx2-section bx2-color-" + section : "")} data-block-id={id} data-type={b.type} data-selected={selected ? "" : undefined} data-depth={depth}>
      <Gutter id={id} />
      <div className={"bx2-row" + (color && !section ? " bx2-color-" + color : "")}>
        <BlockContent block={b} depth={depth} number={number} />
      </div>
      {showKids ? <ChildList id={id} depth={depth + 1} /> : null}
    </div>
  );
});

/** Hintergrundfarbe eines Abschnitts: Toggle-Überschrift (H1–H3) mit „…Background“-Farbe, sonst undefined. */
export function sectionColor(b: { type: string; props?: Record<string, unknown> | undefined }): string | undefined {
  const c = b.props?.color;
  return /^heading[1-3]$/.test(b.type) && b.props?.toggleable === true && typeof c === "string" && c.endsWith("Background") ? c : undefined;
}

function ChildList({ id, depth }: { id: string; depth: number }) {
  const { store } = useCtx();
  const kids = useKids(store, id);
  if (!kids.length) return null;
  return <div className="bx2-children"><BlockList parent={id} depth={depth} /></div>;
}

function Gutter({ id }: { id: string }) {
  const { store, ctrl, editable } = useCtx();
  if (!editable) return null;
  const add = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const b = store.blocks.get(id);
    if (b && b.type === "text" && plainText(b.text).length === 0) { ctrl.setCaret({ id, from: 0, to: 0 }); return; }
    ctrl.apply(cmd.insertBlock(store, { after: id }, "text"));
  };
  return (
    <div className="bx2-gutter" contentEditable={false}>
      <button type="button" className="bx2-gutter-btn" aria-label="Add block below" tabIndex={-1} onPointerDown={(e) => e.stopPropagation()} onClick={add}>
        <PlusIcon />
      </button>
      <button type="button" className="bx2-gutter-btn bx2-grip" aria-label="Drag to move, click for options" tabIndex={-1} data-handle={id} data-testid="block-handle">
        <GripIcon />
      </button>
    </div>
  );
}

function Columns({ block, depth }: { block: Block; depth: number }) {
  const { store, ctrl } = useCtx();
  const cols = useKids(store, block.id);
  const selected = useSelected(ctrl, block.id);
  return (
    <div className="bx2-block bx2-columns-block" data-block-id={block.id} data-type="columnList" data-selected={selected ? "" : undefined} data-depth={depth}>
      <div className="bx2-columns">
        {cols.map((c, i) => <Column key={c} id={c} depth={depth} next={cols[i + 1]} />)}
      </div>
    </div>
  );
}

/** Trenner zwischen zwei Spalten: Ziehen verteilt die Breite der beiden neu (ein Undo-Schritt am Ende). */
function ColumnResizer({ left, right }: { left: string; right: string }) {
  const { store, editable } = useCtx();
  const onDown = (e: React.PointerEvent) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    const sep = e.currentTarget as HTMLElement;
    const l = sep.parentElement as HTMLElement | null;
    const r = l?.nextElementSibling as HTMLElement | null;
    if (!l || !r) return;
    const lw = l.getBoundingClientRect().width, rw = r.getBoundingClientRect().width;
    const lr = Number(l.style.flexGrow) || 1, rr = Number(r.style.flexGrow) || 1;
    const total = lw + rw, sumR = lr + rr, startX = e.clientX;
    let ratios: [number, number] = [lr, rr];
    const doc = sep.ownerDocument;
    const move = (ev: PointerEvent) => {
      const nl = Math.min(Math.max(lw + ev.clientX - startX, total * 0.15), total * 0.85);
      ratios = [(nl / total) * sumR, ((total - nl) / total) * sumR];
      l.style.flexGrow = String(ratios[0]);
      r.style.flexGrow = String(ratios[1]);
    };
    const up = () => {
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", up);
      doc.documentElement.classList.remove("bx2-col-resizing");
      cmd.setColumnRatios(store, new Map([[left, ratios[0]], [right, ratios[1]]]));
    };
    doc.documentElement.classList.add("bx2-col-resizing");
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
  };
  return <div className="bx2-col-resize" role="separator" aria-orientation="vertical" aria-label="Resize columns" contentEditable={false} onPointerDown={onDown} />;
}

function Column({ id, depth, next }: { id: string; depth: number; next: string | undefined }) {
  const { store } = useCtx();
  const b = useBlock(store, id);
  const ratio = typeof b?.props?.ratio === "number" && b.props.ratio > 0 ? b.props.ratio : 1;
  return (
    <div className="bx2-column" data-column-id={id} style={{ flexGrow: ratio }}>
      <BlockList parent={id} depth={depth} />
      {next ? <ColumnResizer left={id} right={next} /> : null}
    </div>
  );
}

function BlockContent({ block: b, depth, number }: { block: Block; depth: number; number: number }) {
  const { store, props, editable } = useCtx();
  switch (b.type) {
    case "heading1": case "heading2": case "heading3": case "heading4":
      if (b.props?.toggleable) {
        return (
          <>
            <button type="button" className="bx2-marker bx2-toggle" data-open={b.props?.isOpen ? "" : undefined} aria-label={b.props?.isOpen ? "Collapse" : "Expand"} aria-expanded={b.props?.isOpen === true}
              onClick={() => cmd.setBlockProps(store, [b.id], { isOpen: b.props?.isOpen ? undefined : true }, "Toggle")}>
              <ChevronIcon />
            </button>
            <TextField block={b} />
          </>
        );
      }
      return <TextField block={b} />;
    case "text": case "quote":
      return <TextField block={b} />;
    case "code":
      return (
        <div className="bx2-codewrap">
          <TextField block={b} />
          <CodeLanguage block={b} />
          {b.props?.language === "mermaid" && plainText(b.text).length > 0 ? <MermaidPreview code={plainText(b.text)} /> : null}
        </div>
      );
    case "bulletedList":
      return <><span className="bx2-marker" contentEditable={false}>{["•", "◦", "▪"][depth % 3]}</span><TextField block={b} /></>;
    case "numberedList":
      return <><span className="bx2-marker bx2-number" contentEditable={false}>{numberLabel(number, depth)}.</span><TextField block={b} /></>;
    case "todo":
      return (
        <>
          <span className="bx2-marker" contentEditable={false}>
            <input type="checkbox" className="bx2-check" checked={b.props?.checked === true} disabled={!editable} aria-label="Done"
              onChange={() => cmd.setChecked(store, b.id, !b.props?.checked)} />
          </span>
          <TextField block={b} />
        </>
      );
    case "toggle":
      return (
        <>
          <button type="button" className="bx2-marker bx2-toggle" data-open={b.props?.isOpen ? "" : undefined} aria-label={b.props?.isOpen ? "Collapse" : "Expand"} aria-expanded={b.props?.isOpen === true}
            onClick={() => cmd.setBlockProps(store, [b.id], { isOpen: !b.props?.isOpen }, "Toggle")}>
            <ChevronIcon />
          </button>
          <TextField block={b} />
        </>
      );
    case "callout":
      return (
        <div className="bx2-callout">
          <CalloutIcon block={b} />
          <div className="bx2-callout-body">
            <TextField block={b} />
            <ChildList id={b.id} depth={depth + 1} />
          </div>
        </div>
      );
    case "divider":
      return <hr className="bx2-divider" />;
    case "page": case "databasePage": case "linkToPage": {
      const target = b.type === "linkToPage" ? b.props?.linkTarget : b.id;
      return <PageLink target={target} />;
    }
    case "databaseInline": {
      const dbID = b.props?.databaseID;
      const viewIDs = b.props?.viewIDs ?? [];
      return (
        <div className="bx2-embed bx2-database" data-embed="" contentEditable={false}>
          {dbID && props.renderDatabase ? props.renderDatabase({ blockID: b.id, databaseID: dbID, viewID: viewIDs[0] ?? "", viewIDs }) : <span className="bx2-muted">Database</span>}
        </div>
      );
    }
    case "image":
      return <ImageBlock block={b} />;
    case "equation":
      return <EquationBlock block={b} />;
    case "bookmark": case "embed": {
      const url = b.props?.url ?? "";
      if (!url) return <UrlPrompt block={b} />;
      const meta = b.props?.bookmark;
      return (
        <a className="bx2-embed bx2-bookmark" data-embed="" contentEditable={false} href={url} target="_blank" rel="noopener noreferrer">
          <span className="bx2-bookmark-title">{meta?.title || url || labelOf(b)}</span>
          {meta?.summary ? <span className="bx2-bookmark-summary">{meta.summary}</span> : null}
          <span className="bx2-bookmark-url">{url}</span>
        </a>
      );
    }
    case "video": case "audio": case "file": case "pdf":
      return <FileBlock block={b} />;
    case "table":
      return <TableBlock block={b} />;
    case "tableOfContents":
      return <TableOfContents />;
    case "button":
      return <div className="bx2-embed" data-embed="" contentEditable={false}><button type="button" className="bx2-button" disabled>{b.props?.buttonLabel || "Button"}</button></div>;
    case "syncedBlock": {
      // Kopie: zeigt (und bearbeitet) den Inhalt des Originals
      const source = typeof b.props?.syncSource === "string" && store.blocks.has(b.props.syncSource) ? b.props.syncSource : b.id;
      return (
        <div className="bx2-embed bx2-synced" data-embed="" data-synced-copy={source !== b.id ? "" : undefined}>
          <ChildList id={source} depth={depth + 1} />
          {!store.children("b:" + source).length ? <span className="bx2-muted">Synced block</span> : null}
        </div>
      );
    }
    default:
      return <div className="bx2-embed bx2-unsupported" data-embed="" contentEditable={false}>{labelOf(b)}<span className="bx2-muted"> · in the new editor soon</span></div>;
  }
}

function numberLabel(n: number, depth: number): string {
  const k = Math.max(1, n);
  if (depth % 3 === 1) return String.fromCharCode(96 + (((k - 1) % 26) + 1));
  if (depth % 3 === 2) return ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"][(k - 1) % 10]!;
  return String(k);
}

function PageLink({ target }: { target: string | undefined }) {
  const { store, props } = useCtx();
  const dir = props.pages;
  const ref = useSyncExternalStore(dir ? dir.subscribe : storeSubscribe(store), () => (target ? dir?.get(target) : undefined));
  const local = target ? store.blocks.get(target) : undefined;
  const title = ref?.title ?? (local ? plainText(local.text) : "") ?? "";
  const icon = ref?.icon ?? (typeof local?.props?.icon === "string" ? local.props.icon : undefined);
  return (
    <button type="button" className="bx2-pagelink" data-embed="" contentEditable={false} onClick={() => target && props.onOpenPage?.(target)}>
      <span className="bx2-pagelink-icon" aria-hidden="true"><IconView icon={icon} fallback="📄" /></span>
      <span className="bx2-pagelink-title">{title || "Untitled"}</span>
    </button>
  );
}

function ImageBlock({ block: b }: { block: Block }) {
  const raw = b.props?.asset ? ASSET_URL_PREFIX + b.props.asset.id : b.props?.url;
  const src = useFileURL(raw);
  const width = typeof b.props?.width === "number" ? b.props.width : undefined;
  const { store, props, editable } = useCtx();
  const input = useRef<HTMLInputElement>(null);
  const fig = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<number | undefined>();
  const upload = async (f: File | undefined) => {
    if (!f || !props.uploadFile) return;
    setBusy(true);
    try {
      const url = await props.uploadFile(f, b.id);
      cmd.setBlockProps(store, [b.id], { url }, "Add image");
    } finally { setBusy(false); }
  };
  // Breite am rechten Rand ziehen (wie Notion); gespeichert in Pixeln, ein Undo-Schritt beim Loslassen
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const img = fig.current?.querySelector("img");
    const host = fig.current?.parentElement;
    if (!img || !host) return;
    const x0 = e.clientX, w0 = img.getBoundingClientRect().width, max = host.getBoundingClientRect().width;
    let w = w0;
    const move = (ev: PointerEvent) => { w = Math.round(Math.max(80, Math.min(max, w0 + (ev.clientX - x0) * 2))); setLive(w); };
    const up = () => {
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", up);
      setLive(undefined);
      if (w !== w0) cmd.setBlockProps(store, [b.id], { width: w }, "Resize image");
    };
    const doc = img.ownerDocument;
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
  };
  const caption = b.props?.caption !== undefined ? plainText(b.props.caption) : undefined;
  const shown = live ?? width;
  return (
    <figure ref={fig} className="bx2-embed bx2-image" data-embed="" contentEditable={false}
      onDragOver={(e) => { if (editable && props.uploadFile && e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { const f = e.dataTransfer.files[0]; if (editable && f?.type.startsWith("image/")) { e.preventDefault(); void upload(f); } }}>
      {src ? (
        <span className="bx2-image-frame" style={shown ? { width: shown } : undefined}>
          <img src={src} alt={caption ?? ""} draggable={false} />
          {editable ? <span className="bx2-image-handle" role="separator" aria-orientation="vertical" aria-label="Resize image" onPointerDown={startResize} /> : null}
        </span>
      ) : (
        <button type="button" className="bx2-placeholder-btn" disabled={!editable || !props.uploadFile || busy} onClick={() => input.current?.click()}>
          {busy ? "Uploading…" : "Add an image"}
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
        </button>
      )}
      {src && (caption !== undefined || editable) ? (
        <input className="bx2-caption" aria-label="Caption" placeholder={editable ? "Add a caption" : ""} readOnly={!editable} defaultValue={caption ?? ""} key={caption ?? ""}
          onBlur={(e) => { const v = e.target.value; if (v !== (caption ?? "")) cmd.setBlockProps(store, [b.id], { caption: v || undefined }, "Caption"); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
      ) : null}
    </figure>
  );
}

function useFileURL(raw: string | undefined): string | undefined {
  const { props } = useCtx();
  const [src, setSrc] = useState<string | undefined>(raw && !raw.startsWith(ASSET_URL_PREFIX) ? raw : undefined);
  useEffect(() => {
    if (!raw) return;
    if (!raw.startsWith(ASSET_URL_PREFIX) || !props.resolveFileUrl) { setSrc(raw); return; }
    let alive = true;
    void props.resolveFileUrl(raw).then((u) => { if (alive) setSrc(u); }).catch(() => undefined);
    return () => { alive = false; };
  }, [raw, props]);
  return src;
}

function UrlPrompt({ block: b }: { block: Block }) {
  const { store, editable } = useCtx();
  const [v, setV] = useState("");
  const save = () => { const u = v.trim(); if (u) cmd.setBlockProps(store, [b.id], { url: /^[a-z]+:/i.test(u) ? u : "https://" + u }, "Add link"); };
  return (
    <div className="bx2-embed bx2-url" data-embed="" contentEditable={false}>
      <input autoFocus={editable} className="bx2-link-input" aria-label={b.type === "embed" ? "Embed link" : "Bookmark link"} placeholder={b.type === "embed" ? "Paste a link to embed…" : "Paste a link to create a bookmark…"}
        readOnly={!editable} value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} />
    </div>
  );
}

function FileBlock({ block: b }: { block: Block }) {
  const raw = b.props?.asset ? ASSET_URL_PREFIX + b.props.asset.id : b.props?.url;
  const src = useFileURL(raw);
  const { store, props, editable } = useCtx();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!raw) {
    const accept = b.type === "video" ? "video/*" : b.type === "audio" ? "audio/*" : b.type === "pdf" ? "application/pdf" : undefined;
    const upload = async (f: File | undefined) => {
      if (!f || !props.uploadFile) return;
      setBusy(true);
      try { cmd.setBlockProps(store, [b.id], { url: await props.uploadFile(f, b.id) }, "Upload"); } finally { setBusy(false); }
    };
    return (
      <div className="bx2-embed bx2-image" data-embed="" contentEditable={false}>
        <button type="button" className="bx2-placeholder-btn" disabled={!editable || !props.uploadFile || busy} onClick={() => input.current?.click()}>
          {busy ? "Uploading…" : "Upload " + labelOf(b).toLowerCase()}
          <input ref={input} type="file" accept={accept} hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
        </button>
      </div>
    );
  }
  const name = b.props?.asset?.name ?? (b.props?.url ? b.props.url.split("/").pop() : undefined) ?? labelOf(b);
  if (b.type === "video" && src) return <div className="bx2-embed" data-embed="" contentEditable={false}><video className="bx2-media" src={src} controls preload="metadata" /></div>;
  if (b.type === "audio" && src) return <div className="bx2-embed" data-embed="" contentEditable={false}><audio className="bx2-media" src={src} controls preload="metadata" /></div>;
  return (
    <a className="bx2-embed bx2-file" data-embed="" contentEditable={false} href={src} target="_blank" rel="noopener noreferrer" download={b.type === "file" ? name : undefined}>
      <span aria-hidden="true">{b.type === "pdf" ? "📕" : "📎"}</span><span className="bx2-file-name">{name}</span>
    </a>
  );
}

function TableBlock({ block: b }: { block: Block }) {
  const { store, editable } = useCtx();
  const cols = Math.max(1, b.props?.tableColumns ?? 1);
  const cells = b.props?.cells ?? [];
  const rows: (typeof cells)[] = [];
  for (let i = 0; i < cells.length; i += cols) rows.push(cells.slice(i, i + cols));
  const head = b.props?.tableHeaderRow === true;
  // Zelle bearbeiten: als Klartext (Formatierung einer unveränderten Zelle bleibt)
  const setCell = (i: number, text: string) => {
    if (plainText(cells[i]) === text) return;
    const next = [...cells];
    next[i] = text;
    cmd.setBlockProps(store, [b.id], { cells: next }, "Edit table");
  };
  const addRow = () => cmd.setBlockProps(store, [b.id], { cells: [...cells, ...Array.from({ length: cols }, () => "")] }, "Add row");
  const addColumn = () => {
    const next: typeof cells = [];
    for (let r = 0; r < Math.max(1, rows.length); r++) next.push(...(rows[r] ?? Array.from({ length: cols }, () => "")), "");
    cmd.setBlockProps(store, [b.id], { cells: next, tableColumns: cols + 1 }, "Add column");
  };
  const cell = (c: (typeof cells)[number], i: number, j: number) => {
    const idx = i * cols + j;
    const content = editable ? (
      <span className="bx2-cell" contentEditable="plaintext-only" suppressContentEditableWarning role="textbox" aria-label={`Row ${i + 1}, column ${j + 1}`}
        onBlur={(e) => setCell(idx, e.currentTarget.textContent ?? "")}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); (e.currentTarget as HTMLElement).blur(); } }}>{plainText(c)}</span>
    ) : plainText(c);
    return head && i === 0 ? <th key={j}>{content}</th> : <td key={j}>{content}</td>;
  };
  return (
    <div className="bx2-embed bx2-table-wrap" data-embed="" contentEditable={false}>
      <table className="bx2-table">
        <tbody>
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => cell(c, i, j))}</tr>)}
        </tbody>
      </table>
      {editable ? (
        <span className="bx2-table-tools">
          <button type="button" className="bx2-table-add" onClick={addRow} aria-label="Add row">+ Row</button>
          <button type="button" className="bx2-table-add" onClick={addColumn} aria-label="Add column">+ Column</button>
        </span>
      ) : null}
    </div>
  );
}

function TableOfContents() {
  const { store, ctrl } = useCtx();
  useSyncExternalStore(storeSubscribe(store), () => store.revision);
  const heads = ctrl.order().map((id) => store.blocks.get(id)!).filter((x) => /^heading[1-3]$/.test(x.type));
  return (
    <nav className="bx2-embed bx2-toc" data-embed="" contentEditable={false} aria-label="Table of contents">
      {heads.length ? heads.map((h) => (
        <button key={h.id} type="button" className={"bx2-toc-item bx2-toc-" + h.type} onClick={() => ctrl.root?.querySelector(`[data-block-id="${CSS.escape(h.id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" })}>
          {plainText(h.text) || "Untitled"}
        </button>
      )) : <span className="bx2-muted">Add headings to build a table of contents.</span>}
    </nav>
  );
}

function EquationBlock({ block: b }: { block: Block }) {
  const { store, props, editable } = useCtx();
  const expr = b.props?.expression ?? "";
  const [editing, setEditing] = useState(expr === "" && editable);
  const [draft, setDraft] = useState(expr);
  const save = () => {
    setEditing(false);
    if (draft !== expr) cmd.setBlockProps(store, [b.id], { expression: draft }, "Edit equation");
  };
  return (
    <div className="bx2-embed bx2-equation" data-embed="" contentEditable={false} onClick={() => editable && !editing && (setDraft(expr), setEditing(true))}>
      {expr ? (props.renderEquation ? props.renderEquation({ expression: expr, displayMode: true }) : <code>{expr}</code>) : <span className="bx2-muted">Add a TeX equation</span>}
      {editing ? (
        <textarea autoFocus className="bx2-link-input bx2-eq-input" aria-label="TeX" value={draft} placeholder="E = mc^2" onChange={(e) => setDraft(e.target.value)} onBlur={save}
          onKeyDown={(e) => { if ((e.key === "Enter" && (e.metaKey || e.ctrlKey)) || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); save(); } }} />
      ) : null}
    </div>
  );
}

function CalloutIcon({ block: b }: { block: Block }) {
  const { store, editable } = useCtx();
  const [open, setOpen] = useState(false);
  const icon = typeof b.props?.icon === "string" ? b.props.icon : "💡";
  return (
    <span className="bx2-callout-icon" contentEditable={false}>
      <button type="button" className="bx2-icon-btn" aria-label="Change icon" disabled={!editable} onClick={() => setOpen(true)}><IconView icon={icon} fallback="💡" /></button>
      {open ? (
        <EmojiPicker className="bx-callout-picker" current={icon} onClose={() => setOpen(false)}
          onPick={(e) => { setOpen(false); cmd.setBlockProps(store, [b.id], { icon: e ?? undefined }, "Change icon"); }} />
      ) : null}
    </span>
  );
}

function CodeLanguage({ block: b }: { block: Block }) {
  const { store, editable } = useCtx();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const cur = b.props?.language;
  const name = CODE_LANGUAGES.find((l) => l.id === cur)?.name ?? (cur || "Plain text");
  const list = CODE_LANGUAGES.filter((l) => !q || l.name.toLowerCase().includes(q.toLowerCase()) || l.aliases?.some((a) => a.startsWith(q.toLowerCase())));
  const pick = (id: string | undefined) => {
    setOpen(false);
    setQ("");
    cmd.setBlockProps(store, [b.id], { language: id }, "Code language");
  };
  return (
    <span className="bx2-code-lang" contentEditable={false}>
      <button type="button" className="bx2-code-lang-btn" disabled={!editable} aria-haspopup="listbox" onClick={() => setOpen((o) => !o)}>{name}</button>
      {open ? (
        <span className="bx2-menu bx2-code-menu" role="listbox" aria-label="Language">
          <input autoFocus className="bx2-link-input" aria-label="Search languages" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } else if (e.key === "Enter") { e.preventDefault(); pick(list[0]?.id); } }} onBlur={() => setTimeout(() => setOpen(false), 120)} />
          <button type="button" role="option" aria-selected={!cur} className="bx2-menu-item" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(undefined)}><span className="bx2-menu-text">Plain text</span></button>
          {list.slice(0, 40).map((l) => (
            <button key={l.id} type="button" role="option" aria-selected={cur === l.id} className="bx2-menu-item" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(l.id)}><span className="bx2-menu-text">{l.name}</span></button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function MermaidPreview({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const t = setTimeout(() => host.replaceChildren(mermaidPreview(code)), 250);
    return () => clearTimeout(t);
  }, [code]);
  return <div ref={ref} className="bx2-mermaid" contentEditable={false} data-embed="" />;
}

function labelOf(b: Block | undefined): string {
  if (!b) return "Block";
  return b.type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

// MARK: Textfeld

const atomRenderer = (props: PageEditorProps) => ({ pageTitle: (id: string) => props.pages?.get(id)?.title });

const TextField = memo(function TextField({ block }: { block: Block }) {
  const { ctrl, props, editable } = useCtx();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    ctrl.register(block.id, el);
    return () => ctrl.register(block.id, null);
  }, [ctrl, block.id]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || ctrl.composing === block.id) return;
    renderRich(el, block.text, atomRenderer(props));
    if (plainText(block.text).length === 0) el.setAttribute("data-empty", "");
    else el.removeAttribute("data-empty");
    ctrl.restore(block.id);
    if (block.type === "code") highlightCode(block.id, el, plainText(block.text), block.props?.language);
  }, [block.text, ctrl, block.id, props, block.type, block.props?.language]);
  useEffect(() => () => highlightCode(block.id, null, "", undefined), [block.id]);
  const cls = "bx2-field bx2-t-" + block.type + (block.type === "todo" && block.props?.checked ? " bx2-done" : "");
  return (
    <div ref={ref} className={cls} data-editable-id={block.id} contentEditable={editable} suppressContentEditableWarning
      spellCheck={block.type !== "code"} role="textbox" aria-multiline="true" aria-label={PLACEHOLDER[block.type] ?? "Text"}
      data-placeholder={PLACEHOLDER[block.type] ?? "Type '/' for commands"} writingsuggestions="false" />
  );
});

// MARK: Menüs

interface SlashState { id: string; at: number; query: string; index: number; x: number; y: number }

function SlashMenu({ items, state, onChoose, onHover }: { items: SlashItem[]; state: SlashState; onChoose: (i: SlashItem) => void; onHover: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.querySelector(`[data-index="${state.index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [state.index]);
  const top = Math.min(state.y, window.innerHeight - 340);
  let group = "";
  return (
    <div ref={ref} className="bx2-menu bx2-slash" role="listbox" aria-label="Blocks" data-testid="slash-menu" style={{ left: state.x, top }} onPointerDown={(e) => e.preventDefault()}>
      {items.map((it, i) => {
        const head = it.group !== group ? (group = it.group) : undefined;
        return (
          <div key={it.type + it.label}>
            {head ? <div className="bx2-menu-label">{head}</div> : null}
            <div role="option" aria-selected={i === state.index} data-index={i} className="bx2-menu-item" onMouseEnter={() => onHover(i)} onClick={() => onChoose(it)}>
              <span className="bx2-menu-icon" aria-hidden="true">{it.icon}</span>
              <span className="bx2-menu-text">{it.label}</span>
              {it.hint ? <span className="bx2-menu-hint">{it.hint}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BlockMenu({ id, x, y, onClose }: { id: string; x: number; y: number; onClose: () => void }) {
  const { store, ctrl, editable, props } = useCtx();
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"main" | "color">("main");
  useEffect(() => {
    const doc = ref.current?.ownerDocument;
    const off = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    doc?.addEventListener("pointerdown", off, true);
    doc?.addEventListener("keydown", key, true);
    return () => { doc?.removeEventListener("pointerdown", off, true); doc?.removeEventListener("keydown", key, true); };
  }, [onClose]);
  const ids = ctrl.isSelected(id) ? [...ctrl.selected] : [id];
  const b = store.blocks.get(id);
  const act = (f: () => void) => () => { f(); onClose(); };
  const turnable = ids.every((x) => cmd.isTextBlock(store.blocks.get(x)));
  const style = { left: x + 8, top: Math.min(y, window.innerHeight - 360) };
  if (view === "color") {
    const current = typeof b?.props?.color === "string" ? b.props.color : "default";
    const item = (c: string, label: string) => (
      <button key={c} type="button" role="menuitemradio" aria-checked={current === c} className="bx2-menu-item"
        onClick={act(() => cmd.setBlockProps(store, ids, { color: c === "default" ? undefined : c }, "Color"))}>
        <span className={"bx2-menu-icon bx2-swatch bx2-color-" + c} aria-hidden="true">A</span><span className="bx2-menu-text">{label}</span>
      </button>
    );
    return (
      <div ref={ref} className="bx2-menu bx2-blockmenu" role="menu" aria-label="Color" data-testid="block-menu" style={style}>
        <div className="bx2-menu-label">Text color</div>
        {BLOCK_COLORS.map((c) => item(c, c === "default" ? "Default" : c[0]!.toUpperCase() + c.slice(1)))}
        <div className="bx2-menu-sep" role="separator" />
        <div className="bx2-menu-label">Background</div>
        {BLOCK_COLORS.filter((c) => c !== "default").map((c) => item(c + "Background", c[0]!.toUpperCase() + c.slice(1) + " background"))}
      </div>
    );
  }
  const link = props.blockLink?.(id);
  return (
    <div ref={ref} className="bx2-menu bx2-blockmenu" role="menu" aria-label="Block" data-testid="block-menu" style={style}>
      <div className="bx2-menu-label">{labelOf(b)}</div>
      {b?.type === "databaseInline" && ids.length === 1 && props.onOpenPage ? (
        <button type="button" role="menuitem" className="bx2-menu-item" onClick={act(() => props.onOpenPage?.(id))}><span className="bx2-menu-text">Open as full page</span></button>
      ) : null}
      {link ? <button type="button" role="menuitem" className="bx2-menu-item" onClick={act(() => void navigator.clipboard?.writeText(link).catch(() => undefined))}><span className="bx2-menu-text">Copy link to block</span><span className="bx2-menu-hint">⌥⇧L</span></button> : null}
      {editable ? (
        <>
          <button type="button" role="menuitem" className="bx2-menu-item" onClick={act(() => { const f = cmd.deleteBlocks(store, ids); ctrl.clearSelection(); ctrl.apply(f); })}><span className="bx2-menu-text">Delete</span><span className="bx2-menu-hint">Del</span></button>
          <button type="button" role="menuitem" className="bx2-menu-item" onClick={act(() => ctrl.select(duplicate(store, ids)))}><span className="bx2-menu-text">Duplicate</span><span className="bx2-menu-hint">⌘D</span></button>
          <button type="button" role="menuitem" className="bx2-menu-item" onClick={act(() => { cmd.moveBlocksBy(store, ids, "up"); ctrl.select(ids); })}><span className="bx2-menu-text">Move up</span><span className="bx2-menu-hint">⌘⇧↑</span></button>
          <button type="button" role="menuitem" className="bx2-menu-item" onClick={act(() => { cmd.moveBlocksBy(store, ids, "down"); ctrl.select(ids); })}><span className="bx2-menu-text">Move down</span><span className="bx2-menu-hint">⌘⇧↓</span></button>
          <button type="button" role="menuitem" aria-haspopup="menu" className="bx2-menu-item" onClick={() => setView("color")}><span className="bx2-menu-text">Color</span><span className="bx2-menu-hint">›</span></button>
          {turnable ? (
            <>
              <div className="bx2-menu-sep" role="separator" />
              <div className="bx2-menu-label">Turn into</div>
              {SLASH_ITEMS.filter((s) => cmd.TEXT_TYPES.has(s.type) && !s.page).map((s) => (
                <button key={s.type + s.label} type="button" role="menuitemradio" aria-checked={b?.type === s.type} className="bx2-menu-item" onClick={act(() => cmd.turnInto(store, ids, s.type, s.props ?? {}))}>
                  <span className="bx2-menu-icon" aria-hidden="true">{s.icon}</span><span className="bx2-menu-text">{s.label}</span>
                </button>
              ))}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

const BLOCK_COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;

function FormatBar({ x, y, onMark, onColor }: { x: number; y: number; onMark: (m: "b" | "i" | "u" | "s" | "c") => void; onColor: (color: string | undefined) => void }) {
  const [colors, setColors] = useState(false);
  const items: { m: "b" | "i" | "u" | "s" | "c"; label: string; title: string }[] = [
    { m: "b", label: "B", title: "Bold (⌘B)" }, { m: "i", label: "I", title: "Italic (⌘I)" }, { m: "u", label: "U", title: "Underline (⌘U)" },
    { m: "s", label: "S", title: "Strikethrough (⌘⇧S)" }, { m: "c", label: "</>", title: "Code (⌘E)" },
  ];
  return (
    <div className="bx2-menu bx2-formatbar" role="toolbar" aria-label="Format" data-testid="format-bar" style={{ left: x, top: Math.max(8, y - 44) }} onPointerDown={(e) => e.preventDefault()}>
      {items.map((it) => <button key={it.m} type="button" className={"bx2-format-btn bx2-format-" + it.m} title={it.title} aria-label={it.title} onClick={() => onMark(it.m)}>{it.label}</button>)}
      <button type="button" className="bx2-format-btn" title="Text color" aria-label="Text color" aria-expanded={colors} onClick={() => setColors((c) => !c)}>A</button>
      {colors ? (
        <span className="bx2-menu bx2-color-menu" role="menu" aria-label="Text color">
          {BLOCK_COLORS.map((c) => (
            <button key={c} type="button" role="menuitem" className="bx2-menu-item" onClick={() => { setColors(false); onColor(c === "default" ? undefined : c); }}>
              <span className={"bx2-menu-icon bx2-swatch bx2-color-" + c} aria-hidden="true">A</span><span className="bx2-menu-text">{c === "default" ? "Default" : c[0]!.toUpperCase() + c.slice(1)}</span>
            </button>
          ))}
          {BLOCK_COLORS.filter((c) => c !== "default").map((c) => (
            <button key={c + "Background"} type="button" role="menuitem" className="bx2-menu-item" onClick={() => { setColors(false); onColor(c + "Background"); }}>
              <span className={"bx2-menu-icon bx2-swatch bx2-color-" + c + "Background"} aria-hidden="true">A</span><span className="bx2-menu-text">{c[0]!.toUpperCase() + c.slice(1)} background</span>
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}

type MentionItem = { kind: "page"; ref: PageRef } | { kind: "date"; label: string; date: Date };
interface MentionState { id: string; at: number; query: string; index: number; x: number; y: number; items: MentionItem[] }

function MentionMenu({ state, onChoose, onHover }: { state: MentionState; onChoose: (r: MentionItem) => void; onHover: (i: number) => void }) {
  const firstDate = state.items.findIndex((x) => x.kind === "date");
  return (
    <div className="bx2-menu bx2-slash" role="listbox" aria-label="Mention a page" data-testid="mention-menu" style={{ left: state.x, top: Math.min(state.y, window.innerHeight - 340) }} onPointerDown={(e) => e.preventDefault()}>
      {state.items.length && state.items[0]!.kind === "page" ? <div className="bx2-menu-label">Link to page</div> : null}
      {state.items.map((it, i) => (
        <Fragment key={it.kind === "page" ? it.ref.id : "d" + it.label}>
          {i === firstDate ? <div className="bx2-menu-label">Date</div> : null}
          {it.kind === "page" ? (
            <div role="option" aria-selected={i === state.index} className="bx2-menu-item" onMouseEnter={() => onHover(i)} onClick={() => onChoose(it)}>
              <span className="bx2-menu-icon" aria-hidden="true"><IconView icon={it.ref.icon} fallback="📄" /></span>
              <span className="bx2-menu-text">{it.ref.title || "Untitled"}</span>
              {it.ref.path ? <span className="bx2-menu-hint bx2-menu-path">{it.ref.path}</span> : null}
            </div>
          ) : (
            <div role="option" aria-selected={i === state.index} className="bx2-menu-item" onMouseEnter={() => onHover(i)} onClick={() => onChoose(it)}>
              <span className="bx2-menu-icon" aria-hidden="true">📅</span>
              <span className="bx2-menu-text">{it.label}</span>
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

function LinkPopover({ x, y, value, onDone }: { x: number; y: number; value: string; onDone: (v: string | undefined) => void }) {
  const [v, setV] = useState(value);
  return (
    <div className="bx2-menu bx2-link" role="dialog" aria-label="Link" data-testid="link-popover" style={{ left: x, top: Math.min(y, window.innerHeight - 80) }}>
      <input autoFocus className="bx2-link-input" placeholder="Paste or type a link" aria-label="Link" value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onDone(v); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDone(undefined); }
        }} onBlur={() => onDone(undefined)} />
      {value ? <button type="button" className="bx2-menu-item" onPointerDown={(e) => e.preventDefault()} onClick={() => onDone("")}><span className="bx2-menu-text">Remove link</span></button> : null}
    </div>
  );
}

// MARK: Hilfen

const R = (c: Caret): EditorTextRange => ({ blockId: c.id, from: c.from, to: c.to });
const textLen = (store: WorkspaceStore, id: string) => plainText(store.blocks.get(id)?.text).length;

function endCaret(store: WorkspaceStore, id: string): Caret {
  const n = textLen(store, id);
  return { id, from: n, to: n };
}
function clampCaret(store: WorkspaceStore, c: Caret): Caret {
  const n = textLen(store, c.id);
  return { id: c.id, from: Math.min(c.from, n), to: Math.min(c.to, n) };
}

/** Link im Bereich (für ⌘K: vorhandene URL vorbelegen). */
function linkIn(text: Block["text"], from: number, to: number): string | undefined {
  let pos = 0;
  for (const r of cmd.runsOf(text)) {
    const end = pos + r.t.length;
    if (end > from && pos < Math.max(to, from + 1) && typeof r.m.link === "string") return r.m.link;
    pos = end;
  }
  return undefined;
}

/** Duplizieren (⌘D) und die Kopien zurückgeben (zum Auswählen). */
function duplicate(store: WorkspaceStore, ids: readonly string[]): string[] {
  const roots = cmd.topLevel(store, ids);
  const last = roots[roots.length - 1];
  if (!last) return [];
  const parent = store.blocks.get(last)!.parent;
  const before = new Set(store.children(parent));
  cmd.duplicateBlocks(store, roots);
  return store.children(parent).filter((x) => !before.has(x));
}

// MARK: Zwischenablage

function markdownLine(b: Block, depth: number): string {
  const t = plainText(b.text);
  const pad = "  ".repeat(depth);
  switch (b.type) {
    case "heading1": return "# " + t;
    case "heading2": return "## " + t;
    case "heading3": return "### " + t;
    case "bulletedList": return pad + "- " + t;
    case "numberedList": return pad + "1. " + t;
    case "todo": return pad + (b.props?.checked ? "- [x] " : "- [ ] ") + t;
    case "quote": return "> " + t;
    case "code": return "```\n" + t + "\n```";
    case "divider": return "---";
    default: return pad + t;
  }
}

/** Blockauswahl kopieren: Based-intern (Records mit allem darin) und Markdown als Klartext. */
function writeBlocksClipboard(store: WorkspaceStore, ids: readonly string[], data: DataTransfer) {
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    const b = store.blocks.get(id);
    if (!b || b.trashedAt !== undefined) return;
    if (b.type !== "columnList" && b.type !== "column") lines.push(markdownLine(b, depth));
    for (const k of store.children("b:" + id)) walk(k, b.type === "columnList" || b.type === "column" ? depth : depth + 1);
  };
  const roots = cmd.topLevel(store, ids);
  for (const id of roots) walk(id, 0);
  data.setData("text/plain", lines.join("\n"));
  data.setData(cmd.BASED_CLIPBOARD_MIME, JSON.stringify(cmd.copyBlocks(store, roots)));
}

export type { ReactNode };
