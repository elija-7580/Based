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
