// BSD-235 Teil 2: Gast-Modus im Web-Client. Ein Bearbeiten-/Ansehen-Link des Servers öffnet die App über
// `<web>/#/share/<Share-URL>` (das Geheimnis steht nur im Fragment, geht also an keinen Server). Die App legt die
// Gast-Konfiguration verschlüsselt ab (SecretStore, wie das Sync-Token), leitet auf `?guest=<id>` um und startet dann
// einen eigenen, vom Besitzer getrennten Store: eigener Lock-/Kanal-Name, nur im Speicher (der OPFS-Pool gehört dem
// Store-Tab des Besitzers), Sync mit dem Link-Geheimnis als Token. Der Server filtert, was der Gast sieht und ändern darf.

export interface GuestConfig {
  /** Server-Basis, z. B. https://based.example.com (ohne /s/…). */
  server: string;
  /** Link-Geheimnis (bdl_…), dient als Bearer-Token. */
  secret: string;
  /** Unterseite aus dem Link (/s/<geheimnis>/<seite>). */
  page?: string;
}

/** `#/share/<Share-URL>` lesen (Share-URL: <Server>/s/<Geheimnis>[/<Seite>]). */
export function parseShareFragment(hash: string): GuestConfig | undefined {
  const m = /^#\/share\/(.+)$/.exec(hash);
  if (!m) return undefined;
  let url: URL;
  try {
    url = new URL(decodeURIComponent(m[1]!));
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const p = /^(.*)\/s\/([^/]+)(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (!p || !p[2]) return undefined;
  const cfg: GuestConfig = { server: url.origin + p[1], secret: decodeURIComponent(p[2]) };
  if (p[3]) cfg.page = decodeURIComponent(p[3]);
  return cfg;
}

/** Kennung eines Gast-Zugangs: die ersten 16 Hex-Zeichen von SHA-256(Server, Geheimnis) – verrät das Geheimnis nicht. */
export async function guestID(cfg: Pick<GuestConfig, "server" | "secret">, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
  const d = await subtle.digest("SHA-256", new TextEncoder().encode(`${cfg.server}\n${cfg.secret}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** `?guest=<id>` lesen (nur gültige Kennungen). */
export function guestIDFromSearch(search: string): string | undefined {
  const id = new URLSearchParams(search).get("guest");
  return id && /^[0-9a-f]{16}$/.test(id) ? id : undefined;
}

/** Was der Gast-Start braucht: verschlüsselter Speicher für benannte Geheimnisse. */
export interface GuestVault {
  getSecret(name: string): Promise<string | undefined>;
  setSecret(name: string, value: string | undefined): Promise<void>;
}

const secretName = (id: string) => `guest:${id}`;

export async function rememberGuest(vault: GuestVault, cfg: GuestConfig): Promise<string> {
  const id = await guestID(cfg);
  await vault.setSecret(secretName(id), JSON.stringify(cfg));
  return id;
}

export async function loadGuest(vault: GuestVault, id: string): Promise<GuestConfig | undefined> {
  const raw = await vault.getSecret(secretName(id));
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<GuestConfig>;
    if (typeof v.server !== "string" || typeof v.secret !== "string") return undefined;
    return { server: v.server, secret: v.secret, ...(typeof v.page === "string" ? { page: v.page } : {}) };
  } catch {
    return undefined;
  }
}

/** Antwort von GET /share/v1/me. */
export interface GuestMe { kind: string; name: string; pages: { id: string; title: string; role: string }[] }

/** Wer bin ich auf dem Server? `undefined` bei 401/403 (Link widerrufen oder abgelaufen) oder Netzfehler. */
export async function fetchGuestMe(cfg: GuestConfig, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<GuestMe | "revoked" | undefined> {
  try {
    const r = await fetcher(`${cfg.server.replace(/\/+$/, "")}/share/v1/me`, { headers: { Authorization: `Bearer ${cfg.secret}` } });
    if (r.status === 401 || r.status === 403 || r.status === 404) return "revoked";
    if (!r.ok) return undefined;
    return (await r.json()) as GuestMe;
  } catch {
    return undefined;
  }
}

/** Startseite des Gastes: die Seite aus dem Link, sonst die erste geteilte. */
export function guestStartPage(cfg: GuestConfig, me: GuestMe | undefined): string | undefined {
  return cfg.page ?? me?.pages[0]?.id;
}

/**
 * BSD-282: Endgültig löschen dürfen nur der Besitzer und Gäste mit „Full access“; „Can edit“ legt in den Papierkorb.
 * Der Server lehnt es ohnehin ab, die Oberfläche bietet es dann gar nicht erst an.
 */
let deleteForeverAllowed = true;

/** Nur im Gast-Modus aufrufen. Unbekannte Rolle (Server nicht erreichbar) zählt als „Can edit“. */
export function setGuestAccess(me: Pick<GuestMe, "pages"> | undefined) {
  deleteForeverAllowed = me !== undefined && me.pages.some((p) => p.role === "full");
}

export const mayDeleteForever = (): boolean => deleteForeverAllowed;

/**
 * BSD-235 Teil 3: Widerruf wirkt, während der Gast die Seite offen hat. Prüft `/share/v1/me` alle `intervalMs`, beim
 * Zurückkommen ins Fenster und wenn `poke()` gerufen wird (z. B. bei einem Sync-Fehler); ist der Link widerrufen oder
 * entfernt, wird `onRevoked` genau einmal gerufen. Gibt `{ stop, poke }` zurück. Netzfehler zählen nicht als Widerruf.
 */
export function watchGuestRevocation(cfg: GuestConfig, onRevoked: () => void, o: { intervalMs?: number; fetcher?: typeof fetch; events?: Pick<EventTarget, "addEventListener" | "removeEventListener"> } = {}): { stop(): void; poke(): void } {
  let stopped = false;
  let busy = false;
  const check = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      if ((await fetchGuestMe(cfg, o.fetcher)) === "revoked" && !stopped) { stop(); onRevoked(); }
    } finally { busy = false; }
  };
  const timer = setInterval(() => void check(), o.intervalMs ?? 15_000);
  const events = o.events ?? globalThis;
  const onEvent = () => void check();
  for (const e of ["focus", "online", "visibilitychange"]) events.addEventListener(e, onEvent);
  function stop() {
    stopped = true;
    clearInterval(timer);
    for (const e of ["focus", "online", "visibilitychange"]) events.removeEventListener(e, onEvent);
  }
  return { stop, poke: () => void check() };
}
