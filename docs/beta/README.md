# Based Beta – guide for testers

Thanks for testing Based. Based is a workspace for pages and databases that keeps your data on your Mac.
This beta is an early version: please keep a copy of anything you can't afford to lose, and tell us what breaks.

## Install

1. Download **Based-Beta.dmg** from the link in your invitation.
2. Open it and drag **Based Beta** into Applications.
3. Open Based Beta from Applications.
   - Until the app is signed by Apple, macOS asks before the first start: right-click the app → **Open** → **Open**.

Based Beta needs macOS 13 or later and runs on Apple Silicon and Intel Macs. It installs next to other Based versions
and keeps its own data.

## First start

You don't need an account. On the welcome screen you can:

- **Import from Notion** – connect Notion directly, or pick a Notion export (.zip). Big workspaces take a few minutes;
  you can keep working while it runs.
- **Start empty** – Based adds a few short guide pages under “Welcome to Based”.

Other imports (Markdown, HTML, CSV, Obsidian, Evernote, Word, OPML) are in **Settings → Import & export**.

## What to try

- Pages and subpages, the block editor, `/` for blocks, `@` and `[[` for links to other pages
- Databases: table, board, list, gallery, calendar and timeline views, filters, sorts, groups, formulas
- Quick Find with **⌘K**, tabs (**⌘T**, **⌘W**), the sidebar, favorites, Trash
- Export a page or your whole workspace (Markdown, HTML, PDF)

## What is not in this beta

- AI and agents. They exist in Based, but the beta ships without them.
- Meeting notes, the graph view and real-time editing on several devices. They come back when they are stable.
- iPhone, iPad, Windows and the web app. The beta is Mac only.
- Accounts, sharing and the Based cloud.

## Your data

- Everything stays on your Mac. Based does not send your pages anywhere.
- Automatic backups: turn on **Settings → Sync & server → Local server** and let this app sync with it. Based then
  keeps backups in `~/Documents/Based Beta Backups` (hourly, daily, monthly) with **Back up now** and **Restore…**.
- Either way, export anything important now and then (**•••** page menu → Export, or Settings → Import & export).
- Based Beta and Based Next can be installed side by side. Each keeps its own workspace, local server (Beta: port
  47822), backups folder and iCloud folder (`Based Beta`); the command line tool of the Beta is `based-beta`.
- Updates keep your data. If an update ever fails to open your workspace, don't delete anything – write to us.

## Updates

Based Beta checks for updates on its own and asks before installing. You can also use
**Based Beta → Check for Updates…**. You can turn automatic checks off in **Settings → Updates**.

## Feedback and problems

- **Report a problem:** **Help → Report a Problem…** or **⇧⌘B**. Describe what you did and what happened, then
  **Save report** and attach the file to an email. Reports contain no page text unless you tick “Include real text”.
- **Crash reports:** if Based closes unexpectedly, it offers a report on the next start. It contains no page content.
- **Email:** hello@basednotes.app – bugs, ideas, anything that felt slow or confusing.

The most useful feedback: what you expected, what happened instead, and whether it happens again.
