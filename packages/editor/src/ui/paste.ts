// Einfügen: HTML geht an BlockNote (BSD-176, hat Vorrang), reiner Text, der wie Markdown aussieht, durch den
// Markdown-Parser aus @based/core, alles andere bleibt Klartext. „Paste as plain text“ (⇧⌘V) ist immer Klartext.
// Ein Einfügen = eine ProseMirror-Transaktion = ein Undo-Schritt.
import { ClipboardHTMLImporter, pasteKind } from "@based/core";
import type { BasedEditor } from "../schema/schema.js";
import type { BNBlock } from "../mapping/bn.js";
import { importedToBlocks, markdownToBlocks, singleParagraph } from "../mapping/imported.js";

/** Eine einzelne Web-Adresse (nichts sonst)? Dann bietet der Editor Link / Bookmark / Embed an. */
export function singleURL(text: string): string | undefined {
  const t = text.trim();
  if (!/^https?:\/\/[^\s<>"]+$/i.test(t)) return undefined;
  try {
    return new URL(t).protocol.startsWith("http") ? t : undefined;
  } catch {
    return undefined;
  }
}

interface PasteArgs {
  event: ClipboardEvent;
  defaultPasteHandler: (context?: { prioritizeMarkdownOverHTML?: boolean; plainTextAsMarkdown?: boolean }) => boolean | undefined;
  /** Die letzte Taste war ⇧⌘V / Ctrl+Shift+V. */
  plainOnly: boolean;
  /** Eine nackte URL wurde als Link in einen leeren Absatz eingefügt: Auswahl Link/Bookmark/Embed anbieten. */
  onURL?: (blockID: string, url: string) => void;
  /** Gibt es diese Seite? (Notion-/Based-Links werden dann zur Erwähnung.) */
  pageExists?: (id: string) => boolean;
}

/** Den Undo-Verlauf vor dem Einfügen abschließen (sonst verschmilzt es mit dem Tippen davor). */
function closeHistory(editor: BasedEditor) {
  try {
    const view = editor.prosemirrorView;
    view?.dispatch(view.state.tr.setMeta("closeHistory$", true).setMeta("addToHistory", false));
  } catch { /* ohne Ansicht: nichts abzuschließen */ }
}

function inCodeOrTable(editor: BasedEditor): boolean {
  try {
    const type = editor.getTextCursorPosition().block.type;
    return type === "codeBlock" || type === "table";
  } catch {
    return false;
  }
}

/** Markdown-Text an der Schreibmarke einfügen. Gibt `false` zurück, wenn nichts Einfügbares herauskam. */
export function insertMarkdown(editor: BasedEditor, markdown: string): boolean {
  return insertParsed(editor, markdownToBlocks(markdown));
}

/**
 * BSD-211: HTML aus Notion, Google Docs und dem Web über den Kern-Importer (ClipboardHTMLImporter, Swift-Fixtures):
 * Farben, Callouts, To-dos, Toggles, Tabellen, Code mit Sprache, Notion-Links als Seiten-Erwähnung.
 */
export function htmlToBlocks(html: string, pageExists: (id: string) => boolean = () => false, newID?: () => string): BNBlock[] {
  return importedToBlocks(new ClipboardHTMLImporter(ClipboardHTMLImporter.pageResolver(pageExists)).parse(html), newID);
}

/** Geparste Blöcke an der Schreibmarke einfügen (ein Undo-Schritt). `false`, wenn nichts herauskam. */
export function insertParsed(editor: BasedEditor, blocks: BNBlock[]): boolean {
  if (blocks.length === 0) return false;
  closeHistory(editor);
  const inline = singleParagraph(blocks);
  editor.transact((tr) => {
    if (inline) {
      // Eine Zeile mit Inline-Markdown: als formatierter Text an der Schreibmarke (ersetzt die Auswahl).
      editor.insertInlineContent(inline.content as never, { updateSelection: true });
      return;
    }
    if (!tr.selection.empty) tr.deleteSelection();
    const cur = editor.getTextCursorPosition().block;
    const empty = cur.type === "paragraph" && Array.isArray(cur.content) && cur.content.length === 0 && cur.children.length === 0;
    const inserted = empty ? editor.replaceBlocks([cur], blocks as never).insertedBlocks : editor.insertBlocks(blocks as never, cur, "after");
    // Schreibmarke ans Ende des Eingefügten (Blöcke ohne Text, z. B. Trenner, können keine tragen).
    for (let i = inserted.length - 1; i >= 0; i--) {
      try {
        editor.setTextCursorPosition(inserted[i]!.id, "end");
        break;
      } catch { /* nächster Kandidat */ }
    }
  });
  closeHistory(editor);
  return true;
}

/** Der Einfüge-Handler des Editors (ohne Synced-Verweise, die prüft PageEditor vorher). */
export function handlePaste(editor: BasedEditor, args: PasteArgs): boolean {
  const data = args.event.clipboardData;
  if (!data) return args.defaultPasteHandler() ?? false;
  const types = [...data.types];
  // Eigenes Format, Dateien und VS Code behandelt BlockNote.
  if (!args.plainOnly && (types.includes("blocknote/html") || types.includes("Files") || types.includes("vscode-editor-data"))) {
    return args.defaultPasteHandler({ prioritizeMarkdownOverHTML: false, plainTextAsMarkdown: false }) ?? false;
  }
  const text = data.getData("text/plain");
  const html = types.includes("text/html") ? data.getData("text/html") : "";
  const kind = pasteKind({ html, text, plainOnly: args.plainOnly, inCode: inCodeOrTable(editor) });
  if (kind === "html") {
    if (ClipboardHTMLImporter.isStructured(html) && !inCodeOrTable(editor)) {
      try {
        if (insertParsed(editor, htmlToBlocks(html, args.pageExists))) return true;
      } catch { /* unten: BlockNote */ }
    }
    return args.defaultPasteHandler({ prioritizeMarkdownOverHTML: false, plainTextAsMarkdown: false }) ?? false;
  }
  if (kind === "markdown" && insertMarkdown(editor, text)) return true;
  if (text === "") return true;
  const url = !args.plainOnly && args.onURL && kind === "plain" ? singleURL(text) : undefined;
  if (url) {
    const cur = editor.getTextCursorPosition().block;
    const empty = cur.type === "paragraph" && Array.isArray(cur.content) && cur.content.length === 0;
    if (empty) {
      closeHistory(editor);
      editor.insertInlineContent([{ type: "link", href: url, content: url }] as never, { updateSelection: true });
      args.onURL?.(cur.id, url);
      return true;
    }
  }
  closeHistory(editor);
  editor.pasteText(text);
  return true;
}
