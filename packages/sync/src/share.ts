// Teilen über den Sync-Server (docs/sharing.md): Zugangsliste einer Seite, veröffentlichen, Links anlegen und
// widerrufen, Rollen von Personen ändern. Nur HTTP; die Oberfläche (Share-Panel) bleibt dünn.

export type ShareRole = "view" | "comment" | "edit" | "full";
export type ShareLinkKind = "access" | "invite" | "publish";

export const SHARE_ROLE_LABEL: Record<ShareRole, string> = { full: "Full access", edit: "Can edit", comment: "Can comment", view: "Can view" };
/** Rollen, die ein Link ohne Konto haben darf (nie „Full access“). */
export const LINK_ROLES: readonly ShareRole[] = ["view", "comment", "edit"];

export interface ShareLinkInfo {
  id: string;
  kind: ShareLinkKind;
  role: ShareRole;
  pageID: string;
  label: string | null;
  active: boolean;
  inherited?: boolean;
  createdAt?: string;
  expiresAt?: string;
  /** Publish: `/p/<id>`; beim Anlegen eines Access-/Invite-Links: `/s/<geheimnis>` (nur in dieser Antwort). */
  path?: string;
}

export interface SharePerson {
  id: string;
  userID: string;
  name: string;
  pageID: string;
  role: ShareRole;
  inherited?: boolean;
}

export interface PageAccess {
  pageID: string;
  people: SharePerson[];
  links: ShareLinkInfo[];
}

export class ShareAPIError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ShareAPIError";
  }
}

/** Verständliche Meldung für eine Antwort des Servers. */
export function shareErrorMessage(e: unknown): string {
  if (e instanceof ShareAPIError) {
    if (e.status === 401) return "The server didn't accept the token. Check Settings → Sync & server.";
    if (e.status === 403) return e.message && e.message !== "forbidden" ? e.message : "You need full access to share this page.";
    if (e.status === 404) return "This page isn't on the server yet. Wait for it to sync, then try again.";
    return e.message || `The server answered ${e.status}.`;
  }
  if (e instanceof TypeError) return "Can't reach the server. Check your connection and Settings → Sync & server.";
  return e instanceof Error ? e.message : String(e);
}

/** Vollständige URL eines Server-Pfads (`/p/…`, `/s/…`). */
export function shareURL(server: string, path: string): string {
  return server.replace(/\/+$/, "") + path;
}

export class ShareAPI {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(readonly opts: { url: string; token: string; fetch?: typeof fetch }) {
    this.base = opts.url.replace(/\/+$/, "");
    this.fetcher = opts.fetch ?? ((...a) => fetch(...a));
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: { Authorization: `Bearer ${this.opts.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetcher(this.base + path, init);
    const data = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    if (!res.ok) throw new ShareAPIError(res.status, data?.error ?? "");
    return data as T;
  }

  access(pageID: string): Promise<PageAccess> {
    return this.request("GET", `/share/v1/pages/${encodeURIComponent(pageID)}`);
  }

  createLink(pageID: string, kind: ShareLinkKind, role: ShareRole, opts: { label?: string; expiresInDays?: number; uses?: number } = {}): Promise<ShareLinkInfo & { secret?: string }> {
    return this.request("POST", "/share/v1/links", { pageID, kind, role, ...opts });
  }

  /** Veröffentlichen; eine schon veröffentlichte Seite behält ihren Link. */
  publish(pageID: string): Promise<ShareLinkInfo> {
    return this.createLink(pageID, "publish", "view");
  }

  async revoke(linkID: string): Promise<void> {
    await this.request("POST", `/share/v1/links/${encodeURIComponent(linkID)}/revoke`, {});
  }

  async setRole(userID: string, pageID: string, role: ShareRole | null): Promise<void> {
    await this.request("POST", "/share/v1/grants", { userID, pageID, role });
  }
}

/** Der aktive, direkt auf der Seite liegende Publish-Link (vererbte zählen nicht als „diese Seite veröffentlicht“). */
export function publishedLink(access: PageAccess | undefined): ShareLinkInfo | undefined {
  return access?.links.find((l) => l.kind === "publish" && l.active && !l.inherited);
}
