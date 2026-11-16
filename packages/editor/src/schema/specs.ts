// BSD-154 / BSD-407 Teil 4b: Eigene Blocktypen und Inline-Inhalte des BlockNote-Schemas – nur noch für den kopflosen
// Konverter Y-XML ⇄ Blöcke (alte `page:`-Dokumente des Servers). Gezeichnet wird mit dem Block-Editor (ADR 0016); die
// Darstellung hier ist ein schlichter Platzhalter ohne React (@blocknote/react ist weg). Typnamen, Eigenschaften und
// Inhaltsart bestimmen das Y-XML und dürfen sich nicht ändern (test/converter-golden.test.ts).
import { createBlockSpec, createInlineContentSpec, defaultProps } from "@blocknote/core";
import { CUSTOM, INLINE } from "../mapping/bn.js";

const colorProps = { textColor: defaultProps.textColor, backgroundColor: defaultProps.backgroundColor };

/** Platzhalter-DOM: der Typname als Datenattribut, sonst leer (es wird nie etwas angezeigt). */
function atomDOM(type: string): { dom: HTMLElement } {
  const dom = document.createElement("div");
  dom.dataset.basedBlock = type;
  return { dom };
}

function atomSpec<const T extends string, const P extends Record<string, { default: string | number }>>(type: T, propSchema: P) {
  return createBlockSpec({ type, propSchema, content: "none" }, { render: () => atomDOM(type) });
}

export const calloutBlock = createBlockSpec(
  { type: CUSTOM.callout, propSchema: { ...colorProps, icon: { default: "" } }, content: "inline" },
  {
    render: () => {
      const { dom } = atomDOM(CUSTOM.callout);
      const contentDOM = document.createElement("div");
      dom.append(contentDOM);
      return { dom, contentDOM };
    },
  },
);
export const equationBlock = atomSpec(CUSTOM.equation, { expression: { default: "" } });
export const pageBlock = atomSpec(CUSTOM.page, { variant: { default: "page" } });
export const linkToPageBlock = atomSpec(CUSTOM.linkToPage, { target: { default: "" } });
export const syncedBlock = atomSpec(CUSTOM.syncedBlock, { source: { default: "" } });
export const databaseBlock = atomSpec(CUSTOM.database, { databaseID: { default: "" }, viewID: { default: "" } });
export const embedBlock = atomSpec(CUSTOM.embed, { kind: { default: "embed" }, url: { default: "" }, meta: { default: "" } });
export const tocBlock = atomSpec(CUSTOM.toc, {});
export const breadcrumbBlock = atomSpec(CUSTOM.breadcrumb, {});
export const buttonBlock = atomSpec(CUSTOM.button, {});
export const columnListBlock = atomSpec(CUSTOM.columnList, {});
export const columnBlock = atomSpec(CUSTOM.column, { width: { default: 0 } });
export const meetingBlock = atomSpec(CUSTOM.meeting, {});
export const opaqueBlock = atomSpec(CUSTOM.opaque, { blockType: { default: "" }, raw: { default: "{}" } });

function inlineDOM(type: string): { dom: HTMLElement } {
  const dom = document.createElement("span");
  dom.dataset.basedInline = type;
  return { dom };
}

export const mentionInline = createInlineContentSpec(
  { type: INLINE.mention, propSchema: { kind: { default: "page" }, value: { default: "" }, text: { default: "" } }, content: "none" },
  { render: () => inlineDOM(INLINE.mention) },
);
export const inlineEquation = createInlineContentSpec(
  { type: INLINE.equation, propSchema: { expression: { default: "" }, text: { default: "" } }, content: "none" },
  { render: () => inlineDOM(INLINE.equation) },
);
