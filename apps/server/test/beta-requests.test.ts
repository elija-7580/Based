// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// BSD-608: Based Notes Beta zeigt keine Inbox. Ein KI-Client über MCP darf dort keine Rückfrage ablegen, die niemand
// sieht; der Server lehnt ab und sagt, was der Mensch in Based tut. Based Next fragt weiter in der Inbox.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { isTrashed, trashedPages } from "@based/core";
import { betaDeclinesRequests } from "../src/pages.js";
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
  const app = await startApp(beta ? { declineRequests: betaDeclinesRequests } : {});
  cleanup.push(() => app.close());
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  cleanup.push(() => c.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name: "run_tool", arguments: { name, args } })) as ToolResult;
  return { app, call };
}

describe("BSD-608: Rückfragen von KI-Apps auf der Beta", () => {
  it("Beta: delete_forever und empty_trash lehnen mit einem Satz ab, nichts wird gelöscht, keine offene Anfrage", async () => {
    const { app, call } = await client(true);
    const id = idIn(textOf(await call("create_page", { title: "Keep me" })));
    expect(id).not.toBe("");
    expect((await call("trash_page", { id })).isError).toBeFalsy();
    const del = await call("delete_forever", { ids: [id] });
    expect(del.isError).toBe(true);
    expect(textOf(del)).toContain("Based Notes Beta");
    expect(textOf(del)).toContain("Trash → Delete forever");
    expect(textOf(del)).toContain("“Keep me”");
    const empty = await call("empty_trash");
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toContain("Nothing was changed");
    // Die Seite liegt unverändert im Papierkorb, die Inbox hat nichts Offenes.
    expect(isTrashed(app.sync.store, id)).toBe(true);
    expect(trashedPages(app.sync.store).map((b) => b.id)).toContain(id);
    expect(textOf(await call("inbox"))).not.toContain("Keep me");
    // Prüfungen vor der Rückfrage bleiben: was nicht im Papierkorb ist, sagt das weiter.
    const other = idIn(textOf(await call("create_page", { title: "Not trashed" })));
    expect(textOf(await call("delete_forever", { ids: [other] }))).toContain("is not in the Trash");
  });

  it("Based Next: delete_forever legt weiter eine Rückfrage in die Inbox (kein Fehler, nichts gelöscht)", async () => {
    const { app, call } = await client(false);
    const id = idIn(textOf(await call("create_page", { title: "Ask first" })));
    await call("trash_page", { id });
    const del = await call("delete_forever", { ids: [id] });
    expect(del.isError).toBeFalsy();
    expect(textOf(del)).not.toContain("Based Notes Beta");
    expect(isTrashed(app.sync.store, id)).toBe(true);
  });
});
