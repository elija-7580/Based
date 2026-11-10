// Updater-Ersatz, solange kein signiertes Update-Paket existiert (Secret TAURI_SIGNING_PRIVATE_KEY fehlt → keine
// latest.json im Release next-latest). Dann fragt die App die GitHub-Releases ab und sagt, ob es eine neuere DMG gibt.

export const RELEASES_API = "https://api.github.com/repos/elija-7580/Based/releases?per_page=30";
export const DOWNLOAD_PAGE = "https://github.com/elija-7580/Based/releases/tag/next-latest";

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

/** Neueste Version aus Releases `next-<version>` (nicht `next-latest`, keine Entwürfe). */
export function newestNextVersion(releases: readonly ReleaseLike[]): string | undefined {
  let best: string | undefined;
  for (const r of releases) {
    if (r.draft === true || typeof r.tag_name !== "string") continue;
    const m = /^next-(\d+(?:\.\d+)*)$/.exec(r.tag_name);
    if (m && (!best || compareVersions(m[1]!, best) > 0)) best = m[1]!;
  }
  return best;
}

/** Ist die Fehlermeldung des Tauri-Updaters „kein Update-Kanal“ (latest.json fehlt / nicht lesbar)? */
export function isMissingUpdateManifest(message: string): boolean {
  return /valid release JSON|404|Not Found/i.test(message);
}

export type FallbackResult = { kind: "newer"; version: string } | { kind: "current" } | { kind: "unknown" };

export async function checkReleasesFallback(current: string, fetcher: typeof fetch = fetch): Promise<FallbackResult> {
  try {
    const res = await fetcher(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return { kind: "unknown" };
    const newest = newestNextVersion((await res.json()) as ReleaseLike[]);
    if (!newest) return { kind: "unknown" };
    return compareVersions(newest, current) > 0 ? { kind: "newer", version: newest } : { kind: "current" };
  } catch {
    return { kind: "unknown" };
  }
}
