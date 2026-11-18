#!/usr/bin/env node
// Builds the static site for basednotes.app from the design artboards in src/pages/*.dc.html.
//
//   node apps/website/scripts/build.mjs          → apps/website/public/
//
// The artboards stay exactly as they come from the design canvas; everything that
// differs on the real site (links, fonts, logo files, waitlist call, legal links) is
// applied here as small, named patches, so a new canvas export can be dropped in.
// If Google Chrome is installed, every page is prerendered (content visible without
// JavaScript and for search engines); otherwise the pages render in the browser.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const OUT = process.env.WEBSITE_OUT || join(ROOT, "public");
const SITE = "https://basednotes.app";
const SPONSORS = "https://github.com/sponsors/elija-7580";

// Artboard → URL path. Mobile.dc.html is the phone version of the home page.
const PAGES = [
  { file: "Main.dc.html", path: "/", out: "index.html", mobile: "Mobile.dc.html" },
  { file: "Workspace.dc.html", path: "/workspace", out: "workspace/index.html" },
  { file: "Agents.dc.html", path: "/agents", out: "agents/index.html" },
  { file: "Switch.dc.html", path: "/leaving-notion", out: "leaving-notion/index.html" },
  { file: "Roadmap.dc.html", path: "/roadmap", out: "roadmap/index.html" },
  { file: "Manifesto.dc.html", path: "/manifesto", out: "manifesto/index.html" }
];
const LINKS = Object.fromEntries(PAGES.map((p) => [p.file, p.path]));
LINKS["Mobile.dc.html"] = "/";

// Search titles and descriptions (BSD-457). The artboards keep their own; these win on the site.
// Descriptions stay ≤ 155 characters and only promise what the Mac beta can do (docs/website-claims.md).
const META = {
  "/": {
    title: "Based Notes · The local-first Notion alternative for Mac",
    description: "Fast, private notes and databases on your own Mac. Import your whole Notion workspace, no account needed. Open source, free Mac beta."
  },
  "/workspace": {
    title: "Based Workspace · Big databases, zero waiting",
    description: "Tables, boards, timelines and calendars with relations, rollups and formulas. Offline on your Mac, fast with tens of thousands of rows."
  },
  "/agents": {
    title: "Based Agents · Opt-in AI for your workspace",
    description: "Opt-in agents that work inside your Based workspace with your own keys. Planned after the Mac beta; the beta ships without AI."
  },
  "/leaving-notion": {
    title: "Leaving Notion? Import your workspace into Based",
    description: "Move from Notion to Based: drop in your export ZIP and pages, databases, relations and nesting are rebuilt on your Mac."
  },
  "/roadmap": {
    title: "Based Roadmap · What ships next",
    description: "What is in the Based Mac beta, what comes next and what you can vote on. Generated from our public backlog."
  },
  "/manifesto": {
    title: "Based Manifesto · Rebuilding knowledge work",
    description: "Why we are rebuilding knowledge work, starting with what Notion got right: your data on your devices, open source, built in Europe."
  }
};

// Structured data for the home page: the app itself.
const APP_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Based Notes",
  alternateName: "Based",
  url: SITE + "/",
  applicationCategory: "ProductivityApplication",
  operatingSystem: "macOS 13 or later",
  description: META["/"].description,
  offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
  license: "https://www.gnu.org/licenses/agpl-3.0.html"
};
const ldScript = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;

// Plain English pages next to the artboards (same header, footer and styles as the legal pages).
// download stays out of search and the sitemap until Elija links it from the invitations.
const INFO = [
  { name: "faq", path: "/faq", index: true,
    title: "Based Notes FAQ · Questions about the Mac beta",
    description: "Is the Based beta free, where is my data, can I import from Notion, what is not in the beta yet? Short answers." },
  { name: "download", path: "/download", index: false,
    title: "Download the Based Notes beta for Mac",
    description: "Download Based Notes Beta for macOS, install it and send feedback." }
];

const stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// FAQPage data from the page itself: every <h2> is a question, the text up to the next <h2> its answer.
function faqLd(html) {
  const parts = html.split(/<h2>/).slice(1).map((chunk) => {
    const [q, rest] = chunk.split("</h2>");
    return { "@type": "Question", name: stripTags(q),
      acceptedAnswer: { "@type": "Answer", text: stripTags(rest.replace(/<p class="meta">[\s\S]*$/, "")) } };
  });
  return { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: parts };
}

const read = (p) => readFileSync(p, "utf8");
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);

function must(src, find, replace, label) {
  if (!src.includes(find)) throw new Error(`patch "${label}" did not match`);
  return src.split(find).join(replace);
}

function parse(file) {
  const src = read(join(SRC, "pages", file));
  const title = /<title>([\s\S]*?)<\/title>/.exec(src)[1];
  const description = /<meta name="description" content="([^"]*)">/.exec(src)?.[1] ?? "";
  const helmet = /<helmet>([\s\S]*?)<\/helmet>/.exec(src)[1];
  const css = /<style>([\s\S]*?)<\/style>/.exec(helmet)[1];
  const body = /<\/helmet>([\s\S]*?)<\/x-dc>/.exec(src)[1];
  const script = /<script type="text\/x-dc" data-dc-script data-props='([^']*)'>([\s\S]*?)<\/script>/.exec(src);
  return { title, description, css, body, props: JSON.parse(script[1]), code: script[2] };
}

// ---- patches applied to every page -------------------------------------------------
const MARK_LIGHT = "/_blob/c3ccc021887376abcf7fe08d0002d913";
const MARK_DARK = "/_blob/60426240b69c9dab9372c2741257d898";

function patchLinks(s) {
  s = s.replace(/href="([A-Za-z]+\.dc\.html)(\?desktop)?(#[^"]*)?"/g, (_, f, q, h) => {
    if (!(f in LINKS)) throw new Error("unknown page link " + f);
    return `href="${LINKS[f]}${q || ""}${h || ""}"`;
  });
  s = s.replace(/<a href="#" class="navlink">Privacy \[LINK\]<\/a>/g, '<a href="/privacy" class="navlink">Privacy</a>');
  s = s.replace(/<a href="#" class="navlink">Imprint \[LINK\]<\/a>/g, '<a href="/imprint" class="navlink">Imprint</a>');
  if (s.includes("[LINK]")) throw new Error("a [LINK] placeholder is left");
  return s;
}
// Header menus (desktop and phone sheet) lead with the notes app; Agents stays in the footer and on the home page.
// The footer tagline follows the same framing on every page.
function patchNav(s) {
  s = s.split("Databases, docs and agents. Instant, private, everywhere. Built in Vienna.")
    .join("Your data. Based. Notes and databases on your own Mac. Built in Vienna.");
  // Donations in focus (Elija 17.11.): "Sponsor" in the header menus and in the footer's "Open" column.
  s = s.replace(/(<footer[\s\S]*?<a href="https:\/\/github\.com\/elija-7580\/Based" class="navlink">GitHub<\/a>\n)/,
    `$1<a href="${SPONSORS}" class="navlink">Sponsor Based</a>\n`);
  return s.replace(/<header[\s\S]*?<\/header>/, (h) => h
    .replace(/<a href="\/agents" class="navlink[^"]*">Agents<\/a>\n?/, "")
    .replace(/<a href="\/agents">Agents<\/a>\n?/, "")
    .replace(/(<a href="https:\/\/github\.com\/elija-7580\/Based" class="navlink">GitHub<\/a>\n)/, `$1<a href="${SPONSORS}" class="navlink" style="display: inline-flex; align-items: center; gap: 6px; color: var(--ink); font-weight: 600;"><svg width="12" height="12" viewBox="0 0 24 24" fill="#E0C24A" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.5-9.2C1.1 8.5 3.2 5 6.6 5c2 0 3.4 1.1 4.4 2.5C12 6.1 13.4 5 15.4 5c3.4 0 5.5 3.5 4.1 6.8C19.5 16.4 12 21 12 21z"/></svg>Sponsor</a>\n`)
    .replace(/(<a href="https:\/\/github\.com\/elija-7580\/Based">GitHub<\/a>\n)/, `$1<a href="${SPONSORS}">Sponsor Based</a>\n`));
}
const patchAssets = (s) => s.split(MARK_LIGHT).join("/mark.svg").split(MARK_DARK).join("/mark-dark.svg");

