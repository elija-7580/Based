// Eingefügtes Markdown: Blöcke aus dem Parser (@based/core MarkdownImporter) → BlockNote-Blöcke. Der Weg geht über
// dieselbe Projektion wie beim Öffnen einer Seite (Records → BlockNote), damit eingefügte Blöcke genauso aussehen
// wie gespeicherte. Rein, ohne Editor.
import { MarkdownImporter, toRichText, type Block, type ImportedBlock } from "@based/core";
import type { BNBlock } from "./bn.js";
import { projectDoc, type BlockSource } from "./blocks.js";

const ROOT = "paste-root";

/** Parser-Blöcke als BlockNote-Blöcke mit neuen IDs. */
export function importedToBlocks(blocks: readonly ImportedBlock[], newID: () => string = () => globalThis.crypto.randomUUID()): BNBlock[] {
  const records = new Map<string, Block>();
  const kids = new Map<string, string[]>();
  const add = (list: readonly ImportedBlock[], parent: string) => {
    list.forEach((b, i) => {
      const id = newID();
      const rec: Block = { id, type: b.type, parent, sk: String(i).padStart(6, "0"), createdAt: 0, updatedAt: 0 };
      const text = toRichText(b.text);
      if (text !== "") rec.text = text;
      const props = { ...b.props };
      // Der Parser nennt Code ohne Sprache „plain text“; im Record heißt das: keine Sprache.
      if (b.type === "code" && props.language === "plain text") delete props.language;
      if (Object.keys(props).length > 0) rec.props = props;
      records.set(id, rec);
      (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(id);
      add(b.children, "b:" + id);
    });
  };
  add(blocks, "b:" + ROOT);
  const src: BlockSource = { blocks: records, children: (parent) => kids.get(parent) ?? [] };
  return projectDoc(src, ROOT);
}

/** Markdown-Text → BlockNote-Blöcke (großzügiger Parser, siehe `MarkdownImporterOptions.lenient`). */
export function markdownToBlocks(markdown: string, newID?: () => string): BNBlock[] {
  const text = markdown.replace(/^\n+|\s+$/g, "");
  return importedToBlocks(new MarkdownImporter({ lenient: true }).parse(text), newID);
}

/** Ein einzelner Absatz ohne Kinder: der wird an der Schreibmarke als Text eingefügt, nicht als neuer Block. */
export function singleParagraph(blocks: readonly BNBlock[]): BNBlock | undefined {
  const b = blocks[0];
  return blocks.length === 1 && b && b.type === "paragraph" && b.children.length === 0 ? b : undefined;
}
