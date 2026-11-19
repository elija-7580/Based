// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// BSD-609: Liste der offenen Rückfragen für Based Notes Beta (ohne Agenten-Werkzeuge) und Antwort darauf.
import { describe, expect, it } from "vitest";
import { createPage, trashPages } from "@based/core";
import { AgentStore, WorkspaceTools, answerToolRequest, openToolRequests, requestEffect } from "../src/index.js";
import { memoryStore } from "./helpers.js";

describe("BSD-609: offene Rückfragen", () => {
  it("listet nur offene Anfragen, nennt App und Folge; Ort im Satz an die App", () => {
    const store = memoryStore();
    const tools = new WorkspaceTools(store, { actor: { kind: "agent", name: "Cursor" }, requestPlace: "Based (Settings → Connect AI apps)" });
    const a = createPage(store, { title: "A" });
    const b = createPage(store, { title: "B" });
    trashPages(store, [a, b]);
    const asked = tools.callSync("delete_forever", { ids: [a] });
    expect(asked.text).toContain("Asked the user in Based (Settings → Connect AI apps)");
    tools.callSync("delete_forever", { ids: [b] });
    const list = openToolRequests(new AgentStore(store).runs());
    expect(list.map((r) => r.question).sort()).toEqual(["Delete forever: “A”", "Delete forever: “B”"]);
    expect(list.every((r) => r.app === "Cursor" && r.effect === requestEffect("delete_forever"))).toBe(true);

    // Ablehnen: weg aus der Liste, nichts gelöscht. Erlauben ohne Werkzeug: vermerkt, der Server führt aus.
    expect(answerToolRequest(store, list[0]!.id, false)).toBe("Declined.");
    expect(answerToolRequest(store, list[1]!.id, true)).toContain("Allowed");
    expect(openToolRequests(new AgentStore(store).runs())).toEqual([]);
    expect(store.blocks.has(a) && store.blocks.has(b)).toBe(true);
    expect(() => answerToolRequest(store, list[1]!.id, true)).toThrow("already answered");
    // Der Host mit dem Werkzeug führt die Zustimmung aus.
    expect(tools.runApprovedRequests()).toBe(1);
    expect([a, b].filter((id) => store.blocks.has(id))).toHaveLength(1);
  });

  it("ohne Namen heißt der Urheber „An AI app“; unbekanntes Werkzeug bekommt einen allgemeinen Satz", () => {
    const store = memoryStore();
    const tools = new WorkspaceTools(store, { actor: { kind: "agent", name: "MCP client" } });
    const p = createPage(store, { title: "X" });
    trashPages(store, [p]);
    expect(tools.callSync("empty_trash", {}).text).toContain("Asked the user in Based's inbox");
    expect(openToolRequests(new AgentStore(store).runs())[0]).toMatchObject({ app: "An AI app", question: "Empty the Trash (1 page)" });
    expect(requestEffect("something_new")).toBe("Allowing lets the app make this change in your workspace.");
  });
});
