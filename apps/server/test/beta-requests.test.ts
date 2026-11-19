// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// BSD-609 (ersetzt BSD-608, Entscheidung Elija 19.11.: „zeigen“): Auf Based Notes Beta legt ein KI-Client über MCP
// wieder eine offene Rückfrage an, und die Antwort sagt ihm, wo sie in Based wartet (Settings → Connect AI apps).
// Die Beta beantwortet sie ohne Agenten-Werkzeuge (`answerToolRequest`): Erlauben vermerkt die Zustimmung, der Server
// führt aus; Ablehnen schließt die Anfrage. Rückfall-Schutz: die Beta lehnt nicht mehr ab.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { isTrashed, trashedPages } from "@based/core";
import { AgentStore, answerToolRequest, openToolRequests } from "@based/brain";
import { BETA_REQUEST_PLACE } from "../src/pages.js";
import { startApp, TOKEN } from "./helpers.js";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
const textOf = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const idIn = (s: string) => /id: ([0-9A-Fa-f-]{36})/.exec(s)?.[1] ?? "";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

async function client(beta: boolean) {
  const app = await startApp(beta ? { requestPlace: BETA_REQUEST_PLACE } : {});
  cleanup.push(() => app.close());
  const c = new Client({ name: "Claude Code", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  cleanup.push(() => c.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name: "run_tool", arguments: { name, args } })) as ToolResult;
  const open = () => openToolRequests(new AgentStore(app.sync.store).runs());
  return { app, call, open };
}

async function trashedPage(call: (n: string, a?: Record<string, unknown>) => Promise<ToolResult>, title: string) {
  const id = idIn(textOf(await call("create_page", { title })));
  expect(id).not.toBe("");
  expect((await call("trash_page", { id })).isError).toBeFalsy();
  return id;
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(ok()).toBe(true);
};

describe("BSD-609: Rückfragen von KI-Apps auf der Beta", () => {
  it("Beta: delete_forever legt eine offene Anfrage an und sagt, wo sie wartet; Erlauben löscht die Seite", async () => {
    const { app, call, open } = await client(true);
    const id = await trashedPage(call, "Old notes");
    const del = await call("delete_forever", { ids: [id] });
    expect(del.isError).toBeFalsy();
    expect(textOf(del)).toContain("Asked the user in Based (Settings → Connect AI apps)");
    expect(textOf(del)).toContain("The request waits there until they answer");
    expect(textOf(del)).not.toContain("Not done");
    // offene Anfrage mit Frage, App und Folge; die Seite bleibt bis zur Zustimmung im Papierkorb
    const [req, ...rest] = open();
    expect(rest).toEqual([]);
    expect(req).toMatchObject({ question: "Delete forever: “Old notes”", app: "An AI app" });
    expect(req!.effect).toContain("for good");
    expect(isTrashed(app.sync.store, id)).toBe(true);
    // Dieselbe Frage noch einmal legt keine zweite Anfrage an.
    expect(textOf(await call("delete_forever", { ids: [id] }))).toContain("Already asked");
    expect(open()).toHaveLength(1);

    // Antwort aus der Beta (ohne Werkzeuge): Zustimmung vermerken, der Server führt aus.
    expect(answerToolRequest(app.sync.store, req!.id, true)).toContain("Allowed");
    await until(() => !app.sync.store.blocks.has(id));
    expect(trashedPages(app.sync.store).map((b) => b.id)).not.toContain(id);
    expect(open()).toEqual([]);
    expect(textOf(await call("get_run", { run_id: req!.id }))).toContain("[Done]");
  });

  it("Beta: Ablehnen lässt die Seite im Papierkorb und schließt die Anfrage", async () => {
    const { app, call, open } = await client(true);
    const id = await trashedPage(call, "Keep me");
    expect(textOf(await call("empty_trash"))).toContain("Asked the user in Based (Settings → Connect AI apps)");
    const [req] = open();
    expect(req?.question).toBe("Empty the Trash (1 page)");
    expect(answerToolRequest(app.sync.store, req!.id, false)).toBe("Declined.");
    await new Promise((r) => setTimeout(r, 150));
    expect(isTrashed(app.sync.store, id)).toBe(true);
    expect(open()).toEqual([]);
    // Prüfungen vor der Rückfrage bleiben: was nicht im Papierkorb ist, sagt das weiter.
    const other = idIn(textOf(await call("create_page", { title: "Not trashed" })));
    expect(textOf(await call("delete_forever", { ids: [other] }))).toContain("is not in the Trash");
  });

  it("Based Next: delete_forever fragt weiter in der Inbox (kein Fehler, nichts gelöscht)", async () => {
    const { app, call } = await client(false);
    const id = await trashedPage(call, "Ask first");
    const del = await call("delete_forever", { ids: [id] });
    expect(del.isError).toBeFalsy();
    expect(textOf(del)).toContain("Asked the user in Based's inbox");
    expect(isTrashed(app.sync.store, id)).toBe(true);
  });
});
