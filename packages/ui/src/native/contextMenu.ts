// Rechtsklick überall: nie das Systemmenü, immer ein Based-Menü. Bausteine mit eigenem Menü (Seitenleiste, Zeilen
// einer Datenbank) rufen wie bisher preventDefault() und zeigen ihres; alles andere bekommt hier Text- und
// Link-Einträge plus das, was die App für die Stelle anmeldet (registerContextItems).
import { showMenu } from "./menu.js";
import { closeLayers } from "./layer.js";
import { textActions, tidyEntries, type MenuEntry, type TextAction } from "./logic.js";

export interface ContextInfo {
  target: Element;
  /** Feld bzw. bearbeitbarer Bereich unter dem Zeiger. */
  editable: HTMLElement | null;
  selection: string;
  link: HTMLAnchorElement | null;
}

export interface ClipboardAccess {
  /** Text (und, wenn vorhanden, HTML) der Zwischenablage – ohne Systemrückfrage. */
  read: () => Promise<{ text: string; html?: string }>;
  write: (text: string) => Promise<void>;
}

export interface ContextMenuOptions {
  clipboard?: ClipboardAccess;
  /** Icons der App für die Menüeinträge (Name → SVG). */
  icon?: (name: string) => Element | undefined;
  /** Für Entwickler: liefert `true`, wenn ausnahmsweise das Systemmenü kommen darf (Web-Inspektor). */
  allowNative?: (e: MouseEvent) => boolean;
}

type Provider = (info: ContextInfo) => MenuEntry[];
const providers = new Set<Provider>();

/** Einträge für das Kontextmenü anmelden (unter den Text-Einträgen). Liefert die Funktion zum Abmelden. */
export function registerContextItems(provider: Provider): () => void {
  providers.add(provider);
  return () => { providers.delete(provider); };
}

const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number", ""]);
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
const mod = (key: string) => (mac ? `⌘${key}` : `Ctrl+${key}`);
const LABELS: Record<TextAction, [string, string, string?]> = {
  openLink: ["Open link", "expand"], copyLink: ["Copy link", "link"], cut: ["Cut", "cut", mod("X")], copy: ["Copy", "duplicate", mod("C")],
  paste: ["Paste", "paste", mod("V")], selectAll: ["Select all", "selectAll", mod("A")],
};

function editableOf(target: Element): HTMLElement | null {
  const field = target.closest<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  if (field) return field instanceof HTMLTextAreaElement || TEXT_INPUTS.has(field.getAttribute("type")?.toLowerCase() ?? "") ? field : null;
  const rich = target.closest<HTMLElement>("[contenteditable]");
  return rich?.isContentEditable ? rich : null;
}

function selectionIn(editable: HTMLElement | null): string {
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    try { return editable.value.slice(editable.selectionStart ?? 0, editable.selectionEnd ?? 0); } catch { return ""; }
  }
  return document.getSelection()?.toString() ?? "";
}

const defaultClipboard: ClipboardAccess = {
  async read() {
    try {
      const items = await navigator.clipboard.read();
      let text = "", html: string | undefined;
      for (const item of items) {
        if (item.types.includes("text/plain")) text ||= await (await item.getType("text/plain")).text();
        if (item.types.includes("text/html")) html ??= await (await item.getType("text/html")).text();
      }
      return html === undefined ? { text } : { text, html };
    } catch {
      return { text: await navigator.clipboard.readText() };
    }
  },
  write: (text) => navigator.clipboard.writeText(text),
};

/** Fügt ein wie ⌘V: erst als paste-Ereignis (der Editor liest Text und HTML selbst), sonst als getippter Text. */
export async function pasteInto(editable: HTMLElement, clipboard: ClipboardAccess): Promise<void> {
  let data: { text: string; html?: string };
  try { data = await clipboard.read(); } catch { return; }
  if (!data.text && !data.html) return;
  if (!editable.isConnected) return;
  if (document.activeElement !== editable && !editable.contains(document.activeElement)) editable.focus({ preventScroll: true });
  let handled = false;
  try {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", data.text);
    if (data.html) transfer.setData("text/html", data.html);
    const ev = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
    if (ev.clipboardData) handled = !(document.activeElement ?? editable).dispatchEvent(ev);
  } catch { /* kein ClipboardEvent mit Daten: unten als Text einfügen */ }
  if (!handled && data.text) document.execCommand("insertText", false, data.text);
}

function selectAll(editable: HTMLElement) {
  editable.focus({ preventScroll: true });
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) editable.select();
  else document.execCommand("selectAll");
}

export function contextEntries(info: ContextInfo, clipboard: ClipboardAccess): MenuEntry[] {
  const e = info.editable;
  const field = e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? e : null;
  const actions = textActions({
    editable: e !== null, secret: field instanceof HTMLInputElement && field.type === "password", readOnly: field?.readOnly === true || field?.disabled === true,
    hasSelection: info.selection.length > 0, link: info.link !== null,
  });
  const run: Record<TextAction, () => void> = {
    openLink: () => info.link?.click(),
    copyLink: () => void clipboard.write(info.link?.href ?? "").catch(() => undefined),
    cut: () => document.execCommand("cut"),
    copy: () => document.execCommand("copy"),
    paste: () => { if (e) void pasteInto(e, clipboard); },
    selectAll: () => { if (e) selectAll(e); },
  };
  const entries: MenuEntry[] = actions.map((a) => {
    if (a.id === "-") return { separator: true };
    const [label, icon, hint] = LABELS[a.id];
    return { label, icon, ...(hint ? { hint } : {}), ...(a.disabled ? { disabled: true } : {}), run: run[a.id] };
  });
  for (const p of providers) {
    const extra = p(info);
    if (extra.length) entries.push({ separator: true }, ...extra);
  }
  return tidyEntries(entries);
}

/** Ersetzt das Systemmenü im ganzen Fenster. Liefert die Funktion zum Abbauen. */
export function installContextMenu(opts: ContextMenuOptions = {}, target: Window = window): () => void {
  const clipboard = opts.clipboard ?? defaultClipboard;
  const onMenu = (e: MouseEvent) => {
    if (opts.allowNative?.(e)) return;
    // Ein Baustein hat sein eigenes Menü geöffnet (preventDefault): nichts weiter.
    if (e.defaultPrevented) return;
    e.preventDefault();
    closeLayers();
    const el = e.target instanceof Element ? e.target : e.target instanceof Node ? e.target.parentElement : null;
    if (!el) return;
    const editable = editableOf(el);
    const info: ContextInfo = { target: el, editable, selection: selectionIn(editable), link: el.closest<HTMLAnchorElement>("a[href]") };
    const entries = contextEntries(info, clipboard);
    if (entries.length) showMenu(entries, { x: e.clientX, y: e.clientY }, { label: "Context menu", scrollWith: el });
  };
  target.addEventListener("contextmenu", onMenu);
  return () => target.removeEventListener("contextmenu", onMenu);
}
