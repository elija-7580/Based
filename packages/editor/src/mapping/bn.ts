// BSD-154: BlockNote-JSON so locker typisiert, wie das Mapping es braucht – die reinen Mapping-Funktionen
// hängen nicht an den Generics des Editors (und nicht an React).

export type BNStyles = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  textColor?: string;
  backgroundColor?: string;
};
export type BNText = { type: "text"; text: string; styles: BNStyles };
export type BNLink = { type: "link"; href: string; content: BNText[] };
export type BNCustomInline = { type: string; props: Record<string, unknown>; content?: unknown };
export type BNInline = BNText | BNLink | BNCustomInline;

export type BNTableCell = { type: "tableCell"; props: Record<string, unknown>; content: BNInline[] };
export type BNTableContent = {
  type: "tableContent";
  columnWidths: (number | undefined | null)[];
  headerRows?: number;
  headerCols?: number;
  rows: { cells: (BNTableCell | BNInline[])[] }[];
};

export interface BNBlock {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: unknown;
  children: BNBlock[];
}

/** Eigene Blocktypen (Namen im BlockNote-Schema). */
export const CUSTOM = {
  callout: "callout",
  equation: "equation",
  page: "page",
  linkToPage: "linkToPage",
  syncedBlock: "syncedBlock",
  database: "database",
  embed: "embed",
  toc: "toc",
  breadcrumb: "breadcrumb",
  button: "button",
  columnList: "columnList",
  column: "column",
  meeting: "meeting",
  opaque: "opaque",
} as const;

/** Eigene Inline-Inhalte. */
export const INLINE = { mention: "mention", equation: "inlineEquation" } as const;

/** Präfix für Dateien aus dem Asset-Speicher in `url`-Props der Medienblöcke. */
export const ASSET_URL_PREFIX = "based-asset:";
/** „Copy and sync“ legt das in die Zwischenablage (wie Swift `SyncedBlockClipboard`). */
export const SYNC_CLIPBOARD_PREFIX = "based-sync:";

export function syncSourceFromClipboard(text: string): string | undefined {
  const s = text.trim();
  if (!s.startsWith(SYNC_CLIPBOARD_PREFIX)) return undefined;
  const id = s.slice(SYNC_CLIPBOARD_PREFIX.length);
  return id.length > 0 && !/\s/.test(id) ? id : undefined;
}
