import { describe, expect, it } from "vitest";
import {
  decodeSkill, encodeSkill, encodeSkillMarkdown, parseFrontmatter, skillFolderName, skillFoldersFromZip, skillFoldersToZip, skillsPrompt, SkillCodecError, SkillRouter,
  type RoutableSkill,
} from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (d: Uint8Array) => new TextDecoder().decode(d);

describe("SKILL.md codec", () => {
  it("reads name, description (folded) and keeps other frontmatter verbatim", () => {
    const md = "---\nname: weekly-review\ndescription: >\n  Reflect on the week\n  and plan the next.\nlicense: MIT\nmetadata:\n  author: me\n---\n\n# Weekly review\n\nSteps…\n";
    const { fields, extra, body } = parseFrontmatter(md);
    expect(fields.name).toBe("weekly-review");
    expect(fields.description).toBe("Reflect on the week and plan the next.");
    expect(extra).toBe("license: MIT\nmetadata:\n  author: me");
    expect(body).toBe("# Weekly review\n\nSteps…\n");
  });

  it("round-trips a folder with extra files", () => {
    const folder = { name: "x", files: { "SKILL.md": enc("---\nname: \"PDF: fill forms\"\ndescription: Fill PDF forms\nallowed-tools: Bash\n---\nUse the script.\n"), "scripts/fill.py": enc("print('hi')\n") } };
    const doc = decodeSkill(folder);
    expect(doc).toMatchObject({ name: "PDF: fill forms", description: "Fill PDF forms", body: "Use the script.", extraFrontmatter: "allowed-tools: Bash" });
    const out = encodeSkill(doc);
    expect(out.name).toBe("pdf-fill-forms");
    expect(dec(out.files["SKILL.md"]!)).toBe('---\nname: "PDF: fill forms"\ndescription: Fill PDF forms\nallowed-tools: Bash\n---\n\nUse the script.\n');
    expect(decodeSkill(out)).toEqual(doc);
  });

  it("rejects missing fields and unsafe paths", () => {
    expect(() => decodeSkill({ name: "a", files: {} })).toThrow(SkillCodecError);
    expect(() => decodeSkill({ name: "a", files: { "SKILL.md": enc("---\nname: a\n---\nx") } })).toThrow(/description/);
    expect(() => decodeSkill({ name: "a", files: { "SKILL.md": enc("---\nname: a\ndescription: b\n---\n"), "../evil.sh": enc("x") } })).toThrow(/Unsafe/);
  });

  it("imports and exports ZIPs (root SKILL.md or one folder per skill)", () => {
    const a = encodeSkill({ name: "Alpha", description: "First", body: "A", extraFrontmatter: "", files: { "ref.md": enc("r") } });
    const b = encodeSkill({ name: "Beta", description: "Second", body: "B", extraFrontmatter: "", files: {} });
    const zip = skillFoldersToZip([a, b]);
    const back = skillFoldersFromZip(zip);
    expect(back.map((f) => f.name).sort()).toEqual(["alpha", "beta"]);
    expect(Object.keys(back.find((f) => f.name === "alpha")!.files).sort()).toEqual(["SKILL.md", "ref.md"]);
    const single = skillFoldersFromZip(skillFoldersToZip([a]).slice(0)); // Ordner in der ZIP
    expect(decodeSkill(single[0]!).name).toBe("Alpha");
    expect(skillFolderName("Äpfel & Birnen!")).toBe("pfel-birnen");
    expect(encodeSkillMarkdown({ name: "n", description: "d", body: "\n\nb\n\n", extraFrontmatter: "" })).toBe("---\nname: n\ndescription: d\n---\n\nb\n");
  });
});

