// BSD-447: Zeit-Anzeige und Tasten des BasedMediaPlayer.
import { describe, expect, it } from "vitest";
import { formatMediaTime, mediaKeyAction } from "../src/astryx/media.js";

describe("BasedMediaPlayer", () => {
  it("formatiert Zeiten wie Notion", () => {
    expect(formatMediaTime(0)).toBe("0:00");
    expect(formatMediaTime(65.9)).toBe("1:05");
    expect(formatMediaTime(720)).toBe("12:00");
    expect(formatMediaTime(3723)).toBe("1:02:03");
    expect(formatMediaTime(Number.NaN)).toBe("–:––");
    expect(formatMediaTime(Number.POSITIVE_INFINITY)).toBe("–:––");
  });
  it("Tasten: Leertaste/K, Pfeile, M; F nur bei Video", () => {
    expect(mediaKeyAction(" ", "audio")).toBe("toggle");
    expect(mediaKeyAction("k", "video")).toBe("toggle");
    expect(mediaKeyAction("ArrowLeft", "audio")).toBe("back");
    expect(mediaKeyAction("ArrowRight", "audio")).toBe("forward");
    expect(mediaKeyAction("m", "audio")).toBe("mute");
    expect(mediaKeyAction("f", "video")).toBe("fullscreen");
    expect(mediaKeyAction("f", "audio")).toBeUndefined();
    expect(mediaKeyAction("x", "video")).toBeUndefined();
  });
});
