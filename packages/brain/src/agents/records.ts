// BSD-160 / ADR 0007: Runs, Projekte, Agenten und Zeitpläne als Records im Store (Sync v2 überträgt sie wie jeden
// Block; ADR 0002: unbekannte Felder bleiben erhalten). Gleiches Muster wie Chats (transcript.ts):
//   { type: <Typ>, parent: "w", text: <Name/Titel>, props: { <feld>: Daten } }
// Zeiten in Swift-Sekunden (seit 2001), wie alle Zeiten im Store.
import { keyOf, makeBlock, plainText, sortKeys, type Block, type JSONValue, type Tx, type WorkspaceStore } from "@based/core";
import type { PermissionMode } from "../engine.js";

export const RUN_TYPE = "agentRun";
export const PROJECT_TYPE = "agentProject";
export const AGENT_TYPE = "agentProfile";
export const SCHEDULE_TYPE = "agentSchedule";

/** Feste IDs je Workspace (nicht gerätelokal): zwei Geräte legen denselben Record an, Sync führt zusammen. */
export const MAIN_AGENT_ID = "00000000-0000-4000-8000-0000000a6e17";
export const INBOX_PAGE_ID = "00000000-0000-4000-8000-00000001b0c5";

/** Swift-Sekunden ↔ ms seit 1970. */
export const SWIFT_EPOCH_MS = 978_307_200_000;
export const toMs = (swift: number) => swift * 1000 + SWIFT_EPOCH_MS;
export const fromMs = (ms: number) => (ms - SWIFT_EPOCH_MS) / 1000;

export type RunKind = "chat" | "main" | "subagent" | "schedule";
export type RunStatus = "queued" | "running" | "needsYou" | "done" | "failed" | "cancelled";
export const isRunFinished = (s: RunStatus) => s === "done" || s === "failed" || s === "cancelled";