// Fixture: Paare ähnlicher Nachbar-Skills, damit die Auswahl trennen muss.
const SKILLS: RoutableSkill[] = [
  { id: "weekly-review", name: "weekly-review", description: "Reflect on the past week: wins, problems, lessons, and plan priorities for next week.", body: "## Steps\n1. List what got done this week.\n2. Note what went wrong and why.\n3. Pick three priorities for next week." },
  { id: "newsletter", name: "weekly-newsletter", description: "Write the weekly newsletter email for subscribers with links and a short intro.", body: "## Format\nGreeting, three links with one-line summaries, sign-off. Tone: friendly, short." },
  { id: "meeting-notes", name: "meeting-notes", description: "Turn a meeting transcript into notes with decisions and action items.", body: "## Output\n- Attendees\n- Decisions\n- Action items with owner and due date" },
  { id: "meeting-invite", name: "meeting-invite", description: "Draft a calendar invitation for a meeting with agenda and dial-in.", body: "## Invitation\nSubject line, time zone, agenda bullets, video link." },
  { id: "invoice", name: "invoice-check", description: "Check an invoice: amounts, VAT, IBAN and due date.", body: "## Checks\nSum of line items equals total. VAT rate 19% or 7%. Rechnung prüfen: Betrag, Mehrwertsteuer." },
  { id: "translate", name: "translate-de-en", description: "Translate text between German and English, keep formatting.", body: "## Rules\nKeep Markdown. Übersetzen ohne Kommentare." },
  { id: "pdf", name: "pdf-forms", description: "Fill in PDF forms from page data.", body: "## How\nRead the fields, map values, export the filled PDF." },
  { id: "disabled", name: "old-review", description: "Old weekly review", body: "", enabled: false },
];

describe("skill router (BSD-198)", () => {
  const router = new SkillRouter(SKILLS);

  it("small catalog: no preselection, every enabled skill is a candidate", () => {
    const r = router.route("anything");
    expect(r.preselected).toBe(false);
    expect(r.candidates).toHaveLength(7);
    expect(r.candidates.some((c) => c.id === "disabled")).toBe(false);
  });

  const cases: [string, string, string][] = [
    ["Help me do my weekly review and plan priorities for next week", "weekly-review", "newsletter"],
    ["Write this week's newsletter email for our subscribers", "newsletter", "weekly-review"],
    ["Here is the transcript, make meeting notes with action items", "meeting-notes", "meeting-invite"],
    ["Draft an invitation for Thursday's meeting with an agenda", "meeting-invite", "meeting-notes"],
    ["Kannst du diese Rechnung prüfen? Stimmt die Mehrwertsteuer?", "invoice", "translate"],
    ["Übersetzen bitte ins Englische, Formatierung behalten", "translate", "invoice"],
  ];
  for (const [query, want, neighbor] of cases) {
    it(`picks ${want} and rejects its neighbor ${neighbor}`, () => {
      const r = router.route(query);
      expect(r.selected[0]?.id).toBe(want);
      expect(r.selected.map((s) => s.id)).not.toContain(neighbor);
      expect(r.candidates[0]!.id).toBe(want);
    });
  }

  it("selects nothing for an unrelated request", () => {
    expect(router.route("What's the capital of France?").selected).toEqual([]);
    expect(router.route("").selected).toEqual([]);
  });

  it("uses the skill body, not only name and description", () => {
    // „VAT rate“ steht nur im Rumpf von invoice-check.
    expect(router.route("which VAT rate applies, 19% or 7%?").selected[0]?.id).toBe("invoice");
  });

  it("large catalog: top-5 candidates", () => {
    const many: RoutableSkill[] = [...SKILLS];
    for (let i = 0; i < 20; i++) many.push({ id: `filler-${i}`, name: `filler-${i}`, description: `Unrelated helper number ${i} for gardening topic ${i}`, body: "Water plants." });
    const r = new SkillRouter(many).route("weekly review of priorities");
    expect(r.preselected).toBe(true);
    expect(r.candidates).toHaveLength(5);
    expect(r.candidates[0]!.id).toBe("weekly-review");
  });

  it("learns from corrections (removed skill loses, added skill wins on similar requests)", () => {
    const q = "plan the week ahead";
    const before = router.route(q);
    const corrections = [{ query: "plan my week ahead please", added: ["meeting-invite"], removed: ["weekly-review"], at: 1 }];
    const after = router.route(q, { corrections });
    expect(after.selected.map((s) => s.id)).not.toContain("weekly-review");
    expect(after.selected[0]?.id).toBe("meeting-invite");
    expect(after.candidates.findIndex((c) => c.id === "meeting-invite")).toBeLessThan(before.candidates.findIndex((c) => c.id === "meeting-invite"));
  });

  it("dense similarities from a local model can be added", () => {
    const r = router.route("something vague", { dense: new Map([["pdf", 0.9]]) });
    expect(r.selected[0]?.id).toBe("pdf");
  });

  it("builds the system prompt: selected in full, others by description", () => {
    const p = skillsPrompt([SKILLS[0]!], router.route("weekly review").candidates.slice(0, 3));
    expect(p).toContain("## Skill: weekly-review");
    expect(p).toContain("Pick three priorities");
    expect(p).toContain("load_skill");
    expect(p).not.toMatch(/- weekly-review:/);
  });
});
