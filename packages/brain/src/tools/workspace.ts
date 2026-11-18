// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Agent-Parität 4/7: Workspace und Teamspaces – was der Mensch im Kopf der Seitenleiste macht (Name, Icon, Bereiche
// anlegen, umbenennen, löschen). Dazu `sectionFrom`: „private“, eine Teamspace-ID oder ein Teamspace-Name → Bereich.
import { createTeamspace, deleteTeamspace, isPageLike, PRIVATE, renameTeamspace, renameWorkspace, setTeamspaceIcon, setWorkspaceIcon, type SectionID, type WorkspaceStore } from "@based/core";
import { needStr, obj, optStr, str, ToolError, type ToolDef } from "./base.js";
import type { ToolCtx } from "./context.js";

const teamspaces = (store: WorkspaceStore) => store.workspace.teamspaces ?? [];

/** „private“, Teamspace-ID oder -Name (ohne Groß/klein) → Bereich; sonst Fehler mit den Namen, die es gibt. */
export function sectionFrom(store: WorkspaceStore, raw: string): SectionID {
  const s = raw.trim();
  if (s === "" || s.toLowerCase() === "private") return PRIVATE;
  const all = teamspaces(store);
  const t = all.find((x) => x.id === s) ?? all.find((x) => x.name.toLowerCase() === s.toLowerCase());
  if (!t) throw new ToolError(`No teamspace “${raw}”. Sections: private${all.length ? ", " + all.map((x) => x.name).join(", ") : ""}.`);
  return { kind: "teamspace", id: t.id };
}

export const sectionName = (store: WorkspaceStore, section: SectionID): string => (section.kind === "private" ? "Private" : teamspaces(store).find((t) => t.id === section.id)?.name ?? "Teamspace");

export function workspaceTools(ctx: ToolCtx): ToolDef[] {
  const { store } = ctx;
  const teamspace = (raw: string) => {
    const sec = sectionFrom(store, raw);
    if (sec.kind !== "teamspace") throw new ToolError("Private is not a teamspace.");
    return teamspaces(store).find((t) => t.id === sec.id)!;
  };
  const iconArg = (a: Record<string, unknown>): string | undefined | null => (typeof a.icon === "string" ? (a.icon.trim() === "" || a.icon === "none" ? undefined : a.icon.trim()) : null);
  return [
    {
      group: "pages", write: false,
      spec: { name: "get_workspace", description: "The workspace: name, icon, the sections of the sidebar (Private and teamspaces with ids and page counts) and the favorites.", inputSchema: obj({}) },
      run: () => {
        const w = store.workspace;
        const top = store.children("w").map((id) => store.blocks.get(id)).filter((b) => b !== undefined && isPageLike(b) && b.trashedAt === undefined);
        const count = (id: string | undefined) => top.filter((b) => (b!.props?.teamspace ?? undefined) === id).length;
        const lines = [`Workspace “${w.name || "Untitled"}”${typeof w.icon === "string" && w.icon ? ` ${w.icon}` : ""}`, "Sections:", `- Private — ${count(undefined)} pages`];
        for (const t of teamspaces(store)) lines.push(`- ${t.name}${typeof t.icon === "string" && t.icon ? ` ${t.icon}` : ""} (teamspace id: ${t.id}) — ${count(t.id)} pages`);
        const favs = (w.favorites ?? []).filter((id) => store.blocks.has(id));
        if (favs.length) lines.push("Favorites:", ...favs.map(ctx.line));
        return lines.join("\n");
      },
    },
    {
      group: "pages", write: true,
      spec: { name: "update_workspace", description: "Rename the workspace or change its emoji icon (empty string removes it).", inputSchema: obj({ name: str("New name"), icon: str("Emoji") }) },
      run: (a) => {
        const name = optStr(a, "name"), icon = iconArg(a);
        if (name === undefined && icon === null) throw new ToolError("Give a name or an icon.");
        if (name !== undefined) {
          if (!name.trim()) throw new ToolError("The name can't be empty.");
          renameWorkspace(store, name);
        }
        if (icon !== null) setWorkspaceIcon(store, icon);
        return `Updated the workspace “${store.workspace.name}”.`;
      },
    },
    {
      group: "pages", write: true,
      spec: { name: "create_teamspace", description: "Create a teamspace (a shared section of the sidebar). Put pages into it with create_page or move_page (section).", inputSchema: obj({ name: { type: "string", minLength: 1 }, icon: str("Emoji") }, ["name"]) },
      run: (a) => {
        const name = needStr(a, "name").trim();
        if (teamspaces(store).some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new ToolError(`A teamspace named “${name}” already exists — nothing created.`);
        const icon = iconArg(a);
        const id = createTeamspace(store, name, icon ?? undefined);
        return `Created teamspace “${name}” (teamspace id: ${id})`;
      },
    },
    {
      group: "pages", write: true,
      spec: { name: "update_teamspace", description: "Rename a teamspace or change its emoji icon (empty string removes it).", inputSchema: obj({ teamspace: str("Teamspace id or name"), name: str("New name"), icon: str("Emoji") }, ["teamspace"]) },
      run: (a) => {
        const t = teamspace(needStr(a, "teamspace"));
        const name = optStr(a, "name"), icon = iconArg(a);
        if (name === undefined && icon === null) throw new ToolError("Give a name or an icon.");
        if (name !== undefined) {
          if (!name.trim()) throw new ToolError("The name can't be empty.");
          renameTeamspace(store, t.id, name);
        }
        if (icon !== null) setTeamspaceIcon(store, t.id, icon);
        return `Updated teamspace “${teamspaces(store).find((x) => x.id === t.id)!.name}”.`;
      },
    },
    {
      group: "pages", write: true, destructive: true,
      spec: { name: "delete_teamspace", description: "Delete a teamspace. Its pages are not deleted: they move to Private.", inputSchema: obj({ teamspace: str("Teamspace id or name") }, ["teamspace"]) },
      run: (a) => {
        const t = teamspace(needStr(a, "teamspace"));
        const moved = store.children("w").filter((id) => store.blocks.get(id)?.props?.teamspace === t.id).length;
        deleteTeamspace(store, t.id);
        return `Deleted teamspace “${t.name}”; ${moved} page${moved === 1 ? "" : "s"} moved to Private.`;
      },
    },
  ];
}
