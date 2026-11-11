# Sharing

Pages are shared through your own `based-server`, so a link opens in any browser on any system — and in the
Based app where it's installed (Universal Links). Workspaces that sync only through iCloud can't share links.

In the app: **Share ⌄ → Share on the web…** on any page.

## Roles

Like Notion. A role on a page covers everything inside it (sub-pages, databases and their rows); if someone has
roles on several levels, the highest wins.

| Role | Can |
|---|---|
| **Full access** | edit, share further (never above their own role), revoke, change others' roles |
| **Can edit** | edit content, add and move blocks *within* the shared area |
| **Can comment** | read (Based has no comments yet, so this is read-only for now) |
| **Can view** | read |

## Ways to share

| Kind | URL | Who |
|---|---|---|
| **Access link** | `/s/<secret>` | anyone holding the URL, no account; view, comment or edit (never full access) |
| **Invite** | `/s/<secret>` → join page | one person (or *n* uses) enters a name and gets their own device token; any role |
| **Publish** | `/p/<id>` | public, read-only, server-rendered HTML incl. sub-pages; no JavaScript, no app needed |

Links can expire and be revoked at any time; the panel lists everyone with access, including access inherited
from pages above.

## How it's enforced

- `ShareService` (`BasedBrain/Sharing`) keeps users, grants and links in the server's local `meta` table — not in
  workspace records, so they never sync to devices. Secrets (link secrets `bdl_…`, device tokens `bdu_…`) are
  stored only as SHA-256 hashes; the owner keeps using `BASED_TOKEN`.
- Permission check = ReBAC tuples (subject, role, page) evaluated up the page tree (same shape as
  Zanzibar / OpenFGA, in-process).
- **Sync is filtered** per principal: `GET /share/v1/snapshot` and `/sync/v2/pull` return only readable records. A
  page moved out of the shared area arrives as a deletion — together with all its content.
- **Pushes are checked** record by record: edit role where the record is *and* where it goes; workspace records,
  view/comment roles and moves out of the shared area are rejected and rolled back with the server's copy.
- Shared principals can't reach MCP, agents, logs or any other owner endpoint.

## Endpoints

```
GET  /s/<secret>                      link landing: web client (access link) or join page (invite)
GET  /p/<id>[/<pageID>]               published page
POST /share/v1/invites/accept         {secret, name} → {token, pageID}
GET  /share/v1/me                     who am I, which pages, which role
GET  /share/v1/snapshot               everything I can see + change-log position
GET  /share/v1/resolve?path=/s/…      page behind a share URL (owner; the app opens it natively)
GET  /share/v1/pages/<pageID>         access list (full access)
POST /share/v1/links                  {pageID, kind: access|invite|publish, role, label?, expiresInDays?, uses?}
POST /share/v1/links/<id>/revoke
POST /share/v1/grants                 {userID, pageID, role | null}
GET  /.well-known/apple-app-site-association
```

## Server configuration

| Variable | Purpose |
|---|---|
| `BASED_PUBLIC_URL` | public base URL the links are built from (docker-compose sets it from `BASED_DOMAIN`) |
| `BASED_APPLE_APP_ID` | `<TeamID>.<bundle id>` — serves the association file so `/s/*` and `/p/*` open in the app |

For Universal Links the app additionally needs the *Associated Domains* capability with `applinks:<your domain>`
(Xcode → Signing & Capabilities). It isn't in the default entitlements because the domain is yours.

## TypeScript server (`apps/server`)

The TS server implements the same model (`src/share.ts`, `src/share-routes.ts`, `src/publish.ts`); the Swift
server stays the reference until it is switched off.

- **Stored the same way:** users, grants and links in `meta` under `share.v1`, same JSON as Swift (dates as seconds
  since 2001), so a database file keeps its shares when it moves between the two servers. Secrets only as SHA-256.
- **Router:** routes declare `access: "shared"` (owner token, device token or access-link secret) or `"owner"`. A
  valid guest token on an owner route gets **403** (MCP, Sync v1, `/sandbox/*` …); no token or a wrong one gets 401.
- **Sync:** `/sync/v2/info|pull|push|wait` and `/share/v1/snapshot` accept guests. Pull turns changed records the
  guest can't read into unstamped deletions; a page that leaves the shared area takes its content (sub-pages,
  database, rows, views) with it; a page that moves *into* the shared area (or a new grant for a connected user)
  brings its unchanged content once (table `share_moves`, BSD-284). Deletions reach a guest only if the record last
  lay in the guest's area (table `share_deleted`; deletions from before it existed still pass, BSD-285). Push
  applies only records with edit access where they are *and* where they go; the rest come back in `newer` (only if
  the guest may read them) and are listed in `rejected` (`[{kind, id}]`), so the device takes the server copy even
  though its own stamp is newer. Assets: guests read only files referenced from
  readable records and upload only with an edit role somewhere.
- **Publish:** `/p/<id>[/<page>]` is rendered with the core HTML exporter (`exportHTMLPage`, `offline: true`) and the
  token stylesheet from `@based/design-tokens/export-css` — no scripts, no fonts or scripts from other servers.
  CSP `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-src 'self'; …`.
  Images come from `/p/<id>/asset/<hash>` (only files of the published area). HTML blocks load from
  `/p/<id>/<page>/html/<block>` with `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; …`
  (opaque origin, no network). Embeds of other sites don't load on published pages (frame-src `'self'`).
  Publishing a page twice returns the same link; links to pages outside the area become plain text.
- **Access links** (`/s/<secret>`) open a read-only rendering in the browser; to edit, the secret is used as the
  token in Based (Settings → Sync & server). **Invites** show a form (no JavaScript); joining shows the device token
  once, with the server URL to connect with.
- **Guest mode (BSD-235, part 1):** with `--web-url` / `BASED_WEB_URL` (address of the web client), the read-only
  page of an access link shows "Open in Based" linking to `<web-url>/#/share/<share URL>` – the link travels in the
  fragment, which browsers never send to a server. `GET /share/v1/resolve?path=/s/…|/p/…` (owner) returns
  `{kind, linkID, pageID, rootPageID, role, title}`. Pages whose parent the device doesn't know (a guest only syncs the
  shared area) appear in the sidebar under "Shared with you". The web client's guest boot is part 2.
- Link URLs are built by the client from the server URL it is connected to (`path` in the API answer); the TS
  server needs no `BASED_PUBLIC_URL` for that. Universal Links (`apple-app-site-association`) are not served yet.

In the web client: **Share** in the page header (`apps/web/src/components/Share.tsx`, HTTP in `@based/sync`
`ShareAPI`): Publish / Copy link / Unpublish, access links and invites with a role, revoke, roles of people.
Without a connected sync server the panel says so and offers the way to Settings.

## Embeds on published pages (BSD-236)

By default, embed blocks on `/p/<id>` render as link cards and the CSP allows no foreign frames (`frame-src 'self'`).
Opt-in per page in the share panel ("Allow embeds on this published page", `POST /share/v1/links/<id>/embeds
{allow}`; publish links only, full access needed): embeds render as `<iframe sandbox="allow-scripts
allow-same-origin allow-popups allow-presentation">`, and `frame-src` lists exactly the https origins of this page's
embeds. Stored as `allowEmbeds` on the link (missing in older data = off).