// ---- logo intro (Elija 17.11.): the mark in the header "types" itself once on every page ----
// Same order as in the app (apps/web/src/components/logoTimeline.ts): the base line draws in one stroke, a caret
// blinks, the stem lands, then the bowl; the line gives a little and the blocks rock and settle. Done in CSS because
// dc-lite morphs the DOM on every state change and only CSS animations survive that. `html.lg-intro` starts it;
// site.js removes the class when the intro is over and the mark rests. Hovering then gives one "keystroke" (the line
// gives, the blocks rock). The canvas's own pop animations (bsdStem, bsdBowl) are switched off everywhere: typing,
// not bouncing. Sizes are tuned for the 34 px mark (a little stronger than in the app).
const LOGO_SVG_OLD = '<svg class="logo-svg" aria-hidden="true" width="34" height="34" viewBox="0 0 100 100"><rect x="10" y="80" width="80" height="9" rx="4.5" fill="#E7CE6A"></rect><rect class="lg-stem" x="20" y="7" width="16" height="68" rx="8" fill="var(--ink)"></rect><rect class="lg-bowl" x="40" y="37" width="38" height="38" rx="14" fill="var(--ink)"></rect></svg>';
const LOGO_SVG_NEW = '<svg class="logo-svg" aria-hidden="true" width="34" height="34" viewBox="0 0 100 100"><g class="lg-dip"><g class="lg-dip2"><line class="lg-base" x1="14.5" y1="84.5" x2="85.5" y2="84.5" pathLength="100" stroke="#E7CE6A" stroke-width="9" stroke-linecap="round"></line><rect class="lg-stem" x="20" y="7" width="16" height="68" rx="8" fill="var(--ink)"></rect><rect class="lg-bowl" x="40" y="37" width="38" height="38" rx="14" fill="var(--ink)"></rect><rect class="lg-caret" x="20" y="9" width="3.2" height="66" rx="1.6" fill="var(--ink)"></rect></g></g></svg>';
const LOGO_INTRO_MS = 3600; // stem key 1500 + bowl 360 later + settling; site.js waits a little longer
const LOGO_INTRO_CSS = `
.bsd .logo-svg{overflow:visible}
.bsd .logo-svg .lg-caret{opacity:0}
.bsd .logo-svg .lg-stem,.bsd .logo-svg .lg-bowl,.bsd .logo-link:hover .lg-stem,.bsd .logo-link:hover .lg-bowl{animation:none}
@media (prefers-reduced-motion: no-preference){
.bsd .logo-link:hover .lg-stem{animation:bsdLgTapStem 800ms ease-in-out both}
.bsd .logo-link:hover .lg-bowl{animation:bsdLgTapBowl 800ms ease-in-out 90ms both}
.bsd .logo-link:hover .lg-dip{animation:bsdLgDip 520ms ease-in-out both}
html.lg-intro .bsd .logo-svg .lg-base{stroke-dasharray:100;animation:bsdLgLine 600ms cubic-bezier(.17,.84,.44,1) 150ms both}
html.lg-intro .bsd .logo-svg .lg-stem,html.lg-intro .bsd .logo-link:hover .lg-stem{animation:bsdLgStem 1700ms ease-in-out 1500ms both}
html.lg-intro .bsd .logo-svg .lg-bowl,html.lg-intro .bsd .logo-link:hover .lg-bowl{animation:bsdLgBowl 1700ms ease-in-out 1860ms both}
html.lg-intro .bsd .logo-svg .lg-caret{animation:bsdLgCaret 2440ms linear 760ms both}
html.lg-intro .bsd .logo-svg .lg-dip,html.lg-intro .bsd .logo-link:hover .lg-dip{animation:bsdLgDip 520ms ease-in-out 1610ms both}
html.lg-intro .bsd .logo-svg .lg-dip2{animation:bsdLgDip 520ms ease-in-out 1970ms both}
}
@keyframes bsdLgLine{from{stroke-dashoffset:99.9}to{stroke-dashoffset:0}}
@keyframes bsdLgStem{0%{opacity:0;transform:translateY(-8px)}.1%{opacity:1;transform:translateY(-8px);animation-timing-function:ease-in}6.5%{opacity:1;transform:none}11.3%{transform:rotate(5deg)}20.9%{transform:rotate(-2.9deg)}30.5%{transform:rotate(1.6deg)}40.1%{transform:rotate(-.9deg)}49.7%{transform:rotate(.5deg)}59.4%{transform:rotate(-.25deg)}70.6%,100%{opacity:1;transform:none}}
@keyframes bsdLgBowl{0%{opacity:0;transform:translateY(-8px)}.1%{opacity:1;transform:translateY(-8px);animation-timing-function:ease-in}6.5%{opacity:1;transform:none}11.3%{transform:rotate(3.5deg)}20.9%{transform:rotate(-2deg)}30.5%{transform:rotate(1.1deg)}40.1%{transform:rotate(-.6deg)}49.7%{transform:rotate(.35deg)}59.4%{transform:rotate(-.2deg)}70.6%,100%{opacity:1;transform:none}}
@keyframes bsdLgTapStem{0%{transform:none}14%{transform:rotate(4deg)}32%{transform:rotate(-2.3deg)}50%{transform:rotate(1.3deg)}68%{transform:rotate(-.7deg)}84%{transform:rotate(.3deg)}100%{transform:none}}
@keyframes bsdLgTapBowl{0%{transform:none}14%{transform:rotate(2.8deg)}32%{transform:rotate(-1.6deg)}50%{transform:rotate(.9deg)}68%{transform:rotate(-.5deg)}84%{transform:rotate(.2deg)}100%{transform:none}}
@keyframes bsdLgDip{0%{transform:none}17%{transform:translateY(3px)}45%{transform:translateY(-1px)}70%{transform:translateY(.4px)}100%{transform:none}}
@keyframes bsdLgCaret{0%{opacity:0;transform:none}.1%{opacity:1}15.6%{opacity:1}26%{opacity:0}30.2%{opacity:0;transform:none}30.3%{opacity:1;transform:translateX(20px)}45%{opacity:1;transform:translateX(20px)}45.1%{opacity:1;transform:translateX(62px)}60.7%{opacity:1}73%{opacity:0}82%{opacity:0}90%{opacity:.7}100%{opacity:0;transform:translateX(62px)}}
`;

