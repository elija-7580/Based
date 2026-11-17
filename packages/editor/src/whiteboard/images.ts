// BSD-266 (Whiteboard 4): Bilder der Board-Fläche. Geladen wird erst, wonach die Fläche fragt (also was zu sehen ist);
// entpackt wird verkleinert (ein 48-Megapixel-Foto braucht sonst ~190 MB im Speicher), und es bleiben nur die zuletzt
// gebrauchten im Speicher. Die Bytes selbst liegen im Dateispeicher der App, nie im Board.

/** Größte Kante eines entpackten Bildes (px). */
export const IMAGE_DECODE_MAX = 2048;
/** So viele entpackte Bilder bleiben im Speicher. */
export const IMAGE_CACHE_MAX = 48;

type Entry = { state: "loading" | "failed"; at: number } | { state: "ready"; at: number; image: ImageBitmap };

export class BoardImageCache {
  private readonly entries = new Map<string, Entry>();
  private clock = 0;
  private dead = false;

  constructor(
    private readonly resolve: (ref: string) => Promise<string> | undefined,
    private readonly onLoad: () => void,
    private readonly decode: (blob: Blob) => Promise<ImageBitmap> = decodeScaled,
    private readonly max = IMAGE_CACHE_MAX,
  ) {}

  /** Das Bild, wenn es da ist; sonst beginnt das Laden und es gibt `undefined` (Platzhalter). */
  get = (ref: string): CanvasImageSource | undefined => {
    const e = this.entries.get(ref);
    if (e) {
      // Ein gescheitertes Bild nach einer Weile noch einmal versuchen (Datei kommt vielleicht erst vom Server).
      if (e.state === "failed" && ++this.clock - e.at > 600) this.entries.delete(ref);
      else if (e.state !== "failed") e.at = ++this.clock;
      return e.state === "ready" ? e.image : undefined;
    }
    this.entries.set(ref, { state: "loading", at: ++this.clock });
    void this.load(ref);
    return undefined;
  };

  private async load(ref: string) {
    try {
      const url = await this.resolve(ref);
      if (!url) throw new Error("no file store");
      const blob = await (await fetch(url)).blob();
      const image = await this.decode(blob);
      if (this.dead) { image.close(); return; }
      this.entries.set(ref, { state: "ready", at: ++this.clock, image });
      this.evict();
      this.onLoad();
    } catch {
      if (!this.dead) this.entries.set(ref, { state: "failed", at: ++this.clock });
    }
  }

  private evict() {
    const ready = [...this.entries].filter((e): e is [string, Extract<Entry, { state: "ready" }>] => e[1].state === "ready");
    if (ready.length <= this.max) return;
    ready.sort((a, b) => a[1].at - b[1].at);
    for (const [ref, e] of ready.slice(0, ready.length - this.max)) {
      e.image.close();
      this.entries.delete(ref);
    }
  }

  get size(): number { return this.entries.size; }

  destroy() {
    this.dead = true;
    for (const e of this.entries.values()) if (e.state === "ready") e.image.close();
    this.entries.clear();
  }
}

async function decodeScaled(blob: Blob): Promise<ImageBitmap> {
  const full = await createImageBitmap(blob);
  const k = IMAGE_DECODE_MAX / Math.max(full.width, full.height);
  if (k >= 1) return full;
  // Verkleinert neu entpacken und das große Bild sofort freigeben.
  const small = await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(full.width * k)), resizeHeight: Math.max(1, Math.round(full.height * k)), resizeQuality: "medium" });
  full.close();
  return small;
}
