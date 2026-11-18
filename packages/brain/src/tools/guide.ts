// Anleitung für Agenten (wie Notions MCP): kurze Themen, die ein Modell bei Bedarf nachliest (`based_guide`, und als
// Ressourcen based://docs/<topic>).
import { obj, optStr, str, ToolError, type ToolDef } from "./base.js";

export const GUIDE: Record<string, string> = {
  overview: `# Based overview
A workspace holds pages. A page contains blocks (paragraphs, headings, lists, to-dos, toggles, quotes, callouts, code,
images, tables) and sub-pages. Databases hold rows; each row is a page with properties. Everything syncs between
devices through the Based server (last writer wins per record).`,
  markdown: `# Markdown in Based
Supported: # / ## / ### headings, paragraphs, - bullets, 1. numbered lists, - [ ] / - [x] to-dos, > quotes,
> [!NOTE] callouts, \`\`\`code\`\`\` blocks, tables, ---, images ![alt](url), **bold**, *italic*, ~~strike~~, \`code\`,
[links](https://…). Link to another page with [Title](based://page/<id>): it becomes a mention. Indent by 4 spaces to nest.`,
  brain: `# Agent Brain
The page "Agent Brain" holds what agents know about the user: "About me" (profile, written by the user), the database
"Memories" (one row per fact, with Type and Status) and "Skills" (available as prompts). Everything is ordinary pages the
user can read and edit.

recall(query, about?) – use it first. It merges word search (typos allowed), search by meaning (when the user switched the
local model on) and one step along the links of the best hits. It returns memories, pages with a passage and block id, each
page's neighbours by kind of link, and pages that connect several hits. Pass \`about\` (a page id) to stay around one page;
with an empty query it lists that page's surroundings. Read a page with read_page before relying on details.

related(id) – neighbours of a page with ids: database relations (with the column name), mentions in both directions,
parent and sub-pages.

remember(fact, type?, about?, source?, replaces?, detail?) – one durable fact per call, one sentence, written so it makes
sense on its own ("Elija prefers answers in German"). Not for things that only matter in this conversation.
- \`about\`: ids of the pages it concerns (person, project, topic). They become links, so the fact shows up around those pages.
- Call recall first. If a fact changed, pass the old memory's id as \`replaces\`: the old one is kept as Superseded.
- The same fact is never stored twice; you get the existing memory back.
- Health, money and similar private facts are stored as "To review" and only count once the user sets them to Active.
Types: Profile, Preference, Work, People, Notes.`,
  safety: `# Safety
Prefer appending over replacing. Never empty pages or move many pages without the user asking. trash_page is reversible;
nothing here deletes forever.`,
};

export function guideTools(): ToolDef[] {
  return [
    {
      group: "pages", write: false,
      spec: { name: "based_guide", description: `How Based works, by topic (${Object.keys(GUIDE).join(", ")}).`, inputSchema: obj({ topic: str(`One of: ${Object.keys(GUIDE).join(", ")} (default overview)`) }) },
      run: (a) => {
        const t = optStr(a, "topic") ?? "overview";
        const g = GUIDE[t];
        if (!g) throw new ToolError(`Unknown topic ${t}. Topics: ${Object.keys(GUIDE).join(", ")}`);
        return g;
      },
    },
  ];
}
