// Updater-Ersatz, solange kein signiertes Update-Paket existiert (Secret TAURI_SIGNING_PRIVATE_KEY fehlt → keine
// latest.json im Release next-latest). Dann fragt die App die GitHub-Releases ab und sagt, ob es eine neuere DMG gibt.

export const RELEASES_API = "https://api.github.com/repos/elija-7580/Based/releases?per_page=30";
export const DOWNLOAD_PAGE = "https://github.com/elija-7580/Based/releases/tag/next-latest";

/** BSD-573: Die Beta-DMG gibt es seit BSD-553 nur mit persönlichem Einladungslink, nicht mehr auf GitHub. */
export const BETA_DOWNLOAD_PAGE = "https://basednotes.app/download";
export const BETA_CONTACT = "hello@basednotes.app";

/**
 * Release-Linie eines Kanals: Based Next (`next-<version>`) oder Based Beta (`beta-v<version>`), je mit festem Link.
 * `getIt`: wie man an die neue DMG kommt (Satzteil ohne Punkt) – bei der Beta der eigene Einladungslink.
 */
export interface ReleaseLine { tagPrefix: string; downloadPage: string; getIt: string }
export function releaseLine(channel: "dev" | "beta"): ReleaseLine {
  return channel === "beta"
    ? { tagPrefix: "beta-v", downloadPage: BETA_DOWNLOAD_PAGE,
      getIt: `open the personal download link from your invitation email again (${BETA_DOWNLOAD_PAGE}) or write to ${BETA_CONTACT}` }
    : { tagPrefix: "next-", downloadPage: DOWNLOAD_PAGE, getIt: `download the new DMG from ${DOWNLOAD_PAGE}` };
}

/** Text des Update-Dialogs, wenn es kein signiertes Update-Paket gibt („current“ hat einen eigenen Text). */
export function fallbackText(app: { name: string; version: string }, found: { kind: "newer"; version: string } | { kind: "unknown" }, line: ReleaseLine): string {
  return found.kind === "newer"
    ? `${app.name} ${found.version} is available (you have ${app.version}). Automatic install isn’t set up yet — ${line.getIt}.`
    : `You have ${app.name} ${app.version}. Automatic updates aren’t set up yet. To get the newest version, ${line.getIt}.`;
}

interface ReleaseLike { tag_name?: unknown; draft?: unknown }

/** Kleinere/gleich/größere Version („0.1.12“), fehlende Teile zählen als 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Neueste Version aus Releases `<tagPrefix><version>` (nicht `…-latest`, keine Entwürfe, keine andere Linie). */
export function newestNextVersion(releases: readonly ReleaseLike[], tagPrefix = "next-"): string | undefined {
  let best: string | undefined;
  for (const r of releases) {
    if (r.draft === true || typeof r.tag_name !== "string" || !r.tag_name.startsWith(tagPrefix)) continue;
    const v = r.tag_name.slice(tagPrefix.length);
    if (/^\d+(?:\.\d+)*$/.test(v) && (!best || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

/** Ist die Fehlermeldung des Tauri-Updaters „kein Update-Kanal“ (latest.json fehlt / nicht lesbar)? */
export function isMissingUpdateManifest(message: string): boolean {
  return /valid release JSON|404|Not Found/i.test(message);
}

export type FallbackResult = { kind: "newer"; version: string } | { kind: "current" } | { kind: "unknown" };

export async function checkReleasesFallback(current: string, fetcher: typeof fetch = fetch, tagPrefix = "next-"): Promise<FallbackResult> {
  try {
    const res = await fetcher(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return { kind: "unknown" };
    const newest = newestNextVersion((await res.json()) as ReleaseLike[], tagPrefix);
    if (!newest) return { kind: "unknown" };
    return compareVersions(newest, current) > 0 ? { kind: "newer", version: newest } : { kind: "current" };
  } catch {
    return { kind: "unknown" };
  }
}
