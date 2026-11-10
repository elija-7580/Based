// BSD-163 / BSD-60: Skills im offenen Agent-Skills-Format – ein Ordner mit `SKILL.md` (YAML-Frontmatter `name`,
// `description`, weitere Felder, dann Markdown-Anweisungen) und beliebigen weiteren Dateien. Wie Swift `SkillCodec`:
// dieselbe Skill läuft in Claude Code (~/.claude/skills/<name>/), Codex und Based.
import { readZipEntries, writeZip, zipEntryData } from "@based/core";

export const SKILL_FILE = "SKILL.md";
/** Je Datei (Skills sind Anweisungen und kleine Skripte, keine Datenhalden). */
export const SKILL_MAX_FILE_BYTES = 2_000_000;
export const SKILL_MAX_FILES = 200;

/** Ein Skill-Ordner im Speicher: relativer Pfad → Bytes (`SKILL.md` eingeschlossen). */
export interface SkillFolder {
  name: string;
  files: Record<string, Uint8Array>;
}

export interface SkillDocument {
  name: string;
  description: string;
  /** Markdown nach dem Frontmatter. */
  body: string;
  /** Frontmatter-Zeilen außer name/description, unverändert (license, allowed-tools, metadata …). */
  extraFrontmatter: string;
  /** Weitere Dateien: Pfad → Bytes. */
  files: Record<string, Uint8Array>;
}

export class SkillCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillCodecError";
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: false });
const enc = new TextEncoder();

function unquote(s: string): string {
  if (s.length < 2) return s;
  const f = s[0], l = s[s.length - 1];
  if (f !== l || (f !== '"' && f !== "'")) return s;
  const inner = s.slice(1, -1);
  return f === '"' ? inner.replaceAll('\\"', '"').replaceAll("\\n", "\n") : inner.replaceAll("''", "'");
}

