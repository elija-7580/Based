import { describe, expect, it } from "vitest";
import { embedTarget } from "../src/editor/embed.js";

describe("Embed-Ziele (BSD-209)", () => {
  it("YouTube in allen Formen, ohne Cookies, mit Startzeit", () => {
    for (const u of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "https://m.youtube.com/shorts/dQw4w9WgXcQ"]) {
      expect(embedTarget(u)?.src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    }
    expect(embedTarget("https://youtu.be/dQw4w9WgXcQ?t=42")?.src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42");
    expect(embedTarget("https://www.youtube.com/watch?v=<script>")).toBeUndefined();
  });
  it("Vimeo, Loom, Figma, CodePen, Spotify, Google Maps", () => {
    expect(embedTarget("https://vimeo.com/76979871")?.src).toBe("https://player.vimeo.com/video/76979871");
    expect(embedTarget("https://www.loom.com/share/abc123")?.src).toBe("https://www.loom.com/embed/abc123");
    expect(embedTarget("https://www.figma.com/design/KEY/Name")?.src).toBe("https://www.figma.com/embed?embed_host=based&url=" + encodeURIComponent("https://www.figma.com/design/KEY/Name"));
    expect(embedTarget("https://codepen.io/someone/pen/xyzAB")?.src).toBe("https://codepen.io/someone/embed/xyzAB?default-tab=result");
    expect(embedTarget("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")).toMatchObject({ provider: "Spotify", src: "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC" });
    expect(embedTarget("https://www.google.com/maps/embed?pb=xyz")?.provider).toBe("Google Maps");
  });
  it("Unbekannt oder kein http(s): keine Einbettung", () => {
    expect(embedTarget("https://example.com/page")).toBeUndefined();
    expect(embedTarget("javascript:alert(1)")).toBeUndefined();
    expect(embedTarget("not a url")).toBeUndefined();
  });
});