// ---- page-specific patches ----------------------------------------------------------
const CONSENT_DESKTOP =
  '<input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" class="sr">' +
  '<p style="margin: 2px 8px 4px; font-size: 12.5px; line-height: 1.45; color: var(--muted);">We only use your email to tell you when the beta opens. Unsubscribe any time. <a href="/privacy" style="color: var(--muted);">Privacy</a></p>';
const CONSENT_MOBILE =
  '<input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" class="sr">' +
  '<p style="margin: 0; font-size: 12.5px; line-height: 1.45; opacity: .8;">We only use your email to tell you when the beta opens. Unsubscribe any time. <a href="/privacy" style="color: inherit;">Privacy</a></p>';
const WAITLIST_CALL = "const reply = this.composeReply(); window.basedSite && window.basedSite.waitlist(this, e);";

const PAGE_PATCHES = {
  "Main.dc.html": (p) => {
    p.body = must(p.body, '<button type="submit" class="btn" style="min-height: 50px;">Join the beta</button>',
      '<button type="submit" class="btn" style="min-height: 50px;">Join the beta</button>' + CONSENT_DESKTOP, "main consent");
    p.code = must(p.code, "const reply = this.composeReply();", WAITLIST_CALL, "main waitlist");
    // Prerendered HTML (search engines, no JavaScript) shows the final numbers; the browser still counts up.
    p.code = must(p.code, "statsT: 0,", "statsT: window.__DC_PRERENDER ? 1 : 0,", "main stats prerender");
  },
  "Mobile.dc.html": (p) => {
    const btn = /<button type="submit" class="mb-full"[^>]*>Join the beta<\/button>/.exec(p.body)[0];
    p.body = must(p.body, btn, btn + CONSENT_MOBILE, "mobile consent");
    p.code = must(p.code, "const reply = this.composeReply();", WAITLIST_CALL, "mobile waitlist");
  },
  "Roadmap.dc.html": (p) => {
    p.code = must(p.code, "const key = 'idea:' + Date.now();",
      "const key = 'idea:' + Date.now(); window.basedSite && window.basedSite.idea(t, s.draftArea, e);", "roadmap idea");
    p.body = must(p.body, "Thanks. Your idea is in the Ideas column. In the live version it goes straight to our backlog and we'll tell you when it ships.",
      "Thanks. Your idea is in the Ideas column, and it has reached us. We read every one, and the good ones land in the backlog.", "roadmap thanks");
    p.body = must(p.body, "The live roadmap is generated from our public backlog, so it is always current.",
      "The roadmap is generated from our public backlog. Votes are counted on your device for now.", "roadmap note");
  }
};

