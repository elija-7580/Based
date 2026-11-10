// BSD-210: Emoji-Katalog (aus Swift EmojiCatalog) und Suche wie Swift `search`.
import { describe, expect, it } from "vitest";
import { EMOJI_CATALOG, randomIcon, RANDOM_ICONS, searchEmoji } from "../src/index.js";

describe("Emoji-Katalog", () => {
  it("hat die Swift-Einträge, ohne Doppelte", () => {
    expect(EMOJI_CATALOG.length).toBe(434);
    expect(EMOJI_CATALOG[0]).toEqual(["😀", "grinning smile happy"]);
    expect(new Set(EMOJI_CATALOG.map((e) => e[0])).size).toBe(EMOJI_CATALOG.length);
  });

  it("Wortanfang zuerst, dann enthalten; leer = die ersten", () => {
    expect(searchEmoji("", 3).map((e) => e[0])).toEqual(["😀", "😃", "😄"]);
    const r = searchEmoji("smile");
    expect(r[0]![1].split(" ").some((w) => w.startsWith("smile"))).toBe(true);
    expect(searchEmoji("HEART").length).toBeGreaterThan(3);
    expect(searchEmoji("zzzz-nothing")).toEqual([]);
    const laugh = searchEmoji("laugh").map((e) => e[0]);
    expect(laugh).toContain("😆");
    expect(searchEmoji("a", 5)).toHaveLength(5);
  });

  it("Random kommt aus dem Pool", () => {
    expect(RANDOM_ICONS).toContain(randomIcon(() => 0.5));
    expect(randomIcon(() => 0)).toBe("📝");
  });
});
