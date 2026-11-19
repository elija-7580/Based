// Spenden für Based (Einstellungen → Billing): dieselben Links wie basednotes.app und README – GitHub Sponsors.
// Elija 18.11.: Während der Beta ist alles gratis und wird über Spenden getragen. Bezahlte Pläne richtet er erst auf dem
// Based-Server ein, wenn Based aus der Beta ist und 1.000 Nutzer hat.

export const SPONSOR_URL = "https://github.com/sponsors/elija-7580";
export const GIVE_ONCE_URL = `${SPONSOR_URL}?frequency=one-time`;

/** Ab so vielen Nutzern (nach der Beta) kommen bezahlte Pläne auf den Server. */
export const PAID_PLANS_AT_USERS = 1000;

/**
 * Nur diese Adressen darf die App im Browser öffnen (Mac-App: Opener-Plugin, Rechte in
 * apps/desktop/src-tauri/capabilities/default.json – dort muss dieselbe Liste stehen).
 */
export const EXTERNAL_ALLOW = [SPONSOR_URL] as const;

export function isAllowedExternal(href: string): boolean {
  let url: URL;
  try { url = new URL(href); } catch { return false; }
  if (url.protocol !== "https:") return false;
  const base = url.origin + url.pathname;
  return EXTERNAL_ALLOW.some((allowed) => base === allowed);
}
