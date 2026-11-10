// BSD-223: Fake-ACP-Agent für Tests (stdio, zeilenweises JSON-RPC). Verhalten nach Prompt-Text:
// "hello" → Text in zwei Stücken + Verbrauch; "edit <pfad>" → Tool-Call, Freigabe, fs/write, Diff;
// "read <pfad>" → fs/read; "wait" → wartet auf session/cancel; "plan" → Plan; "env" → meldet Umgebungsnamen;
// sonst: wiederholt die empfangenen Prompt-Blöcke als JSON.
import { createInterface } from "node:readline";

let nextId = 1000;
const pending = new Map();
const sessions = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const request = (method, params) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); send({ id, method, params }); });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const text = (sessionId, t) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });

async function prompt(p) {
  const sid = p.sessionId;
  const s = sessions.get(sid);
  const blocks = p.prompt;
  const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (t === "hello") {
    update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking…" } });
    text(sid, "Hi ");
    text(sid, "there");
    update(sid, { sessionUpdate: "usage_update", inputTokens: 12, outputTokens: 3 });
    return { stopReason: "end_turn" };
  }
  if (t.startsWith("edit ")) {
    const path = t.slice(5);
    update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: `Edit ${path}`, kind: "edit", status: "pending", rawInput: { file_path: path } });
    const r = await request("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "t1", title: `Edit ${path}`, kind: "edit", rawInput: { file_path: path } },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
    });
    if (r.outcome.outcome === "cancelled") return { stopReason: s.cancelled ? "cancelled" : "end_turn" };
    if (r.outcome.optionId === "no") {
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed", content: [{ type: "content", content: { type: "text", text: "rejected" } }] });
      text(sid, "ok, not editing");
      return { stopReason: "end_turn" };
    }
    try {
      await request("fs/write_text_file", { sessionId: sid, path, content: "new\n" });
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "diff", path, oldText: "old\n", newText: "new\n" }] });
      text(sid, "edited");
    } catch (e) {
      update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed", content: [{ type: "content", content: { type: "text", text: e.message } }] });
      text(sid, "write failed: " + e.message);
    }
    return { stopReason: "end_turn" };
  }
  if (t.startsWith("read ")) {
    try { const r = await request("fs/read_text_file", { sessionId: sid, path: t.slice(5) }); text(sid, "content: " + r.content); }
    catch (e) { text(sid, "read failed: " + e.message); }
    return { stopReason: "end_turn" };
  }
  if (t === "wait") {
    await new Promise((resolve) => { s.onCancel = resolve; });
    return { stopReason: "cancelled" };
  }
  if (t === "plan") {
    update(sid, { sessionUpdate: "plan", entries: [{ content: "Look", status: "completed", priority: "high" }, { content: "Fix", status: "pending", priority: "high" }] });
    return { stopReason: "end_turn" };
  }
  if (t === "env") {
    text(sid, Object.keys(process.env).sort().join(","));
    return { stopReason: "end_turn" };
  }
  text(sid, JSON.stringify(blocks));
  return { stopReason: "end_turn" };
}

async function handle(m) {
  switch (m.method) {
    case "initialize": return { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [], agentInfo: { name: "fake" } };
    case "session/new": {
      const id = `s${sessions.size + 1}`;
      sessions.set(id, { cwd: m.params.cwd, mcp: m.params.mcpServers });
      return { sessionId: id, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] } };
    }
    case "session/load": {
      sessions.set(m.params.sessionId, { cwd: m.params.cwd });
      update(m.params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier" } });
      return null;
    }
    case "session/set_mode": update(m.params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: m.params.modeId }); return null;
    case "session/prompt": return prompt(m.params);
    default: throw Object.assign(new Error("Method not found: " + m.method), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method && m.id !== undefined) {
    handle(m).then((result) => send({ id: m.id, result }), (e) => send({ id: m.id, error: { code: e.code ?? -32603, message: e.message } }));
  } else if (m.method === "session/cancel") {
    const s = sessions.get(m.params.sessionId);
    if (s) { s.cancelled = true; s.onCancel?.(); }
  } else if (m.id !== undefined && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  }
});
