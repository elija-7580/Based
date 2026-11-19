// Datenexporte von KI-Assistenten: ChatGPT („conversations.json“ mit `mapping`) und Claude („conversations.json“ mit
// `chat_messages`, dazu `projects.json`). Jede Unterhaltung wird eine Zeile einer Datenbank, der Verlauf ihr Inhalt.
import { basename, extname, ImportFiles } from "../files.js";
import { addTable, isObj, isoCell, num, parseJSON, safeName, str, uniqueNamer, type Json, type TableExport, type TableRow } from "./table.js";

const turn = (who: string, text: string) => `**${who}**\n\n${text.trim()}\n`;
const join = (turns: string[]) => turns.join("\n---\n\n");
/** ChatGPT-Quellenmarken (privater Unicode-Bereich) aus dem Text nehmen. */
const cleanGPT = (s: string) => s.replace(/\uE200[^\uE201]*\uE201/g, "").replace(/[\uE000-\uF8FF]/g, "");

function gptPart(p: Json): string {
  if (typeof p === "string") return p;
  if (!isObj(p)) return "";
  const t = str(p.content_type);
  if (t === "image_asset_pointer") return "*[image]*";
  if (t === "audio_transcription") return str(p.text) ?? "";
  if (t === "audio_asset_pointer" || t === "real_time_user_audio_video_asset_pointer") return "";
  return str(p.text) ?? "";
}

function gptMessage(m: Record<string, Json>): { role: string; text: string } | undefined {
  const author = isObj(m.author) ? m.author : {};
  const role = str(author.role) ?? "";
  if (role !== "user" && role !== "assistant") return undefined;
  const meta = isObj(m.metadata) ? m.metadata : {};
  if (meta.is_visually_hidden_from_conversation === true || meta.is_user_system_message === true) return undefined;
  // Werkzeugaufrufe des Assistenten (recipient ≠ all) gehören nicht zum sichtbaren Verlauf
  if (role === "assistant" && str(m.recipient) !== undefined && m.recipient !== "all") return undefined;
  const c = isObj(m.content) ? m.content : {};
  const type = str(c.content_type) ?? "text";
  let text = "";
  if (type === "text" || type === "multimodal_text") text = (Array.isArray(c.parts) ? c.parts : []).map(gptPart).filter((s) => s !== "").join("\n\n");
  else if (type === "code") text = "```" + (str(c.language) && c.language !== "unknown" ? str(c.language) : "") + "\n" + (str(c.text) ?? "") + "\n```";
  else return undefined; // thoughts, reasoning_recap, execution_output, tether_quote, user_editable_context …
  text = cleanGPT(text).trim();
  return text === "" ? undefined : { role, text };
}

function gptRow(c: Record<string, Json>): TableRow | undefined {
  const mapping = isObj(c.mapping) ? c.mapping : undefined;
  if (!mapping) return undefined;
  // Der sichtbare Zweig: vom aktuellen Knoten zur Wurzel; ohne Angabe dem jeweils letzten Kind folgen.
  const path: string[] = [];
  const seen = new Set<string>();
  let at = str(c.current_node);
  if (at !== undefined && isObj(mapping[at])) {
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      path.unshift(at);
      const node: Json | undefined = mapping[at];
      at = isObj(node) ? str(node.parent) : undefined;
    }
  } else {
    at = Object.keys(mapping).find((k) => { const n = mapping[k]; return isObj(n) && (n.parent === null || n.parent === undefined); });
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      path.push(at);
      const node: Json | undefined = mapping[at];
      const kids: Json[] = isObj(node) && Array.isArray(node.children) ? node.children : [];
      at = str(kids.at(-1));
    }
  }
  const turns: string[] = [];
  let last: string | undefined;
  for (const id of path) {
    const node = mapping[id];
    const msg = isObj(node) && isObj(node.message) ? gptMessage(node.message) : undefined;
    if (!msg) continue;
    // aufeinanderfolgende Teile derselben Seite gehören zu einer Antwort
    if (msg.role === last) turns[turns.length - 1] += "\n" + msg.text + "\n";
    else turns.push(turn(msg.role === "user" ? "You" : "ChatGPT", msg.text));
    last = msg.role;
  }
  if (turns.length === 0) return undefined;
  const sec = (v: Json | undefined) => { const n = num(v); return n === undefined ? undefined : n * 1000; };
  return {
    title: str(c.title)?.trim() || "Untitled chat",
    cells: [isoCell(sec(c.create_time)), isoCell(sec(c.update_time)), str(c.default_model_slug)],
    body: join(turns),
  };
}

