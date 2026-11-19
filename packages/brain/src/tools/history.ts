// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Versionsverlauf für Agenten (Matrix V1, V2). Der Verlauf liegt beim Host (in der App: Store-Worker); ohne Host
// gibt es diese Werkzeuge nicht.
import { plainText, type Block, type HistoryVersion } from "@based/core";
import { limitSchema, needStr, obj, optNum, pageID, ToolError, type ToolDef } from "./base.js";
import type { ToolCtx } from "./context.js";

export interface HistoryHost {
  list(pageID: string): { versions: HistoryVersion[]; error?: string };
  content(pageID: string, versionID: number): { blocks: Block[]; missing: string[] };
  restore(pageID: string, versionID: number): { restored: number; removed: number; copied: number; trashed: number };
}

const stamp = (at: number) => new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** Blöcke einer Version als eingerückte Gliederung (Art: Text) – ohne den Store, die Version ist ein alter Stand. */
export function versionOutline(blocks: readonly Block[]): string {
  const page = blocks[0];
  if (!page) return "";
  const kids = new Map<string, Block[]>();
  for (const b of blocks.slice(1)) kids.set(b.parent, [...(kids.get(b.parent) ?? []), b]);
  for (const l of kids.values()) l.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
  const out: string[] = [];
  const walk = (parent: string, depth: number) => {
    for (const b of kids.get(parent) ?? []) {
      const text = plainText(b.text);
      out.push(`${"  ".repeat(depth)}${b.type}${text ? `: ${text}` : ""}`);
      if (b.type !== "page") walk("b:" + b.id, depth + 1);
    }
  };
  walk("b:" + page.id, 0);
  return out.join("\n");
}

export function historyTools(ctx: ToolCtx, host: () => HistoryHost | undefined): ToolDef[] {
  const need = (): HistoryHost => {
    const h = host();
    if (!h) throw new ToolError("Version history isn't available here right now.");
    return h;
  };
  const version = (a: Record<string, unknown>): number => {
    if (typeof a.version !== "number") throw new ToolError("version must be a number (page_history lists them).");
    return a.version;
  };
  const wrap = <T>(f: () => T): T => {
    try { return f(); } catch (e) { throw e instanceof ToolError ? e : new ToolError(e instanceof Error ? e.message : String(e)); }
  };
  return [
    {
      group: "pages", write: false,
      spec: { name: "page_history", description: "Saved versions of a page, newest first: version number, time, reason, size.", inputSchema: obj({ id: pageID, limit: limitSchema }, ["id"]) },
      run: (a) => {
        const id = ctx.page(needStr(a, "id")).id;
        const r = wrap(() => need().list(id));
        if (r.versions.length === 0) return "No saved versions yet.";
        const n = Math.max(1, optNum(a, "limit", 30));
        const lines = r.versions.slice(0, n).map((v) => `- version ${v.id} · ${stamp(v.at)} · ${v.reason} · ${v.blockCount} blocks, ${v.wordCount} words${v.title !== ctx.title(id) ? ` · titled “${v.title}”` : ""}`);
        if (r.versions.length > n) lines.push(`… ${r.versions.length - n} older`);
        return lines.join("\n");
      },
    },
    {
      group: "pages", write: false,
      spec: { name: "read_version", description: "Content of one saved version of a page as an outline (block kind: text).", inputSchema: obj({ id: pageID, version: { type: "integer" } }, ["id", "version"]) },
      run: (a) => {
        const id = ctx.page(needStr(a, "id")).id;
        const c = wrap(() => need().content(id, version(a)));
        return (versionOutline(c.blocks) || "(empty page)") + (c.missing.length ? `\n\n(${c.missing.length} blocks of this version are missing)` : "");
      },
    },
    {
      group: "pages", write: true, destructive: true,
      spec: {
        name: "restore_version",
        description: "Set a page back to a saved version (one undo step). The current state is saved as a version first; subpages are not touched.",
        inputSchema: obj({ id: pageID, version: { type: "integer" } }, ["id", "version"]),
      },
      run: (a) => {
        const id = ctx.writable(needStr(a, "id")).id;
        const r = wrap(() => need().restore(id, version(a)));
        return `Restored “${ctx.title(id)}” to version ${version(a)}: ${r.restored} blocks back, ${r.removed} removed${r.copied ? `, ${r.copied} copied back from other pages` : ""}.`;
      },
    },
  ];
}
