// BSD-257: ChatGPT über den Codex-Login – reine Teile (Login-Ausgabe deuten, Denkstufe, Status, Doctor).
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentStatus, chatgptStatus, DEFAULT_AGENTS, parseCodexLoginStatus, toolCatalog, withCodexEffort, type DoctorTool, type StatusContext } from "../src/index.js";
import { codexLoginState } from "../src/acp/stdio.js";

describe("BSD-257 Codex-Login", () => {
  it("deutet `codex login status`", () => {
    expect(parseCodexLoginStatus("Logged in using ChatGPT\n", 0)).toBe("chatgpt");
    expect(parseCodexLoginStatus("Logged in using an API key - sk-proj-***ABCD\n", 0)).toBe("apiKey");
    expect(parseCodexLoginStatus("Not logged in\n", 1)).toBe("none");
    expect(parseCodexLoginStatus("", 1)).toBe("none");
    expect(parseCodexLoginStatus("Logged in\n", 0)).toBe("chatgpt");
    expect(parseCodexLoginStatus("error: unknown subcommand", null)).toBe("unknown");
  });

  it("Denkstufe als Codex-Override, nur für Codex, ersetzt einen alten", () => {
    const codex = DEFAULT_AGENTS.find((a) => a.id === "codex")!;
    expect(withCodexEffort(codex, "low").args).toEqual([...codex.args, "-c", 'model_reasoning_effort="low"']);
    expect(withCodexEffort(codex, "auto").args.at(-1)).toBe('model_reasoning_effort="medium"');
    const twice = withCodexEffort(withCodexEffort(codex, "low"), "high");
    expect(twice.args.filter((a) => a.startsWith("model_reasoning_effort"))).toEqual(['model_reasoning_effort="high"']);
    expect(withCodexEffort(codex, undefined)).toBe(codex);
    const claude = DEFAULT_AGENTS.find((a) => a.id === "claude")!;
    expect(withCodexEffort(claude, "high")).toBe(claude);
  });

  it("Status je Fund", () => {
    const base = { agentEnabled: true, path: "/bin/codex", version: "codex-cli 0.58.0", login: "chatgpt" as const, cwd: "/w", install: "npm i -g @openai/codex" };
    expect(chatgptStatus(base)).toMatchObject({ ready: true, summary: expect.stringContaining("ChatGPT") });
    expect(chatgptStatus({ ...base, cwd: undefined })).toMatchObject({ ready: false, summary: expect.stringContaining("--coding-root") });
    expect(chatgptStatus({ ...base, path: undefined })).toMatchObject({ ready: false, installed: false, fix: "npm i -g @openai/codex" });
    expect(chatgptStatus({ ...base, login: "unknown" })).toMatchObject({ ready: false, fix: "codex login" });
  });

  it("Doctor: Codex nicht angemeldet → needsLogin; mit ChatGPT → ready", () => {
    const tools: DoctorTool[] = toolCatalog("linux").map((t) => ({ ...t, path: `/bin/${t.id}`, version: undefined }));
    const ctx: StatusContext = { claudeLoggedIn: true, unapprovedKeys: () => [], found: () => true, approveHint: () => "" };
    const codex = DEFAULT_AGENTS.find((a) => a.id === "codex")!;
    expect(agentStatus(codex, tools, { ...ctx, codexLogin: "none" })).toMatchObject({ state: "needsLogin", fix: "codex login" });
    expect(agentStatus(codex, tools, { ...ctx, codexLogin: "chatgpt" })).toMatchObject({ state: "ready", summary: expect.stringContaining("ChatGPT") });
    expect(agentStatus(codex, tools, ctx).state).toBe("ready");
  });

  it("codexLoginState ruft `codex login status` auf", async () => {
    const bin = mkdtempSync(join(tmpdir(), "codex-"));
    const path = join(bin, "codex");
    writeFileSync(path, "#!/bin/sh\n[ \"$1 $2\" = \"login status\" ] && { echo 'Logged in using ChatGPT' >&2; exit 0; }\nexit 3\n");
    chmodSync(path, 0o755);
    expect(await codexLoginState(path, { PATH: process.env.PATH })).toBe("chatgpt");
    writeFileSync(path, "#!/bin/sh\necho 'Not logged in'; exit 1\n");
    expect(await codexLoginState(path, { PATH: process.env.PATH })).toBe("none");
  });
});