/** `---\n…\n---\n` vom Rumpf trennen: oberste `key: value`-Felder, übrige Zeilen wörtlich, Rumpf. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; extra: string; body: string } {
  const normalized = text.replaceAll("\r\n", "\n");
  let lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return { fields: {}, extra: "", body: normalized };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { fields: {}, extra: "", body: normalized };
  const head = lines.slice(1, end);
  lines = lines.slice(end + 1);
  if (lines[0] === "") lines.shift();
  const fields: Record<string, string> = {};
  const extra: string[] = [];
  let i = 0;
  const indented = (l: string) => l.startsWith(" ") || l.startsWith("\t");
  while (i < head.length) {
    const line = head[i]!;
    const colon = line.indexOf(":");
    if (indented(line) || colon < 0) { extra.push(line); i += 1; continue; }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    const block: string[] = [];
    let j = i + 1;
    while (j < head.length && (indented(head[j]!) || head[j] === "")) { block.push(head[j]!); j += 1; }
    if (key === "name" || key === "description") {
      if ([">", "|", ">-", "|-"].includes(value)) {
        const parts = block.map((b) => b.trim());
        value = value.startsWith(">") ? parts.filter(Boolean).join(" ") : parts.join("\n");
      } else if (block.length > 0) {
        value = [value, ...block.map((b) => b.trim())].filter(Boolean).join(" ");
      }
      fields[key] = unquote(value);
    } else {
      fields[key] = unquote(value);
      extra.push(line, ...block);
    }
    i = j;
  }
  while (extra.length > 0 && extra[extra.length - 1]!.trim() === "") extra.pop();
  return { fields, extra: extra.join("\n"), body: lines.join("\n") };
}

/** YAML-Skalar für einen einzeiligen Wert: schlicht, wenn sicher, sonst in doppelten Anführungszeichen. */
export function yamlScalar(s: string): string {
  const flat = s.replaceAll("\n", " ");
  const needs = flat === "" || /[:#{}[\],&*!|>'"%@`]/.test(flat) || flat.startsWith("-") || flat.startsWith(" ") || flat.endsWith(" ");
  return needs ? `"${flat.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : flat;
}

/** Agent-Skills-Namen: Kleinbuchstaben, Ziffern, Bindestriche, höchstens 64 Zeichen. */
export function skillFolderName(name: string): string {
  const mapped = [...name.toLowerCase()].map((c) => (/[a-z0-9]/.test(c) ? c : "-")).join("");
  const collapsed = mapped.split("-").filter(Boolean).join("-").slice(0, 64);
  return collapsed || "skill";
}

/** Relativ, im Ordner, keine versteckten Pfadteile. */
export function checkSkillPath(p: string) {
  const parts = p.split("/");
  if (p === "" || p.startsWith("/") || p.includes("\\") || parts.some((x) => x === "" || x === "." || x === "..")) throw new SkillCodecError(`Unsafe file path in the skill: ${p}`);
}

export function isTextData(d: Uint8Array): boolean {
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(d);
    return !s.includes("\u0000");
  } catch {
    return false;
  }
}

export function decodeSkill(folder: SkillFolder): SkillDocument {
  const md = folder.files[SKILL_FILE];
  if (!md) throw new SkillCodecError("The folder has no SKILL.md.");
  if (Object.keys(folder.files).length > SKILL_MAX_FILES) throw new SkillCodecError(`Too many files for a skill (${Object.keys(folder.files).length}).`);
  for (const [p, d] of Object.entries(folder.files)) if (d.length > SKILL_MAX_FILE_BYTES) throw new SkillCodecError(`File too large for a skill: ${p}`);
  const { fields, extra, body } = parseFrontmatter(utf8.decode(md));
  const name = fields.name?.trim() || folder.name.trim();
  if (!name) throw new SkillCodecError("SKILL.md has no name in its frontmatter.");
  const description = fields.description?.trim();
  if (!description) throw new SkillCodecError("SKILL.md has no description in its frontmatter.");
  const files: Record<string, Uint8Array> = {};
  for (const [p, d] of Object.entries(folder.files)) {
    if (p === SKILL_FILE) continue;
    checkSkillPath(p);
    files[p] = d;
  }
  return { name, description, body: body.replace(/^\n+|\n+$/g, ""), extraFrontmatter: extra, files };
}

export function encodeSkillMarkdown(doc: Pick<SkillDocument, "name" | "description" | "body" | "extraFrontmatter">): string {
  let head = `---\nname: ${yamlScalar(doc.name)}\ndescription: ${yamlScalar(doc.description)}\n`;
  if (doc.extraFrontmatter) head += doc.extraFrontmatter + "\n";
  return head + "---\n\n" + doc.body.replace(/^\n+|\n+$/g, "") + "\n";
}

export function encodeSkill(doc: SkillDocument): SkillFolder {
  return { name: skillFolderName(doc.name), files: { ...doc.files, [SKILL_FILE]: enc.encode(encodeSkillMarkdown(doc)) } };
}

/**
 * Skill-Ordner aus einer ZIP: entweder `SKILL.md` an der Wurzel oder ein (oder mehrere) Ordner `<name>/SKILL.md`.
 * Systemdateien (`__MACOSX`, `.DS_Store`) fallen weg.
 */
export function skillFoldersFromZip(bytes: Uint8Array, zipName = "skill"): SkillFolder[] {
  const files = new Map<string, Uint8Array>();
  for (const e of readZipEntries(bytes)) {
    if (e.path.endsWith("/") || e.path.startsWith("__MACOSX/") || e.path.split("/").some((p) => p.startsWith("."))) continue;
    files.set(e.path, zipEntryData(bytes, e));
  }
  const roots = [...files.keys()].filter((p) => p === SKILL_FILE || p.endsWith("/" + SKILL_FILE)).map((p) => p.slice(0, p.length - SKILL_FILE.length));
  if (roots.length === 0) throw new SkillCodecError("The ZIP has no SKILL.md.");
  // Ein SKILL.md im Ordner eines anderen gehört zu dessen Dateien (nur die obersten zählen).
  const top = roots.filter((r) => !roots.some((o) => o !== r && r.startsWith(o)));
  return top.map((root) => {
    const out: Record<string, Uint8Array> = {};
    for (const [p, d] of files) if (p.startsWith(root)) out[p.slice(root.length)] = d;
    const name = root ? root.replace(/\/$/, "").split("/").pop()! : zipName.replace(/\.zip$/i, "");
    return { name, files: out };
  });
}

/** Ein Skill-Ordner als ZIP (`<name>/SKILL.md …`), wie Claude Code ihn erwartet. */
export function skillFoldersToZip(folders: readonly SkillFolder[], when?: Date): Uint8Array {
  const entries = folders.flatMap((f) => Object.entries(f.files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, data]) => ({ path: `${f.name}/${p}`, data })));
  return writeZip(entries, when);
}

/** Codeblock-Sprache einer Skill-Datei (für die Unterseite). */
export function skillFileLanguage(path: string): string {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  const map: Record<string, string> = { py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", sh: "bash", bash: "bash", zsh: "bash", md: "markdown", markdown: "markdown", json: "json", yml: "yaml", yaml: "yaml", html: "html", htm: "html", swift: "swift", rb: "ruby", txt: "plain text", "": "plain text" };
  return map[ext] ?? ext;
}
