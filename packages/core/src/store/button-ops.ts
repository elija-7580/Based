// BSD-210: Button-Block (Notion „When button is clicked → Do: …“), portiert aus Swift Store/ButtonOps.swift.
// Die Schritte laufen der Reihe nach; Änderungen am Store passieren hier (jeder Schritt ein eigener Undo-Schritt),
// was die Oberfläche tun muss (öffnen, Link, Schreibmarke), kommt als Effekt zurück. Ein `confirm`-Schritt hält an.
import type { Block, BlockProps } from "../model/records.js";
import { plainText } from "../richtext.js";
import { addRow } from "./database-ops.js";
import { copyTree, sortKeys } from "./pages.js";
import type { WorkspaceStore } from "./store.js";

export type ButtonAction = NonNullable<BlockProps["buttonActions"]>[number];
export type ButtonActionKind = "insertBlocks" | "addPage" | "openPage" | "openAdded" | "openURL" | "confirm";
export type OpenMode = "centerPeek" | "fullPage" | "sidePeek";

/** Bekannte Schritt-Arten in der Reihenfolge der Auswahl (Swift `ButtonAction.Kind.allCases`). */
export const BUTTON_ACTION_KINDS: readonly ButtonActionKind[] = ["insertBlocks", "addPage", "openPage", "openAdded", "openURL", "confirm"];

/** Anzeigename einer Schritt-Art (Swift `displayName`); unbekannte (BSD-130) brauchen eine neuere Version. */
export function buttonActionName(kind: string): string {
  switch (kind) {
    case "insertBlocks": return "Insert blocks";
    case "addPage": return "Add page to";
    case "openPage": return "Open page";
    case "openAdded": return "Open added page";
    case "openURL": return "Open link";
    case "confirm": return "Show confirmation";
  }
  return "Needs a newer version";
}

export const isKnownButtonAction = (kind: string): kind is ButtonActionKind => (BUTTON_ACTION_KINDS as readonly string[]).includes(kind);

/**
 * Die Schritte eines Buttons. Buttons von vor den Schritten haben eine `buttonAction`; „Add page“ öffnete die neue
 * Seite im Center Peek, außer `openAfter` war aus – das wird ein ausdrücklicher zweiter Schritt.
 */
export function effectiveButtonActions(props: BlockProps | undefined): ButtonAction[] {
  if (props?.buttonActions) return props.buttonActions;
  const a: ButtonAction = props?.buttonAction ?? { kind: "insertBlocks" };
  if (a.kind === "addPage" && (a.openAfter ?? true)) {
    const add = { ...a };
    delete add.openAfter;
    return [add, { kind: "openAdded", mode: "centerPeek", step: 0 }];
  }
  return [a];
}

/** Was die Oberfläche nach den Store-Schritten tun muss. */
export type ButtonEffect =
  | { kind: "open"; id: string; mode?: OpenMode | undefined }
  | { kind: "openURL"; url: string }
  /** Schreibmarke ans Ende dieses Blocks (des zuletzt eingefügten). */
  | { kind: "focusEnd"; id: string }
  /** Ein Schritt ging nicht (Datenbank/Seite/Blöcke fehlen): der Button-Editor soll aufgehen. */
  | { kind: "needsSetup" };

/** Wo ein Button zum Nachfragen anhielt (`confirm`): `message` zeigen, bei OK mit `next` weiter. */
export interface ButtonPause {
  message: string;
  next: number;
  /** Bisher angelegte Seiten je Schritt-Index (für spätere `openAdded`). */
  added: Record<number, string>;
}

export interface RunButtonOptions {
  from?: number;
  added?: Record<number, string>;
  /**
   * Gibt es die Seite (für `openPage`)? Standard: der Store kennt sie. Seiten-Repliken kennen fremde Seiten nicht und
   * fragen das Seitenverzeichnis.
   */
  pageExists?: (id: string) => boolean;
}

