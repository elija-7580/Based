// BSD-154: Das BlockNote-Schema von Based: Standardblöcke des Kerns (Überschriften 1–4, auch als Toggle) plus
// eigene Blöcke und Inline-Inhalte. Dazu der Konverter BlockNote ⇄ Y-XML für die Sitzungen.
import { BlockNoteEditor, BlockNoteSchema, createHeadingBlockSpec, defaultBlockSpecs, defaultInlineContentSpecs, defaultStyleSpecs } from "@blocknote/core";
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import type * as Y from "yjs";
import type { BNBlock } from "../mapping/bn.js";
import type { BlockConverter } from "../yjs/session.js";
import {
  breadcrumbBlock, buttonBlock, calloutBlock, columnBlock, columnListBlock, databaseBlock, embedBlock, equationBlock,
  linkToPageBlock, opaqueBlock, pageBlock, syncedBlock, tocBlock,
} from "./blocks.js";
import { inlineEquation, mentionInline } from "./inline.js";
import { meetingBlock } from "./meeting.js";

export function createBasedSchema() {
  const { audio, bulletListItem, checkListItem, codeBlock, divider, file, image, numberedListItem, paragraph, quote, table, toggleListItem, video } = defaultBlockSpecs;
  return BlockNoteSchema.create({
    blockSpecs: {
      paragraph, bulletListItem, numberedListItem, checkListItem, toggleListItem, quote, codeBlock, divider, table,
      image, video, audio, file,
      heading: createHeadingBlockSpec({ levels: [1, 2, 3, 4], allowToggleHeadings: true }),
      callout: calloutBlock(),
      equation: equationBlock(),
      page: pageBlock(),
      linkToPage: linkToPageBlock(),
      syncedBlock: syncedBlock(),
      database: databaseBlock(),
      embed: embedBlock(),
      toc: tocBlock(),
      breadcrumb: breadcrumbBlock(),
      button: buttonBlock(),
      columnList: columnListBlock(),
      column: columnBlock(),
      meeting: meetingBlock(),
      opaque: opaqueBlock(),
    },
    inlineContentSpecs: { ...defaultInlineContentSpecs, mention: mentionInline, inlineEquation },
    styleSpecs: defaultStyleSpecs,
  });
}

export type BasedSchema = ReturnType<typeof createBasedSchema>;
export type BasedEditor = BlockNoteEditor<BasedSchema["blockSchema"], BasedSchema["inlineContentSchema"], BasedSchema["styleSchema"]>;

let schema: BasedSchema | undefined;
export function basedSchema(): BasedSchema {
  return (schema ??= createBasedSchema());
}

/** Ein nicht eingebundener Editor nur für die Umwandlung (braucht das ProseMirror-Schema). */
export function createConverter(): BlockConverter {
  const editor = BlockNoteEditor.create({ schema: basedSchema() });
  return {
    toFragment(blocks: readonly BNBlock[], fragment: Y.XmlFragment) {
      blocksToYXmlFragment(editor, blocks as never, fragment);
    },
    fromFragment(fragment: Y.XmlFragment): BNBlock[] {
      return yXmlFragmentToBlocks(editor, fragment) as unknown as BNBlock[];
    },
  };
}

let converter: BlockConverter | undefined;
export function sharedConverter(): BlockConverter {
  return (converter ??= createConverter());
}
