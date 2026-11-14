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
const patchAssets = (s) => s.split(MARK_LIGHT).join("/mark.svg").split(MARK_DARK).join("/mark-dark.svg");

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

// ---- assemble ----------------------------------------------------------------------
const FONT_CSS = `@font-face{font-family:"Schibsted Grotesk";font-style:normal;font-display:swap;font-weight:400 900;src:url(/fonts/schibsted-grotesk-latin-ext-wght-normal.woff2) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Schibsted Grotesk";font-style:normal;font-display:swap;font-weight:400 900;src:url(/fonts/schibsted-grotesk-latin-wght-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
`;

function scriptFor(id, p, mobile) {
  // The artboard's class is evaluated in its own function scope, so two pages
  // (desktop + mobile home) can each define `class Component`.
  return `{template:${JSON.stringify(id)},mobile:${mobile},props:${JSON.stringify(p.props)},make:function(DCLogic){\n${p.code}\nreturn Component;}}`;
}

function htmlPage({ title, description, path, cssHref, assets, root, templates, pages }) {
  const url = SITE + path;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${url}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F1F1EE" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141414" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Based">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/schibsted-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${cssHref}">
</head>
<body>
<div id="dc-root">${root}</div>
<script>(function(){try{if(matchMedia("(prefers-color-scheme: dark)").matches&&!/[?&]theme=light/.test(location.search)){var b=document.querySelector("#dc-root>.bsd");if(b)b.setAttribute("data-theme","dark")}}catch(e){}})();</script>
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
  const m = /<div id="dc-root">([\s\S]*?)<\/div>\s*<script>\(function\(\)\{try\{if\(matchMedia/.exec(dom);
  if (!m || m[1].length < 200) throw new Error("prerender produced no markup for " + file);
  return m[1];
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "assets"), { recursive: true });
  cpSync(join(SRC, "static", "fonts"), join(OUT, "fonts"), { recursive: true });
  cpSync(join(SRC, "static", "mail"), join(OUT, "mail"), { recursive: true });
  for (const f of ["mark.svg", "mark-dark.svg", "favicon.svg"]) cpSync(join(SRC, "static", f), join(OUT, f));

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
    p.body = patchAssets(patchLinks(p.body));
    p.code = patchAssets(p.code);
    if (PAGE_PATCHES[f]) PAGE_PATCHES[f](p);
    cssSet.add(p.css);
    parsed[f] = p;
  }
  if (cssSet.size !== 1) console.warn(`note: ${cssSet.size} different stylesheets, using the home page's`);
  const legalCss = read(join(SRC, "legal.css"));
  const css = FONT_CSS + parsed["Main.dc.html"].css + "\n" + legalCss;
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
    const args = { title: main.title, description: main.description, path: page.path, cssHref, assets, templates, pages };
    writeFileSync(out, htmlPage({ ...args, root: "" }));
    if (chrome) writeFileSync(out, htmlPage({ ...args, root: prerender(chrome, out) }));
    console.log("built", page.path);
  }

  // Legal pages are plain HTML (German, with an English note), no runtime.
  const shell = read(join(SRC, "legal", "_shell.html"));
  const footer = /<footer[\s\S]*?<\/footer>/.exec(parsed["Workspace.dc.html"].body)[0]
    .replace(/\{\{markSrc\}\}/g, "/mark.svg");
  const header = /<header[\s\S]*?<\/header>/.exec(parsed["Workspace.dc.html"].body)[0]
    .replace(' class="navlink on"', ' class="navlink"');
  for (const [name, path] of [["imprint", "/imprint"], ["privacy", "/privacy"]]) {
    const src = read(join(SRC, "legal", name + ".html"));
    const title = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(src)[1].replace(/<[^>]+>/g, "");
    const html = shell
      .replace(/%TITLE%/g, title + " · Based")
      .replace("%CANONICAL%", SITE + path)
      .replace("%CSS%", cssHref)
      .replace("%HEADER%", header)
      .replace("%MAIN%", src)
      .replace("%FOOTER%", footer);
    mkdirSync(join(OUT, name), { recursive: true });
    writeFileSync(join(OUT, name, "index.html"), html);
    console.log("built", path);
  }

  const urls = PAGES.map((p) => p.path).concat(["/imprint", "/privacy"]);
  writeFileSync(join(OUT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join("\n")}
</urlset>
`);
  writeFileSync(join(OUT, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${SITE}/sitemap.xml\n`);
  writeFileSync(join(OUT, "404.html"), read(join(OUT, "index.html")));
}

main();
