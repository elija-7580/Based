// BSD-209: Embed-Block – Link eines bekannten Anbieters in eine einbettbare Adresse übersetzen (wie Notion-Embeds).
// Nur diese Anbieter werden als iframe gezeigt (sie erlauben das Einbetten); alles andere bleibt eine Link-Karte.
// Reine Funktion ohne Netz; die Oberfläche lädt das iframe erst beim Anzeigen des Blocks.

export interface EmbedTarget {
  provider: string;
  src: string;
  /** Seitenverhältnis Breite/Höhe für die Fläche. */
  aspect: number;
}

const ID = /^[A-Za-z0-9_-]+$/;

export function embedTarget(raw: string): EmbedTarget | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  // YouTube (ohne Cookies)
  if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") {
    let id: string | undefined;
    if (host === "youtu.be") id = parts[0];
    else if (parts[0] === "watch") id = u.searchParams.get("v") ?? undefined;
    else if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") id = parts[1];
    if (!id || !ID.test(id)) return undefined;
    const t = u.searchParams.get("t") ?? u.searchParams.get("start");
    const start = t && /^\d+s?$/.test(t) ? `?start=${parseInt(t, 10)}` : "";
    return { provider: "YouTube", src: `https://www.youtube-nocookie.com/embed/${id}${start}`, aspect: 16 / 9 };
  }
  if (host === "vimeo.com" && parts[0] && /^\d+$/.test(parts[0])) return { provider: "Vimeo", src: `https://player.vimeo.com/video/${parts[0]}`, aspect: 16 / 9 };
  if (host === "player.vimeo.com" && parts[0] === "video" && parts[1] && /^\d+$/.test(parts[1])) return { provider: "Vimeo", src: `https://player.vimeo.com/video/${parts[1]}`, aspect: 16 / 9 };
  if (host === "loom.com" && (parts[0] === "share" || parts[0] === "embed") && parts[1] && ID.test(parts[1])) return { provider: "Loom", src: `https://www.loom.com/embed/${parts[1]}`, aspect: 16 / 9 };
  if (host === "figma.com" && ["file", "design", "proto", "board"].includes(parts[0] ?? "")) {
    return { provider: "Figma", src: `https://www.figma.com/embed?embed_host=based&url=${encodeURIComponent(u.toString())}`, aspect: 4 / 3 };
  }
  if (host === "codepen.io" && parts[1] === "pen" && parts[2] && ID.test(parts[2])) return { provider: "CodePen", src: `https://codepen.io/${parts[0]}/embed/${parts[2]}?default-tab=result`, aspect: 4 / 3 };
  if (host === "open.spotify.com" && ["track", "album", "playlist", "episode", "show"].includes(parts[0] ?? "") && parts[1] && ID.test(parts[1])) {
    return { provider: "Spotify", src: `https://open.spotify.com/embed/${parts[0]}/${parts[1]}`, aspect: parts[0] === "track" ? 4 : 16 / 9 };
  }
  if ((host === "google.com" || host === "maps.google.com") && parts[0] === "maps" && parts[1] === "embed") return { provider: "Google Maps", src: u.toString(), aspect: 4 / 3 };
  return undefined;
}