export interface Usage3 {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export interface RunData {
  v: 1;
  kind: RunKind;
  status: RunStatus;
  agentID: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  parentID?: string;
  taskID?: string;
  projectID?: string;
  chatID?: string;
  scheduleID?: string;
  /** Auftrag an einen Unteragenten / geplanten Lauf. */
  instructions?: string;
  model?: string;
  usage: Usage3;
  /** Kosten in € (aus `usage.costUSD` mit dem Kurs zum Zeitpunkt des Schreibens). */
  costEUR: number;
  /** Obergrenze für diesen Lauf (€). */
  budgetEUR?: number;
  /** Anteil an einem Abo-Kontingent (0…1), wenn ein CLI-Abo lief – nur Feld, Based schätzt es nicht. */
  subscriptionShare?: number;
  result?: string;
  lease?: { owner: string; until: number };
  /** BSD-168: Aufruf, auf dessen Freigabe der Lauf wartet („Needs you“) – übersteht Neuladen und gilt auf jedem Tab. */
  approval?: RunApproval;
  /** BSD-168: Freigabe nach einem Neustart erteilt; der Lauf setzt mit seinem Transkript fort und darf genau diesen Aufruf. */
  resume?: RunApproval & { ok: boolean };
  [key: string]: unknown;
}

export interface RunApproval {
  callID: string;
  name: string;
  arguments: unknown;
}

export type ProjectStatus = "active" | "paused" | "done";

export interface ProjectData {
  v: 1;
  status: ProjectStatus;
  goal?: string;
  /** Projektseite (Updates des Hauptagenten landen dort). */
  pageID?: string;
  /** Berechtigungs-Schicht des Projekts (`mode …` + Regeln). */
  permissions?: string;
  budgetEUR?: number;
  createdAt: number;
  /** BSD-222: erlaubte MCP-Connections im Projekt (IDs); `undefined` = keine Einschränkung. */
  connections?: string[];
  [key: string]: unknown;
}

export interface AgentData {
  v: 1;
  kind: "main" | "agent";
  model?: string;
  /** € je Kalendermonat; `undefined` = unbegrenzt. */
  monthlyBudgetEUR?: number;
  /** Ein Unteragent bis zu dieser Schätzung läuft ohne Bestätigung (€). */
  perTaskEUR?: number;
  /** Kurs für API-Kosten (Anbieter melden USD). */
  eurPerUSD?: number;
  permissions: { mode: PermissionMode; rules: string };
  /** Eingebundenes Abo (Claude/ChatGPT über CLI): nur Angaben, keine Schätzung. */
  subscription?: { name: string; share?: number };
  /** BSD-222: erlaubte MCP-Connections (IDs); `undefined` = alle, die für Agenten freigegeben sind. */
  connections?: string[];
  [key: string]: unknown;
}

export interface ScheduleData {
  v: 1;
  when: string;
  prompt: string;
  agentID: string;
  enabled: boolean;
  projectID?: string;
  /** Nächster Termin (Swift-Sekunden); `undefined` = keiner mehr (einmalig, vorbei). */
  nextAt?: number;
  lastAt?: number;
  /** Auftrag, der den Zeitplan angelegt hat. */
  taskID?: string;
  [key: string]: unknown;
}

export interface Rec<T> {
  id: string;
  name: string;
  data: T;
  createdAt: number;
  updatedAt: number;
}

/** BSD-222: MCP-Connection (Konfiguration, ohne Geheimnis), siehe mcp/connections.ts. */
export const CONNECTION_TYPE = "mcpConnection";

const FIELD: Record<string, string> = { [RUN_TYPE]: "run", [PROJECT_TYPE]: "project", [AGENT_TYPE]: "agent", [SCHEDULE_TYPE]: "schedule", agentTask: "task", [CONNECTION_TYPE]: "connection" };

/** Daten aus einem Block lesen (Feld je Typ). */
export function dataOf<T>(b: Block | undefined, type: string): T | undefined {
  if (!b || b.type !== type || b.trashedAt !== undefined) return undefined;
  const v = (b.props as Record<string, unknown> | undefined)?.[FIELD[type]!];
  return v !== null && typeof v === "object" && (v as { v?: unknown }).v === 1 ? (v as T) : undefined;
}

export const recOf = <T>(b: Block, data: T): Rec<T> => ({ id: b.id, name: plainText(b.text), data, createdAt: b.createdAt, updatedAt: b.updatedAt });

/** Alle Records eines Typs (unter „w“), neueste zuerst. */
export function listRecords<T>(store: WorkspaceStore, type: string): Rec<T>[] {
  const out: Rec<T>[] = [];
  for (const id of store.children("w")) {
    const b = store.blocks.get(id);
    const d = dataOf<T>(b, type);
    if (b && d) out.push(recOf(b, d));
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
}

export function getRecord<T>(store: WorkspaceStore, type: string, id: string): Rec<T> | undefined {
  const b = store.blocks.get(id);
  const d = dataOf<T>(b, type);
  return b && d ? recOf(b, d) : undefined;
}

/** Record in einer Transaktion anlegen. */
export function putRecord(store: WorkspaceStore, tx: Tx, type: string, id: string, name: string, data: object) {
  const [sk] = sortKeys(store, "w", { kind: "end" }, 1);
  tx.put({ kind: "block", data: makeBlock({ id, type, parent: "w", sk: sk!, ...(name ? { text: name } : {}), props: { [FIELD[type]!]: data as JSONValue } as Block["props"] & object, createdBy: store.userID }, store.now()) });
}

/** Daten eines Records in einer Transaktion ändern (bekannte und unbekannte Felder bleiben, `f` ändert die Kopie). */
export function updateRecord<T extends object>(tx: Tx, type: string, id: string, f: (d: T) => void, name?: string) {
  tx.update(id, (b) => {
    const field = FIELD[type]!;
    const cur = structuredClone((b.props as Record<string, unknown> | undefined)?.[field] ?? {}) as T;
    f(cur);
    b.props = { ...(b.props ?? {}), [field]: cur as unknown as JSONValue } as Block["props"] & object;
    if (name !== undefined) {
      if (name === "") delete b.text;
      else b.text = name;
    }
  });
}

export function removeRecord(tx: Tx, id: string) {
  tx.remove(keyOf("block", id));
}

export const defaultMainAgent = (): AgentData => ({ v: 1, kind: "main", permissions: { mode: "askEdits", rules: "" }, perTaskEUR: 0.5, eurPerUSD: 0.92 });