// ---- claims: only promise what the Mac beta can do (BSD-434, docs/website-claims.md) ----
// Decided by Elija on 16.11.: agents and offline transcription move from "Beta" to "Release",
// iCloud is a preview, 100,000 rows stay (BSD-435), feature numbers follow replica/features.csv,
// "a drive you choose" waits for BSD-449. Each entry: [text on the artboard, text on the site].
// Strings inside the page scripts are single-quoted JavaScript: no plain apostrophes in replacements.
const BETA_LIST_OLD = ["Sync between your Apple devices through iCloud", "Agents with your own keys, opt-in", "Meeting notes transcribed on your Mac, offline"];
const CLAIMS = {
  // Main.dc.html and Mobile.dc.html: reframed on 17.11.2026 ("Your data. Based."); their texts already keep to the beta.
  "Workspace.dc.html": [
    // 17.11. (framing): phone and encrypted server come with the release, so the heading says so
    ['<h2 id="sync-title" class="h2">Your phone gets everything. The server gets gibberish.</h2>',
      '<h2 id="sync-title" class="h2">At release, your phone gets everything. The server gets gibberish.</h2>'],
    ["The beta syncs your Apple devices through iCloud.", "In the beta, your Macs can sync through iCloud Drive as a preview."],
    ["by release. iCloud in the beta.</span>", "by release. iCloud Drive sync as a preview in the beta.</span>"],
    ["d: 'iCloud in the beta. At release, Based Cloud on EU servers, end-to-end encrypted. Lose your laptop, keep your work.'",
      "d: 'At release: Based Cloud on EU servers, end-to-end encrypted. Lose your laptop, keep your work. In the beta, iCloud Drive sync as a preview.'"],
    ["d: 'Automatic snapshots to a drive or folder you choose, as a readable archive.'",
      "d: 'Automatic snapshots to a folder on your Mac, as a readable archive.'"],
    ["it lives in three places, nothing gets deleted behind your back, and restoring is a click.",
      "it lives on your Mac and in a backup folder, with an encrypted cloud copy at release. Nothing gets deleted behind your back, and restoring is a click."],
    ["Agents write to it through the CLI or MCP.", "Agents write to it through MCP (CLI coming)."],
    ["Yellow ticks are agent edits. Each one can be undone on its own.", "Yellow ticks are agent edits. Restore any earlier version."],
    ["d: 'Every row opens as a full page with blocks, sub-pages and comments.'", "d: 'Every row opens as a full page with blocks and sub-pages.'"]
  ],
  "Switch.dc.html": [
    // 17.11. (framing): a moving guide, not "Based is the good part of Notion"
    ['aria-label="Love Notion? Keep the good part."', 'aria-label="Leaving Notion? Bring it all."'],
    ["hw1: Component.words('Love Notion?', 0, 120)", "hw1: Component.words('Leaving Notion?', 0, 120)"],
    ["hw2: Component.words('Keep the good part.', 380, 140)", "hw2: Component.words('Bring it all.', 380, 140)"],
    ["You love how Notion works. Pages, blocks, databases, the slash menu. This page is about everything else:",
      "Pages, blocks, databases and the slash menu are a good way to work. This page is about the rest:"],
    ["b: [3, 'Every version kept, three copies, restore in one click.']",
      "b: [3, 'Every version kept, automatic backups on your Mac, the encrypted cloud copy at release.']"],
    ["b: [1, 'Beta is Mac only with iCloud. Phone, web and Based Cloud come with the release.']",
      "b: [1, 'Beta is Mac only, iCloud Drive sync as a preview. Phone, web and Based Cloud come with the release.']"],
    ["based: 'Three copies: your device, your encrypted cloud and automatic snapshots to a folder you choose. Restore is one click.'",
      "based: 'Your Mac and automatic snapshots to a backup folder today, an encrypted cloud copy at release. Restore from any snapshot.'"],
    ["Agent edits can be undone one by one.", "Agent edits are marked, and any earlier version can be restored."],
    ["based: 'Connect the ChatGPT or Claude account you already pay for, an API key or a local model. Or switch AI off entirely.'",
      "based: 'After the beta: the ChatGPT login or Claude Code CLI you already have, or an API key. Local models later. Or keep AI off entirely.'"]
  ],
  "Agents.dc.html": [
    // 17.11. (framing): the notes app comes first, agents are the next chapter after the beta
    ['<span class="bar" style="height: 14px;"></span>Opt-in. Off until you switch it on.</p>',
      '<span class="bar" style="height: 14px;"></span>After the beta, and only if you want them.</p>'],
    ["Connect the ChatGPT or Claude account you already pay for, plug in an API key, or drive the coding CLIs you already use.",
      "Use the ChatGPT login or the Claude Code CLI you already have, plug in an API key, or drive the coding CLIs you already use."],
    ["Pick per task: Auto, Fast, Deep or a specific model. Or run one locally.", "Pick per task: Auto, Fast, Deep or a specific model. Local models come after the beta."],
    ["On your Mac, on your phone, in your inbox.</p>", "On your Mac first; phone and email later.</p>"],
    ["Four positions, per task. Change it any time, even mid-run.", "Four positions, per agent or chat. Change them any time."],
    ["Every edit is marked and can be undone in one step.", "Every edit is marked, and any earlier version can be restored."],
    ["d: 'Run a model on your own machine for anything sensitive. Nothing leaves the device.'",
      "d: 'After the beta: run a model on your own machine for anything sensitive. Nothing leaves the device.'"],
    ["d: 'Talk to your workspace from the CLI. Works offline against your local copy.'",
      "d: 'Talk to your workspace from the CLI (labs). Works offline against your local copy.'"]
  ]
};