/** Führt die Schritte eines Buttons ab `from` aus (Swift `runButton`). */
export function runButton(store: WorkspaceStore, id: string, opts: RunButtonOptions = {}): { effects: ButtonEffect[]; pause?: ButtonPause } {
  const button = store.blocks.get(id);
  if (!button) return { effects: [] };
  const steps = effectiveButtonActions(button.props);
  const effects: ButtonEffect[] = [];
  const added: Record<number, string> = { ...(opts.added ?? {}) };
  const addedKeys = () => Object.keys(added).map(Number);
  let lastAdded: string | undefined = addedKeys().length ? added[Math.max(...addedKeys())] : undefined;
  const pageExists = opts.pageExists ?? ((p: string) => store.blocks.has(p));
  for (let i = opts.from ?? 0; i < steps.length; i++) {
    const a = steps[i]!;
    switch (a.kind as string) {
      case "confirm": {
        const msg = (a.message ?? "").trim();
        return { effects, pause: { message: msg === "" ? "Are you sure?" : msg, next: i + 1, added } };
      }
      case "insertBlocks": {
        const kids = contentBlocks(store, id);
        if (kids.length === 0) {
          effects.push({ kind: "needsSetup" });
          break;
        }
        const last = store.transact("Insert from button", (tx) => {
          const keys = sortKeys(store, button.parent, { kind: "after", id }, kids.length);
          let out = id;
          kids.forEach((k, n) => (out = copyTree(store, tx, k, button.parent, keys[n]!)));
          return out;
        });
        effects.push({ kind: "focusEnd", id: last });
        break;
      }
      case "addPage": {
        const db = a.targetID;
        if (!db || !store.databases.has(db)) {
          effects.push({ kind: "needsSetup" });
          break;
        }
        const row = addRow(store, db, { title: a.title ?? "", values: a.values ?? {} });
        if (!row) {
          effects.push({ kind: "needsSetup" });
          break;
        }
        added[i] = row;
        lastAdded = row;
        if (steps.length === 1 && a.openAfter === true) effects.push({ kind: "open", id: row, mode: "centerPeek" });
        break;
      }
      case "openPage": {
        const t = a.targetID;
        if (!t || !pageExists(t)) effects.push({ kind: "needsSetup" });
        else effects.push({ kind: "open", id: t, mode: a.mode as OpenMode | undefined });
        break;
      }
      case "openAdded": {
        const target = (a.step !== undefined ? added[a.step] : undefined) ?? lastAdded;
        if (target) effects.push({ kind: "open", id: target, mode: a.mode as OpenMode | undefined });
        break;
      }
      case "openURL": {
        const u = a.url?.trim();
        if (!u) effects.push({ kind: "needsSetup" });
        else effects.push({ kind: "openURL", url: u });
        break;
      }
      default:
        break; // BSD-130: ein Schritt aus einer neueren Version wird übersprungen (und unverändert zurückgeschrieben)
    }
  }
  return { effects };
}

/** Die Vorlage eines Buttons: seine Kinder ohne Papierkorb (Swift `contentBlocks`). */
export function contentBlocks(store: WorkspaceStore, id: string): Block[] {
  return store.children("b:" + id).map((k) => store.blocks.get(k)).filter((b): b is Block => b !== undefined && b.trashedAt === undefined);
}

/** Beschriftung und Schritte setzen (ein Undo-Schritt; Tippen in der Beschriftung fasst `coalesce` zusammen). */
export function setButton(store: WorkspaceStore, id: string, patch: { label?: string; actions?: ButtonAction[] }, coalesce?: string) {
  if (!store.blocks.has(id)) return;
  store.transact("Edit button", (tx) => tx.update(id, (b) => {
    const p: BlockProps = { ...(b.props ?? {}) };
    if (patch.label !== undefined) {
      if (patch.label === "") delete p.buttonLabel;
      else p.buttonLabel = patch.label;
    }
    if (patch.actions !== undefined) {
      p.buttonActions = patch.actions;
      delete p.buttonAction; // ersetzt durch die Schritte (Swift liest `buttonAction` nur, solange es keine gibt)
    }
    b.props = p;
  }), coalesce ? { coalesce } : {});
}

/** Beschriftung, wie der Block sie zeigt. */
export const buttonLabel = (b: Block | undefined): string => {
  const l = b?.props?.buttonLabel?.trim();
  return l ? l : "Button";
};

/** Kurzer Text eines Schritts für die Liste im Button-Editor („Add page to Tasks“). */
export function describeButtonAction(store: WorkspaceStore, a: ButtonAction): string {
  const name = buttonActionName(a.kind);
  switch (a.kind as string) {
    case "addPage": {
      const db = a.targetID ? store.databases.get(a.targetID) : undefined;
      return db ? `${name} ${plainText(db.title) || "Untitled"}` : name;
    }
    case "openURL": return a.url ? `${name} ${a.url}` : name;
    case "confirm": return a.message ? `${name}: ${a.message}` : name;
  }
  return name;
}
