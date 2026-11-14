// BSD-403: „fragt immer“ (Swift `PermissionCall.alwaysAsks`) und Werkzeug-Aliasse/`cmd:*` (Swift `PermissionRule.aliases`).
import { describe, expect, it } from "vitest";
import { alwaysAsks, autoDecide, toolCategoryOf, executeTool, Permissions, type ChatEvent, type ToolHost } from "../src/index.js";

const never = new AbortController().signal;

describe("fragt immer", () => {
  it("endgültig löschen, Inbox beantworten, nach außen senden, Shell ohne Sandbox", () => {
    expect(alwaysAsks({ tool: "based.delete_forever" })).toBe("deletes for good");
    expect(alwaysAsks({ tool: "based.empty_trash" })).toBe("deletes for good");
    expect(alwaysAsks({ tool: "based.resolve_inbox" })).toBe("answers an inbox item");
    expect(alwaysAsks({ tool: "mcp__gmail__send_email" })).toBe("sends something out");
    expect(alwaysAsks({ tool: "Bash", argument: "ls" })).toBe("shell outside a sandbox");
    expect(alwaysAsks({ tool: "Bash", argument: "ls", sandboxed: true })).toBeUndefined();
    expect(alwaysAsks({ tool: "based.create_page" })).toBeUndefined();
    // Senden zählt nur bei externen Werkzeugen; Lesen eines MCP-Werkzeugs ist kein Senden.
    expect(alwaysAsks({ tool: "based.share_page" })).toBeUndefined();
    expect(alwaysAsks({ tool: "mcp__gmail__list_messages" }, false)).toBeUndefined();
    expect(toolCategoryOf({ tool: "mcp__based__create_page" })).toBe("edit");
  });

  it("„Work freely“ fragt trotzdem, eine allow-Regel erlaubt es ausdrücklich, deny bleibt deny", () => {
    const free = new Permissions("free");
    expect(free.decide({ tool: "based.delete_forever", argument: "p1" }, true)).toEqual({ effect: "ask", reason: "always asks (deletes for good)" });
    expect(free.decide({ tool: "based.create_page" }, true).effect).toBe("allow");
    expect(Permissions.from("allow based.resolve_inbox", "free").decide({ tool: "based.resolve_inbox" }, true).effect).toBe("allow");
    expect(Permissions.from("deny mcp__gmail__*", "free").decide({ tool: "mcp__gmail__send_email" }, true).effect).toBe("deny");
  });

  it("executeTool fragt im Modus „free“ bei Senden und lehnt ohne Fragemöglichkeit ab", async () => {
    const calls: string[] = [];
    const h: ToolHost = {
      specs: [{ name: "mcp__gmail__send_email", description: "", inputSchema: {} }, { name: "create_page", description: "", inputSchema: {} }],
      isWrite: () => true,
      call: async (n) => { calls.push(n); return { text: "ok", isError: false }; },
    };
    const ev: ChatEvent[] = [];
    const asked: string[] = [];
    const policy = { mode: "free" as const, approve: async (c: { name: string }) => { asked.push(c.name); return true; } };
    await executeTool(h, { id: "1", name: "create_page", arguments: {} }, policy, never, (e) => ev.push(e));
    await executeTool(h, { id: "2", name: "mcp__gmail__send_email", arguments: {} }, policy, never, (e) => ev.push(e));
    expect(asked).toEqual(["mcp__gmail__send_email"]);
    expect(calls).toEqual(["create_page", "mcp__gmail__send_email"]);
    expect((await executeTool(h, { id: "3", name: "mcp__gmail__send_email", arguments: {} }, { mode: "free" }, never, () => {})).isError).toBe(true);
    // eine allow-Regel erlaubt es ohne Frage
    const r = await executeTool(h, { id: "4", name: "mcp__gmail__send_email", arguments: {} }, { mode: "free", rules: () => "allow" }, never, () => {});
    expect(r.isError).toBe(false);
  });

  it("ACP: Shell fragt in „Work freely“, außer eine Regel erlaubt den Befehl", () => {
    const req = { sessionId: "s", toolCallId: "t", title: "Run", kind: "execute", argument: "npm test", detail: "", options: [{ optionId: "y", name: "Y", kind: "allow_once" }] };
    expect(autoDecide(req, new Permissions("free")).effect).toBe("ask");
    expect(autoDecide(req, Permissions.from("allow Bash(npm:*)", "free"))).toMatchObject({ effect: "allow", optionId: "y" });
    expect(autoDecide({ ...req, kind: "edit", argument: "/a" }, new Permissions("free")).effect).toBe("allow");
  });
});

describe("Werkzeug-Aliasse und cmd:*", () => {
  it("Edit/Write teilen Regeln, Web deckt Abruf und Suche, Bash deckt Shell", () => {
    const p = Permissions.from("deny Write(*secret*)\ndeny Web\nallow Bash(git status:*)", "askEdits");
    expect(p.ruleVerdict({ tool: "Edit", argument: "/p/secret.txt" })?.effect).toBe("deny");
    expect(p.ruleVerdict({ tool: "MultiEdit", argument: "/p/secret.txt" })?.effect).toBe("deny");
    expect(p.ruleVerdict({ tool: "WebFetch", argument: "https://x" })?.effect).toBe("deny");
    expect(p.ruleVerdict({ tool: "WebSearch", argument: "q" })?.effect).toBe("deny");
    expect(p.ruleVerdict({ tool: "Shell", argument: "git status --short" })?.effect).toBe("allow");
  });

  it("`cmd:*` ist ein Präfix an der Wortgrenze", () => {
    const p = Permissions.from("allow Bash(git status:*)");
    expect(p.ruleVerdict({ tool: "Bash", argument: "git status" })?.effect).toBe("allow");
    expect(p.ruleVerdict({ tool: "Bash", argument: "  git status --short" })?.effect).toBe("allow");
    expect(p.ruleVerdict({ tool: "Bash", argument: "git statusx; rm -rf /" })).toBeUndefined();
  });
});
