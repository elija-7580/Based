// BSD-266: Vorschau von Textdateien auf dem Board (Notizen, Code, Logs, Agent- und Chat-Mitschriften). Gelesen wird
// nur der Anfang der Datei (PREVIEW_BYTES) und nur für Karten, die zu sehen sind; wenige bleiben im Speicher.
import { PREVIEW_BYTES, textPreview, type TextPreview } from "@based/core";

type Entry = { at: number; preview?: TextPreview; failed?: boolean };

export class BoardTextCache {
  private readonly entries = new Map<string, Entry>();
  private clock = 0;
  private dead = false;
  constructor(private readonly resolve: (ref: string) => Promise<string> | undefined, private readonly onLoad: () => void, private readonly max = 64) {}

  get = (ref: string, name: string): TextPreview | undefined => {
    const e = this.entries.get(ref);
    if (e) { e.at = ++this.clock; return e.preview; }
    this.entries.set(ref, { at: ++this.clock });
    void this.load(ref, name);
    return undefined;
  };

  private async load(ref: string, name: string) {
    try {
      const url = await this.resolve(ref);
      if (!url) throw new Error("no file store");
      const blob = await (await fetch(url)).blob();
      const text = await blob.slice(0, PREVIEW_BYTES).text();
      if (this.dead) return;
      this.entries.set(ref, { at: ++this.clock, preview: textPreview(text, name, blob.size > PREVIEW_BYTES) });
      if (this.entries.size > this.max) {
        const oldest = [...this.entries].sort((a, b) => a[1].at - b[1].at).slice(0, this.entries.size - this.max);
        for (const [k] of oldest) this.entries.delete(k);
      }
      this.onLoad();
    } catch {
      if (!this.dead) this.entries.set(ref, { at: ++this.clock, failed: true });
    }
  }
  destroy() { this.dead = true; this.entries.clear(); }
}
