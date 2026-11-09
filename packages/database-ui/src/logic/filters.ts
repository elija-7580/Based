// BSD-155: Filter bearbeiten und beschreiben (rein, ohne React). Pfade adressieren Bedingungen in
// verschachtelten Gruppen: [2] = drittes Element der Wurzel, [2, 0] = erstes Element der Gruppe an 2.
import {
  FILTER_OP_LABELS, RELATIVE_DATE_LABELS, filterOps, formatDateCell, propertyOf, titleOf,
  type Database, type FilterCondition, type FilterGroup, type FilterItem, type PropertySchema, type WorkspaceStore,
} from "@based/core";

export type Path = number[];
type Case = [string, unknown];
const caseOf = (v: unknown): Case | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const k = Object.keys(v);
  if (k.length !== 1) return undefined;
  const inner = (v as Record<string, unknown>)[k[0]!];
  return [k[0]!, inner && typeof inner === "object" && "_0" in inner ? (inner as { _0: unknown })._0 : undefined];
};

export const isCondition = (item: FilterItem): item is { condition: { _0: FilterCondition } } => caseOf(item)?.[0] === "condition";
export const isGroup = (item: FilterItem): item is { group: { _0: FilterGroup } } => caseOf(item)?.[0] === "group";
export const conditionOf = (item: FilterItem) => (isCondition(item) ? item.condition._0 : undefined);
export const groupOf = (item: FilterItem) => (isGroup(item) ? item.group._0 : undefined);
export const conditionItem = (c: FilterCondition): FilterItem => ({ condition: { _0: c } });
export const groupItem = (g: FilterGroup): FilterItem => ({ group: { _0: g } });
export const EMPTY_FILTER: FilterGroup = { combinator: "and", items: [] };

const newID = () => globalThis.crypto.randomUUID().toLowerCase();

/** Art des Wertfelds einer Bedingung. */
export type ValueKind = "none" | "text" | "number" | "checkbox" | "date" | "options" | "people" | "relation";

export function valueKind(p: PropertySchema | undefined, op: string, resultType?: string): ValueKind {
  if (!p || op === "isEmpty" || op === "isNotEmpty") return "none";
  const t = p.type === "formula" || p.type === "rollup" ? ({ number: "number", date: "date", boolean: "checkbox" } as Record<string, string>)[resultType ?? ""] ?? "text" : p.type;
  switch (t) {
    case "select": case "status": case "multiSelect": return "options";
    case "checkbox": return "checkbox";
    case "number": case "uniqueID": return "number";
    case "date": case "createdTime": case "lastEditedTime": return "date";
    case "person": case "createdBy": case "lastEditedBy": return "people";
    case "relation": return "relation";
    default: return "text";
  }
}

/** Neue Bedingung für eine Property: erster passender Operator, Wert noch leer (filtert dann nichts). */
export function newCondition(p: PropertySchema, resultType?: string): FilterCondition {
  const op = filterOps(p.type, resultType)[0] ?? "isNotEmpty";
  const c: FilterCondition = { id: newID(), propertyID: p.id, op };
  if (valueKind(p, op, resultType) === "checkbox") c.value = { bool: { _0: true } };
  return c;
}

export function itemAt(g: FilterGroup, path: Path): FilterItem | undefined {
  let cur: FilterGroup | undefined = g;
  for (let i = 0; i < path.length - 1; i++) cur = cur && groupOf(cur.items[path[i]!]!);
  return cur?.items[path[path.length - 1]!];
}

/** Gruppe an `path` (leerer Pfad = Wurzel) mit `f` verändern; gibt eine neue Wurzel zurück. */
export function updateGroup(root: FilterGroup, path: Path, f: (g: FilterGroup) => FilterGroup): FilterGroup {
  if (path.length === 0) return f(root);
  const [i, ...rest] = path;
  return {
    ...root,
    items: root.items.map((item, j) => {
      const sub = j === i ? groupOf(item) : undefined;
      return sub ? { group: { ...(item as { group: object }).group, _0: updateGroup(sub, rest, f) } } as FilterItem : item;
    }),
  };
}

export function replaceItem(root: FilterGroup, path: Path, item: FilterItem): FilterGroup {
  return updateGroup(root, path.slice(0, -1), (g) => ({ ...g, items: g.items.map((x, j) => (j === path[path.length - 1] ? item : x)) }));
}

/** Element entfernen; eine dadurch leere Untergruppe verschwindet mit. */
export function removeItem(root: FilterGroup, path: Path): FilterGroup {
  const parent = path.slice(0, -1);
  const next = updateGroup(root, parent, (g) => ({ ...g, items: g.items.filter((_, j) => j !== path[path.length - 1]) }));
  if (parent.length > 0) {
    const g = groupOf(itemAt(next, parent)!);
    if (g && g.items.length === 0) return removeItem(next, parent);
  }
  return next;
}

export function addItem(root: FilterGroup, path: Path, item: FilterItem): FilterGroup {
  return updateGroup(root, path, (g) => ({ ...g, items: [...g.items, item] }));
}

export function setCombinator(root: FilterGroup, path: Path, combinator: "and" | "or"): FilterGroup {
  return updateGroup(root, path, (g) => ({ ...g, combinator }));
}

/** Alle Bedingungen der obersten Ebene mit Pfad (für die Filter-Chips). */
export function topConditions(g: FilterGroup | undefined): { path: Path; condition: FilterCondition }[] {
  return (g?.items ?? []).flatMap((item, i) => {
    const c = conditionOf(item);
    return c ? [{ path: [i], condition: c }] : [];
  });
}

export function countConditions(g: FilterGroup | undefined): number {
  return (g?.items ?? []).reduce((n, item) => n + (isCondition(item) ? 1 : isGroup(item) ? countConditions(item.group._0) : 1), 0);
}

/** Lesbarer Wert einer Bedingung („Done, Doing“, „Today“, „12“). */
export function describeValue(store: WorkspaceStore, p: PropertySchema | undefined, value: unknown): string {
  const c = caseOf(value);
  if (!c) return "";
  switch (c[0]) {
    case "text": return String(c[1]);
    case "number": return String(c[1]);
    case "bool": return c[1] ? "Checked" : "Unchecked";
    case "date": return formatDateCell({ start: c[1] as number, includeTime: false }, undefined);
    case "relative": return RELATIVE_DATE_LABELS[c[1] as string] ?? String(c[1]);
    case "options": return (c[1] as string[]).map((id) => p?.options?.find((o) => o.id === id)?.name ?? (p?.type === "relation" ? titleOf(store, id) : id)).join(", ");
    default: return "";
  }
}

/** „Status is Done“ – Text des Filter-Chips. */
export function describeCondition(store: WorkspaceStore, db: Database, c: FilterCondition): string {
  const p = propertyOf(db, c.propertyID);
  const name = p?.name ?? "Deleted property";
  const op = FILTER_OP_LABELS[c.op] ?? c.op;
  if (c.op === "isEmpty" || c.op === "isNotEmpty") return `${name} ${op}`;
  const v = describeValue(store, p, c.value);
  return v ? `${name} ${op} ${v}` : `${name} ${op} …`;
}

/** Ist die Bedingung vollständig (filtert sie wirklich)? */
export function isComplete(c: FilterCondition): boolean {
  if (c.op === "isEmpty" || c.op === "isNotEmpty") return true;
  const v = caseOf(c.value);
  if (!v) return false;
  if (v[0] === "text") return (v[1] as string).length > 0;
  if (v[0] === "options") return (v[1] as string[]).length > 0;
  return true;
}
