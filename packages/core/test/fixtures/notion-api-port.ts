// BSD-217: Port für fixtures/import/notion-api.utc.json – die Routen-Tabelle der Swift-Fake-API (NotionAPIImportTests)
// beantwortet die Anfragen des TS-Clients; verglichen werden Bericht und Records.
import { makeBlock, MemoryPersistence, NotionAPIError, NotionWorkspaceImport, WorkspaceStore, derivedID, MemoryAssetSink, notionTarget } from "../../src/index.js";
import type { JSONValue, NotionTransport } from "../../src/index.js";
import { dump, reportJSON } from "./import-ports.js";
import type { Port } from "./ports.js";

const swiftNow = () => (Date.now() - 978_307_200_000) / 1000;
const b64 = (d: Uint8Array) => Buffer.from(d).toString("base64");
const enc = new TextEncoder();

interface Api { routes?: Record<string, JSONValue>; failFirst?: Record<string, number>; files?: Record<string, string>; status?: number }

/** Wie Swift `FakeNotion.send`. */
function fakeTransport(api: Api): NotionTransport {
  const fail = { ...(api.failFirst ?? {}) };
  return {
    async send(method, url, headers) {
      if (api.status !== undefined) return { status: api.status, headers: {}, body: enc.encode('{"code":"unauthorized","message":"API token is invalid."}') };
      const u = new URL(url);
      if (u.host !== "api.notion.com") {
        const f = api.files?.[u.pathname];
        return f !== undefined ? { status: 200, headers: {}, body: new Uint8Array(Buffer.from(f, "base64")) } : { status: 404, headers: {}, body: new Uint8Array() };
      }
      let path = u.pathname;
      if (path.startsWith("/v1/")) path = path.slice(4);
      let key = `${method} ${path}`;
      const db = u.searchParams.get("database_id");
      if (db !== null) key += `?database_id=${db}`;
      if ((fail[key] ?? 0) > 0) {
        fail[key]!--;
        return { status: 429, headers: { "retry-after": "0" }, body: enc.encode('{"code":"rate_limited","message":"slow down"}') };
      }
      if (headers["Notion-Version"] !== "2026-03-11") throw new Error("missing Notion-Version");
      const r = api.routes?.[key];
      if (r !== undefined) return { status: 200, headers: {}, body: enc.encode(JSON.stringify(r)) };
      return { status: 404, headers: {}, body: enc.encode(JSON.stringify({ object: "error", code: "object_not_found", message: `Could not find ${key}` })) };
    },
  };
}

const sink = () => new MemoryAssetSink((data, name) => derivedID("asset", name, b64(data)));

async function run(api: Api, targets: string[], store: WorkspaceStore): Promise<unknown> {
  const imp = new NotionWorkspaceImport("secret_x", fakeTransport(api), { client: { requestsPerSecond: 0 } });
  try {
    return reportJSON(await imp.run(targets.flatMap((t) => { const id = notionTarget(t); return id ? [id] : []; }), store, sink()));
  } catch (e) {
    if (e instanceof NotionAPIError) return { error: e.kind === "http" ? `http ${e.status}` : e.kind };
    throw e;
  }
}

type Input = { targets: string[]; api: Api; edits?: string[]; api2?: Api };

export const notionAPIPort: Port = async (raw) => {
  const input = raw as Input;
  const start = swiftNow();
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "fx" });
  if (!input.api2) {
    const report = await run(input.api, input.targets, store);
    return { report, records: dump(store, start) };
  }
  const hub = input.targets[0]!;
  const r1 = await run(input.api, input.targets, store);
  store.transact("edit", (tx) => tx.update("bbbbbbbb-bbbb-4bbb-8bbb-000000000001", (b) => { b.text = "Edited in Based"; }));
  store.transact("add", (tx) => tx.put({ kind: "block", data: makeBlock({ id: "local-1", type: "text", parent: "b:" + hub, sk: "zz", text: "Added in Based" }, store.now()) }));
  const r2 = await run(input.api2, input.targets, store);
  return { reports: [r1, r2], records: dump(store, start) };
};
