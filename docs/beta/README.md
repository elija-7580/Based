# Based Notes Beta – guide for testers

Thanks for testing Based. Based is a workspace for pages and databases that keeps your data on your Mac.
This beta is an early version: please keep a copy of anything you can't afford to lose, and tell us what breaks.

## Install

1. Download the disk image (**Based-Notes-Beta.dmg**) from the personal link in your invitation. The link works for
   30 days and up to 5 downloads. Please don't share it; if it stops working, write to hello@basednotes.app.
2. Open it and drag **Based Notes Beta** into Applications.
3. Open Based Notes Beta from Applications.
   - Until the app is signed by Apple, macOS asks before the first start: right-click the app → **Open** → **Open**.

Based Notes Beta needs macOS 13 or later and runs on Apple Silicon and Intel Macs. It installs next to other Based versions
and keeps its own data.

Until 18 November 2026 the app was called **Based Beta**. If you installed it then, it updates itself and keeps your
workspace, backups and settings; in Finder it may keep the old name `Based Beta.app`. Folders and the command line
tool keep their names (`Based Beta Backups`, iCloud folder `Based Beta`, `based-beta`).

## First start

You don't need an account. On the welcome screen you can:

- **Import from Notion** – connect Notion directly, or pick a Notion export (.zip). Big workspaces take a few minutes;
  you can keep working while it runs.
- **Start empty** – Based adds a few short guide pages under “Welcome to Based”. **Home** opens that page.
- **Start from a template** – Tasks, Notes, Journal or Wiki, with a few example entries. **⌘N** offers the same
  templates later.

The welcome screen also offers **Turn on meeting notes**. It starts Based's local server on your Mac and downloads a
speech model once (488 MB, from huggingface.co). You can do this later in **Settings → Meeting notes**,
where you can also pick a smaller or a more accurate model.

Other imports (Markdown, HTML, CSV, Obsidian, Evernote, Word, OPML) are in **Settings → Import & export**.

## What to try

- Pages and subpages, the block editor, `/` for blocks, `@` and `[[` for links to other pages
- Databases: table, board, list, gallery, calendar and timeline views, filters, sorts, groups, formulas
- Quick Find with **⌘K**, tabs (**⌘T**, **⌘W**), the sidebar, favorites, Trash
- Video and audio blocks (type `/video` or `/audio`)
- Meeting notes: type `/meet`, press **Start**, take notes while it records. After **Stop** you get a transcript; click
  a line or a note to hear that moment. macOS asks once for the microphone. Recording and transcript stay on your Mac.
- Export a page or your whole workspace (Markdown, HTML, PDF), and import it again

## What is not in this beta

- AI and agents. They exist in Based, but the beta ships without them.
- AI summaries of meetings, and telling speakers apart in the transcript.
- The graph view and real-time editing on several devices. They come back when they are stable.
- iPhone, iPad, Windows and the web app. The beta is Mac only.
- Accounts, sharing and the Based cloud.

## Your data

- Everything stays on your Mac. Based does not send your pages anywhere.
- Automatic backups: turn on **Settings → Sync & server → Local server** and let this app sync with it. Based then
  keeps backups in `~/Documents/Based Beta Backups` (hourly, daily, monthly) with **Back up now** and **Restore…**.
  **Change folder…** puts them somewhere else, for example on an external drive. If that drive isn't connected,
  Based says so there and makes no backups until it's back – it never quietly switches to another folder.
- Either way, export anything important now and then (**•••** page menu → Export, or Settings → Import & export).
  For a complete copy choose **Export workspace… → Based archive**: it keeps everything and imports back as it
  was. HTML is for reading – imported again, databases come back as tables.
- Based Notes Beta and Based Next can be installed side by side. Each keeps its own workspace, local server (Beta: port
  47822), backups folder and iCloud folder (`Based Beta`); the command line tool of the Beta is `based-beta`.
- Before it installs an update, Based Notes Beta saves a copy of your whole workspace (a Based archive with all files;
  above 300 MB of files only pages and databases, as `.based.jsonl` – the files stay in the app) in
  `~/Library/Application Support/com.friedrich-ulrich.based.beta/pre-update` and keeps the last three. If that copy
  can't be saved, the update isn't installed. To go back, import the archive in **Settings → Import & export**.
- Updates keep your data. If an update ever fails to open your workspace, don't delete anything – write to us.

## Updates

Based Notes Beta checks for updates on its own and asks before installing. You can also use
**Based Notes Beta → Check for Updates…**. You can turn automatic checks off in **Settings → Updates**.

## Feedback and problems

- **Report a problem:** **Help → Report a Problem…** or **⇧⌘B**. Describe what you did and what happened, then
  **Save report** and attach the file to an email. Reports contain no page text unless you tick “Include real text”.
- **Crash reports:** if Based closes unexpectedly, it offers a report on the next start. It contains no page content.
- **Email:** hello@basednotes.app – bugs, ideas, anything that felt slow or confusing.

The most useful feedback: what you expected, what happened instead, and whether it happens again.

## Support Based

Based has no investors and sells no ads. During the beta every feature is free for everyone, and donations pay for
the servers. If you like what you're testing, [sponsor Based on GitHub](https://github.com/sponsors/elija-7580): $3 a month is enough, or give once.
It's a donation, so you get nothing extra for it. The goal is 1,000 monthly sponsors; at 1,000, Based Cloud goes live
for everyone.