function applyClaims(file, p) {
  for (const [find, replace] of CLAIMS[file] ?? []) {
    const label = `claim ${file}: ${find.slice(0, 40)}`;
    if (p.body.includes(find)) p.body = must(p.body, find, replace, label);
    else p.code = must(p.code, find, replace, label);
  }
  for (const old of BETA_LIST_OLD) {
    if ((p.body + p.code).includes(old)) throw new Error(`${file}: beta list still says "${old}"`);
  }
}

// ---- assemble ----------------------------------------------------------------------
const FONT_CSS = `@font-face{font-family:"Schibsted Grotesk";font-style:normal;font-display:swap;font-weight:400 900;src:url(/fonts/schibsted-grotesk-latin-ext-wght-normal.woff2) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Schibsted Grotesk";font-style:normal;font-display:swap;font-weight:400 900;src:url(/fonts/schibsted-grotesk-latin-wght-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
`;

function scriptFor(id, p, mobile) {
  // The artboard's class is evaluated in its own function scope, so two pages
  // (desktop + mobile home) can each define `class Component`.
  return `{template:${JSON.stringify(id)},mobile:${mobile},props:${JSON.stringify(p.props)},make:function(DCLogic){\n${p.code}\nreturn Component;}}`;
}

function htmlPage({ title, description, path, cssHref, assets, root, templates, pages, extraHead = "" }) {
  const url = SITE + path;
  return `<!doctype html>
<html lang="en" class="lg-intro" data-lg-intro-ms="${LOGO_INTRO_MS}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${url}">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#F1F1EE">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Based Notes">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Based Notes. Your data. Based. Notes and databases on your own Mac. Join the beta at basednotes.app">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/og.png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/schibsted-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${cssHref}">
${extraHead}</head>
<body>
<div id="dc-root">${root}</div>
${templates}
<script>window.__dcPages=[${pages}];</script>
<script src="${assets.site}" defer></script>
<script src="${assets.runtime}" defer></script>
</body>
</html>
`;
}

