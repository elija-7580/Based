// BSD-222: MCP-Connections als Records im Store (wie Agenten/Projekte, agents/records.ts): einmal eingerichtet, auf
// allen Geräten da (Sync v2). Das Geheimnis (Token) liegt NIE im Record, nur im verschlüsselten Speicher des Geräts
// unter `secretRef` (Swift: Keychain-Schlüssel in der Datenbank „Connections“).
//   { type: "mcpConnection", parent: "w", text: <Name>, props: { connection: ConnectionData } }
import { makeRecordID, type WorkspaceStore } from "@based/core";
import { CONNECTION_TYPE, getRecord, listRecords, putRecord, removeRecord, updateRecord, type AgentData, type ProjectData, type Rec } from "../agents/records.js";
import type { CatalogEntry } from "./catalog.js";

export { CONNECTION_TYPE };

export interface ConnectionData {
  v: 1;
  transport: "http" | "stdio";
  /** HTTP: Endpunkt. */
  url?: string;
  /** stdio: Befehl und Argumente (nur Desktop-Hülle / Server). */
  command?: string;
  args?: string[];
  /** Eintrag im Katalog, aus dem die Connection entstand. */
  catalogID?: string;
  enabled: boolean;
  /** Werkzeuge auch für Agenten (Hauptagent, Zeitpläne, Coding-Agenten), nicht nur im Chat. */
  exposeToAgents: boolean;
  /** Name des Geheimnisses im verschlüsselten Gerätespeicher; ohne: kein Token. */
  secretRef?: string;
  /** HTTP: Header für das Token (Standard Authorization: Bearer). */
  headerName?: string;
  /** stdio: Umgebungsvariable, die das Token bekommt. */
  secretEnv?: string;
  [key: string]: unknown;
}

export type Connection = Rec<ConnectionData>;

/** Alle Connections in Anlege-Reihenfolge (Sortierschlüssel unter „w“). */
export function listConnections(store: WorkspaceStore): Connection[] {
  const order = new Map(store.children("w").map((id, i) => [id, i]));
  return listRecords<ConnectionData>(store, CONNECTION_TYPE).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export const getConnection = (store: WorkspaceStore, id: string): Connection | undefined => getRecord<ConnectionData>(store, CONNECTION_TYPE, id);

/** Schlüssel des Geheimnisses einer Connection im Gerätespeicher. */
export const secretRefFor = (id: string) => `mcp:${id}`;

export interface NewConnection {
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  catalogID?: string;
  /** Hat die Connection ein Token? (dann `secretRef` = secretRefFor(id)) */
  withSecret?: boolean;
  headerName?: string;
  secretEnv?: string;
  exposeToAgents?: boolean;
}

/** Prüft URL bzw. Befehl; liefert eine Meldung für die Oberfläche oder `undefined`. */
export function validateConnection(c: { name: string; transport: "http" | "stdio"; url?: string | undefined; command?: string | undefined }): string | undefined {
  if (!c.name.trim()) return "Give the connection a name.";
  if (c.transport === "http") {
    let u: URL;
    try {
      u = new URL(c.url ?? "");
    } catch {
      return "Enter the server URL (https://…).";
    }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return "Use https:// (http:// only for localhost).";
    if (u.username || u.password) return "Put the token in the token field, not in the URL.";
    return undefined;
  }
  if (!c.command?.trim()) return "Enter the command that starts the server.";
  return undefined;
}

export function connectionFromCatalog(e: CatalogEntry): NewConnection {
  return {
    name: e.name,
    transport: e.transport,
    catalogID: e.id,
    withSecret: e.auth === "token" || e.secretEnv !== undefined,
    ...(e.url ? { url: e.url } : {}),
    ...(e.command ? { command: e.command } : {}),
    ...(e.args ? { args: [...e.args] } : {}),
    ...(e.secretEnv ? { secretEnv: e.secretEnv } : {}),
  };
}

export function addConnection(store: WorkspaceStore, input: NewConnection, id = makeRecordID()): Connection {
  const problem = validateConnection(input);
  if (problem) throw new Error(problem);
  const data: ConnectionData = {
    v: 1,
    transport: input.transport,
    enabled: true,
    exposeToAgents: input.exposeToAgents ?? true,
    ...(input.transport === "http" ? { url: input.url!.trim() } : { command: input.command!.trim(), args: input.args ?? [] }),
    ...(input.catalogID ? { catalogID: input.catalogID } : {}),
    ...(input.withSecret ? { secretRef: secretRefFor(id) } : {}),
    ...(input.headerName ? { headerName: input.headerName } : {}),
    ...(input.secretEnv ? { secretEnv: input.secretEnv } : {}),
  };
  store.transact("Add connection", (tx) => putRecord(store, tx, CONNECTION_TYPE, id, input.name.trim(), data), { undoable: false });
  return getConnection(store, id)!;
}

export interface ConnectionPatch {
  name?: string;
  enabled?: boolean;
  exposeToAgents?: boolean;
  url?: string;
  headerName?: string | null;
  withSecret?: boolean;
}

export function updateConnection(store: WorkspaceStore, id: string, patch: ConnectionPatch): Connection | undefined {
  const cur = getConnection(store, id);
  if (!cur) return undefined;
  if (patch.url !== undefined || patch.name !== undefined) {
    const problem = validateConnection({ name: patch.name ?? cur.name, transport: cur.data.transport, url: patch.url ?? cur.data.url, command: cur.data.command });
    if (problem) throw new Error(problem);
  }
  store.transact("Edit connection", (tx) => updateRecord<ConnectionData>(tx, CONNECTION_TYPE, id, (d) => {
    if (patch.enabled !== undefined) d.enabled = patch.enabled;
    if (patch.exposeToAgents !== undefined) d.exposeToAgents = patch.exposeToAgents;
    if (patch.url !== undefined) d.url = patch.url.trim();
    if (patch.headerName === null) delete d.headerName;
    else if (patch.headerName !== undefined) d.headerName = patch.headerName;
    if (patch.withSecret === true) d.secretRef = secretRefFor(id);
    else if (patch.withSecret === false) delete d.secretRef;
  }, patch.name?.trim()), { undoable: false });
  return getConnection(store, id);
}

/** Entfernt die Connection (das Geheimnis löscht der Aufrufer aus dem Gerätespeicher). */
export function removeConnection(store: WorkspaceStore, id: string) {
  if (!getConnection(store, id)) return;
  store.transact("Remove connection", (tx) => removeRecord(tx, id), { undoable: false });
}

/**
 * Welche Connections ein Lauf nutzen darf. Chat (ohne Agent): alle eingeschalteten. Agenten: eingeschaltet und
 * für Agenten freigegeben, dann die Liste des Agenten und die des Projekts (beide schränken nur ein).
 */
export function connectionsFor(all: readonly Connection[], scope: { agent?: AgentData | undefined; project?: ProjectData | undefined } = {}): Connection[] {
  return all.filter((c) => {
    if (!c.data.enabled) return false;
    if (!scope.agent && !scope.project) return true;
    if (!c.data.exposeToAgents) return false;
    if (scope.agent?.connections && !scope.agent.connections.includes(c.id)) return false;
    if (scope.project?.connections && !scope.project.connections.includes(c.id)) return false;
    return true;
  });
}
