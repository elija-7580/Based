// Einfügen: HTML geht an BlockNote (BSD-176, hat Vorrang), reiner Text, der wie Markdown aussieht, durch den
// Markdown-Parser aus @based/core, alles andere bleibt Klartext. „Paste as plain text“ (⇧⌘V) ist immer Klartext.
// Ein Einfügen = eine ProseMirror-Transaktion = ein Undo-Schritt.
import { pasteKind } from "@based/core";
import type { BasedEditor } from "../schema/schema.js";
import { markdownToBlocks, singleParagraph } from "../mapping/imported.js";

interface PasteArgs {
  event: ClipboardEvent;
  defaultPasteHandler: (context?: { prioritizeMarkdownOverHTML?: boolean; plainTextAsMarkdown?: boolean }) => boolean | undefined;
  /** Die letzte Taste war ⇧⌘V / Ctrl+Shift+V. */
  plainOnly: boolean;
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
  const blocks = markdownToBlocks(markdown);
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
  if (kind === "html") return args.defaultPasteHandler({ prioritizeMarkdownOverHTML: false, plainTextAsMarkdown: false }) ?? false;
  if (kind === "markdown" && insertMarkdown(editor, text)) return true;
  if (text === "") return true;
  closeHistory(editor);
  editor.pasteText(text);
  return true;
}