function claudeText(m: Record<string, Json>): string {
  const parts = Array.isArray(m.content) ? m.content.filter(isObj) : [];
  const text = parts.filter((p) => p.type === "text").map((p) => str(p.text) ?? "").filter((s) => s.trim() !== "").join("\n\n");
  let out = text !== "" ? text : str(m.text) ?? "";
  const names = [...(Array.isArray(m.attachments) ? m.attachments : []), ...(Array.isArray(m.files) ? m.files : [])]
    .map((a) => (isObj(a) ? str(a.file_name) : undefined)).filter((s): s is string => s !== undefined && s !== "");
  if (names.length > 0) out += `\n\n*Attached: ${[...new Set(names)].join(", ")}*`;
  return out.trim();
}

function claudeRow(c: Record<string, Json>): TableRow | undefined {
  const msgs = Array.isArray(c.chat_messages) ? c.chat_messages.filter(isObj) : [];
  const turns: string[] = [];
  for (const m of msgs) {
    const text = claudeText(m);
    if (text === "") continue;
    turns.push(turn(m.sender === "human" ? "You" : "Claude", text));
  }
  if (turns.length === 0) return undefined;
  const ms = (v: Json | undefined) => { const s = str(v); const t = s === undefined ? NaN : Date.parse(s); return Number.isNaN(t) ? undefined : t; };
  return { title: str(c.name)?.trim() || "Untitled chat", cells: [isoCell(ms(c.created_at)), isoCell(ms(c.updated_at)), undefined], body: join(turns) };
}

/** Dateien eines Assistenten-Exports unter `root` (direkt oder eine Ebene tiefer). */
function conversationFiles(files: ImportFiles, root: string): string[] {
  const prefix = root === "" ? "" : root + "/";
  return files.walk(root).filter((f) => {
    const rel = f.slice(prefix.length);
    return rel.split("/").length <= 2 && /^conversations(-\d+)?\.json$/i.test(basename(f));
  }).sort();
}

export function convertChats(files: ImportFiles, root: string): { files: ImportFiles; note: string } | undefined {
  const found = conversationFiles(files, root);
  if (found.length === 0) return undefined;
  const gpt: TableRow[] = [], claude: TableRow[] = [];
  let recognised = false;
  for (const f of found) {
    const data = parseJSON(files.readText(f));
    if (!Array.isArray(data)) continue;
    for (const c of data) {
      if (!isObj(c)) continue;
      if (isObj(c.mapping)) { recognised = true; const r = gptRow(c); if (r) gpt.push(r); }
      else if (Array.isArray(c.chat_messages)) { recognised = true; const r = claudeRow(c); if (r) claude.push(r); }
    }
  }
  if (!recognised) return undefined;
  const out = new ImportFiles();
  const columns: TableExport["columns"] = [{ name: "Created", type: "date" }, { name: "Updated", type: "date" }];
  if (gpt.length > 0) addTable(out, { name: "ChatGPT", titleColumn: "Chat", columns: [...columns, { name: "Model", type: "select" }], rows: gpt });
  if (claude.length > 0) addTable(out, { name: "Claude", titleColumn: "Chat", columns, rows: claude.map((r) => ({ ...r, cells: r.cells.slice(0, 2) })) });
  // Claude: Projekte mit ihren Dokumenten als Seiten
  let docs = 0;
  const dir = found[0]!.includes("/") ? found[0]!.slice(0, found[0]!.lastIndexOf("/") + 1) : "";
  const projects = parseJSON(files.readText(dir + "projects.json"));
  if (claude.length > 0 && Array.isArray(projects)) {
    const projectName = uniqueNamer();
    const enc = new TextEncoder();
    for (const p of projects) {
      if (!isObj(p)) continue;
      const list = Array.isArray(p.docs) ? p.docs.filter(isObj) : [];
      if (list.length === 0) continue;
      const folder = "Claude projects/" + projectName(safeName(str(p.name) ?? "", "Project"));
      const docName = uniqueNamer();
      for (const d of list) {
        const content = str(d.content) ?? "";
        if (content.trim() === "") continue;
        const fileName = str(d.filename) ?? "Document";
        const ext = extname(fileName).toLowerCase();
        const text = ext === "" || ext === "md" || ext === "markdown" || ext === "txt" ? content : "```" + ext + "\n" + content + "\n```\n";
        out.add(`${folder}/${docName(safeName(fileName.replace(/\.(md|markdown|txt)$/i, ""), "Document"))}.md`, enc.encode(text));
        docs += 1;
      }
    }
  }
  const parts = [gpt.length > 0 ? `${gpt.length} ChatGPT chats` : "", claude.length > 0 ? `${claude.length} Claude chats` : "", docs > 0 ? `${docs} project documents` : ""].filter((s) => s !== "");
  return { files: out, note: parts.length > 0 ? `AI assistant export: ${parts.join(", ")}` : "AI assistant export: no chats with messages found" };
}