function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function prerender(chrome, file) {
  // Render once with timers off (componentDidMount is skipped), then keep #dc-root.
  const html = read(file).replace("<head>", "<head><script>window.__DC_PRERENDER=true</script>")
    .replace(/<script src="\/assets\/([^"]+)" defer><\/script>/g, (_, f) => `<script>${read(join(OUT, "assets", f))}</script>`);
  const tmp = join(tmpdir(), "based-prerender-" + process.pid + ".html");
  writeFileSync(tmp, html);
  const dom = execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--virtual-time-budget=3000", "--dump-dom", pathToFileURL(tmp).href], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
  const m = /<div id="dc-root">([\s\S]*?)<\/div>\s*<template/.exec(dom);
  if (!m || m[1].length < 200) throw new Error("prerender produced no markup for " + file);
  return m[1];
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "assets"), { recursive: true });
  cpSync(join(SRC, "static", "fonts"), join(OUT, "fonts"), { recursive: true });
  cpSync(join(SRC, "static", "mail"), join(OUT, "mail"), { recursive: true });
  // Search-Console-Bestätigung (Google): Datei muss dauerhaft bleiben.
  for (const f of ["mark.svg", "mark-dark.svg", "favicon.svg", "og.png", "googleabce878e470a9194.html"]) cpSync(join(SRC, "static", f), join(OUT, f));

  const runtime = read(join(SRC, "static", "dc-lite.js"));
  const site = read(join(SRC, "static", "site.js"));
  const assets = {
    runtime: `/assets/dc-lite.${hash(runtime)}.js`,
    site: `/assets/site.${hash(site)}.js`
  };
  writeFileSync(join(OUT, assets.runtime), runtime);
  writeFileSync(join(OUT, assets.site), site);

  // All artboards share one stylesheet; keep it once, with the fonts self-hosted.
  const cssSet = new Set();
  const parsed = {};
  for (const f of readdirSync(join(SRC, "pages")).filter((x) => x.endsWith(".dc.html"))) {
    const p = parse(f);
    p.body = patchNav(patchAssets(patchLinks(p.body)));
    p.code = patchAssets(p.code);
    if (PAGE_PATCHES[f]) PAGE_PATCHES[f](p);
    p.body = must(p.body, LOGO_SVG_OLD, LOGO_SVG_NEW, "logo intro " + f);
    applyClaims(f, p);
    cssSet.add(p.css);
    parsed[f] = p;
  }
  if (cssSet.size !== 1) console.warn(`note: ${cssSet.size} different stylesheets, using the home page's`);
  const legalCss = read(join(SRC, "legal.css"));
  const css = FONT_CSS + parsed["Main.dc.html"].css + "\n" + legalCss + LOGO_INTRO_CSS;
  const cssHref = `/assets/site.${hash(css)}.css`;
  writeFileSync(join(OUT, cssHref), css);

  const chrome = process.env.NO_PRERENDER ? null : findChrome();
  if (!chrome) console.warn("Chrome not found: pages are not prerendered (set CHROME_BIN)");

  for (const page of PAGES) {
    const main = parsed[page.file];
    let templates = `<template id="dc-tpl-main">${main.body}</template>`;
    let pages = scriptFor("dc-tpl-main", main, false);
    if (page.mobile) {
      const mob = parsed[page.mobile];
      templates += `\n<template id="dc-tpl-mobile">${mob.body}</template>`;
      pages += "," + scriptFor("dc-tpl-mobile", mob, true);
    }
    const out = join(OUT, page.out);
    mkdirSync(dirname(out), { recursive: true });
    const meta = META[page.path] ?? { title: main.title, description: main.description };
    const extraHead = page.path === "/" ? ldScript(APP_LD) + "\n" : "";
    const args = { title: meta.title, description: meta.description, path: page.path, cssHref, assets, templates, pages, extraHead };
    writeFileSync(out, htmlPage({ ...args, root: "" }));
    if (chrome) writeFileSync(out, htmlPage({ ...args, root: prerender(chrome, out) }));
    console.log("built", page.path);
  }

  // Legal pages are plain HTML in English (Austrian legal terms in brackets), no runtime.
  const shell = read(join(SRC, "legal", "_shell.html"));
  const footer = /<footer[\s\S]*?<\/footer>/.exec(parsed["Workspace.dc.html"].body)[0]
    .replace(/\{\{markSrc\}\}/g, "/mark.svg");
  const header = /<header[\s\S]*?<\/header>/.exec(parsed["Workspace.dc.html"].body)[0]
    .replace(' class="navlink on"', ' class="navlink"');
  for (const [name, path] of [["imprint", "/imprint"], ["privacy", "/privacy"]]) {
    const src = read(join(SRC, "legal", name + ".html"));
    const title = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(src)[1].replace(/<[^>]+>/g, "");
    const html = shell
      .replace("%LANG%", "en")
      .replace("%HEAD%", "")
      .replace(/%TITLE%/g, title + " · Based Notes")
      .replace("%CANONICAL%", SITE + path)
      .replace("%CSS%", cssHref)
      .replace("%HEADER%", header)
      .replace("%MAIN%", src)
      .replace("%FOOTER%", footer);
    mkdirSync(join(OUT, name), { recursive: true });
    writeFileSync(join(OUT, name, "index.html"), html);
    console.log("built", path);
  }

  for (const info of INFO) {
    const src = read(join(SRC, "info", info.name + ".html"));
    const head = [
      `<meta name="description" content="${info.description}">`,
      `<meta property="og:title" content="${info.title}">`,
      `<meta property="og:description" content="${info.description}">`,
      info.index ? "" : '<meta name="robots" content="noindex">',
      info.name === "faq" ? ldScript(faqLd(src)) : ""
    ].filter(Boolean).join("\n");
    const html = shell
      .replace("%LANG%", "en")
      .replace("%HEAD%", head)
      .replace(/%TITLE%/g, info.title)
      .replace("%CANONICAL%", SITE + info.path)
      .replace("%CSS%", cssHref)
      .replace("%HEADER%", header)
      .replace("%MAIN%", src)
      .replace("%FOOTER%", footer);
    mkdirSync(join(OUT, info.name), { recursive: true });
    writeFileSync(join(OUT, info.name, "index.html"), html);
    console.log("built", info.path);
  }

  const urls = PAGES.map((p) => p.path).concat(INFO.filter((i) => i.index).map((i) => i.path), ["/imprint", "/privacy"]);
  writeFileSync(join(OUT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join("\n")}
</urlset>
`);
  writeFileSync(join(OUT, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${SITE}/sitemap.xml\n`);
  writeFileSync(join(OUT, "404.html"), read(join(OUT, "index.html")));
}

main();
