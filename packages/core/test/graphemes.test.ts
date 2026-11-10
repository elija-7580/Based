import { afterEach, describe, expect, it, vi } from "vitest";
import { firstGrapheme, GRAPHEME_CHUNK, graphemeCount, graphemes } from "../src/graphemes.js";

const icu = (s: string) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment);

const SAMPLES = [
  "",
  "plain ascii text",
  "Grüße, Straße – café",
  "é combining",
  "line\r\nbreak\rcr\nlf",
  "👍🏽 thumbs, 👨‍👩‍👧 family, 🇦🇹 flag",
  "한국어 텍스트",
  "क्ष devanagari",
  "tab\tand\u000bcontrols\u0000",
];

describe("graphemes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("matches Intl.Segmenter on mixed text", () => {
    for (const s of SAMPLES) expect(graphemes(s)).toEqual(icu(s));
  });

  it("splits long text in chunks at line breaks without changing the result (incl. CR LF at the seam)", () => {
    const line = "Zeile mit é́ und 👨‍👩‍👧 sowie Text\r\n";
    const big = line.repeat(Math.ceil((GRAPHEME_CHUNK * 3) / line.length));
    expect(big.length).toBeGreaterThan(GRAPHEME_CHUNK * 2);
    expect(graphemes(big)).toEqual(icu(big));
  });

  it("long text without any line break still works", () => {
    const big = "é👍🏽".repeat(GRAPHEME_CHUNK);
    expect(graphemes(big).length).toBe(GRAPHEME_CHUNK * 2);
  });

  it("does not call ICU for simple text (fast path)", () => {
    const spy = vi.spyOn(Intl.Segmenter.prototype, "segment");
    expect(graphemes("x".repeat(1_000_000)).length).toBe(1_000_000);
    expect(graphemeCount("Grüße")).toBe(5);
    expect(spy).not.toHaveBeenCalled();
  });

  it("falls back instead of throwing when ICU fails (WKWebView: „failed to initialize SegmentIterator“)", () => {
    const expected = SAMPLES.map(icu);
    vi.spyOn(Intl.Segmenter.prototype, "segment").mockImplementation(() => {
      throw new TypeError("failed to initialize SegmentIterator");
    });
    SAMPLES.forEach((s, i) => {
      const got = graphemes(s);
      expect(got.join("")).toBe(s); // kein Text geht verloren
      // Indische Konjunkte (UAX #29 GB9c) nähert der Notfallpfad nur an; alles andere stimmt genau.
      if (!/\p{Script=Devanagari}/u.test(s)) expect(got).toEqual(expected[i]);
    });
    expect(graphemes("x".repeat(GRAPHEME_CHUNK * 2) + "é").length).toBe(GRAPHEME_CHUNK * 2 + 1);
  });

  it("firstGrapheme reads only the start", () => {
    expect(firstGrapheme("👨‍👩‍👧 Family")).toBe("👨‍👩‍👧");
    expect(firstGrapheme("")).toBeUndefined();
  });
});
