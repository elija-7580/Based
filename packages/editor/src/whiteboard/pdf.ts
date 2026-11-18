// BSD-266: PDF als „Ausdruck“ auf dem Board – jede Seite ein Objekt, auf das man schreiben kann. pdf.js (Apache-2.0)
// wird erst geladen, wenn das erste PDF auftaucht (eigenes Paket, nicht im Start der App). Gezeichnet werden nur
// Seiten, die zu sehen sind, in der nötigen Auflösung; wenige fertige Seiten bleiben im Speicher, eine nach der
// anderen wird gerechnet (schwache Geräte bleiben bedienbar).
type Pdfjs = typeof import("pdfjs-dist");
type PdfDoc = Awaited<ReturnType<Pdfjs["getDocument"]>["promise"]>;

let lib: Promise<Pdfjs> | undefined;
function pdfjs(): Promise<Pdfjs> {
  lib ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
    return m;
  });
  return lib;
}

/** Breite einer PDF-Seite auf dem Board (Welt-px) und höchstens so viele Seiten werden als Objekte abgelegt. */
export const PDF_PAGE_WIDTH = 560;
export const PDF_MAX_PAGES = 200;
/** Größte Kante einer gerechneten Seite (px) und Zahl der Seiten im Speicher. */
export const PDF_RENDER_MAX = 2200;
/** Speicher für gerechnete Seiten: höchstens so viele Pixel (≈ 4 Byte je Pixel). Kleine Fassungen kosten fast nichts,
 *  darum bleiben beim Rauszoomen alle Seiten sichtbar. */
export const PDF_PIXEL_BUDGET = 24_000_000;
const TIERS = [320, 700, 1300, PDF_RENDER_MAX] as const;

/** Seitenmaße (in Punkt) eines PDFs lesen – beim Ablegen, um die Objekte in der richtigen Form anzulegen. */
export async function pdfPageSizes(data: ArrayBuffer): Promise<{ width: number; height: number }[]> {
  const { getDocument } = await pdfjs();
  const doc = await getDocument({ data }).promise;
  try {
    const out: { width: number; height: number }[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, PDF_MAX_PAGES); i++) {
      const v = (await doc.getPage(i)).getViewport({ scale: 1 });
      out.push({ width: v.width, height: v.height });
    }
    return out;
  } finally {
    void doc.destroy();
  }
}

interface PageEntry { at: number; tier: number; canvas?: HTMLCanvasElement; state: "loading" | "ready" | "failed" }

export class BoardPdfCache {
  private readonly docs = new Map<string, Promise<PdfDoc>>();
  private readonly pages = new Map<string, PageEntry>();
  private queue: Promise<void> = Promise.resolve();
  private clock = 0;
  private dead = false;
  constructor(private readonly resolve: (ref: string) => Promise<string> | undefined, private readonly onLoad: () => void) {}

  /**
   * Die Seite als Bild, mindestens `pxWidth` breit (auf Stufen gerundet, damit Zoomen nicht ständig neu rechnet).
   * Ist die gewünschte Stufe noch nicht da, kommt die beste vorhandene – nie ein leeres Blatt, wenn es schon ein Bild gab.
   */
  get = (ref: string, page: number, pxWidth: number): CanvasImageSource | undefined => {
    const tier = TIERS.find((t) => t >= pxWidth) ?? PDF_RENDER_MAX;
    const key = (t: number) => `${ref}#${page}@${t}`;
    let best: PageEntry | undefined;
    for (const t of TIERS) {
      const e = this.pages.get(key(t));
      if (e?.canvas && (!best || Math.abs(t - tier) < Math.abs(best.tier - tier) || (t >= tier && best.tier < tier))) best = e;
    }
    const want = this.pages.get(key(tier));
    if (!want) {
      this.pages.set(key(tier), { at: ++this.clock, tier, state: "loading" });
      // Zuerst schnell eine kleine Fassung, dann die gewünschte.
      if (!best && tier > TIERS[0]) { this.pages.set(key(TIERS[0]), { at: ++this.clock, tier: TIERS[0], state: "loading" }); this.render(ref, page, TIERS[0], key(TIERS[0])); }
      this.render(ref, page, tier, key(tier));
    } else want.at = ++this.clock;
    if (best) best.at = ++this.clock;
    return (want?.canvas ?? best?.canvas);
  };

  private doc(ref: string): Promise<PdfDoc> {
    let d = this.docs.get(ref);
    if (!d) {
      d = (async () => {
        const url = await this.resolve(ref);
        if (!url) throw new Error("no file store");
        const data = await (await fetch(url)).arrayBuffer();
        return (await pdfjs()).getDocument({ data }).promise;
      })();
      this.docs.set(ref, d);
      d.catch(() => this.docs.delete(ref));
    }
    return d;
  }

  private render(ref: string, page: number, width: number, key: string) {
    this.queue = this.queue.then(async () => {
      if (this.dead) return;
      try {
        const p = await (await this.doc(ref)).getPage(page);
        const base = p.getViewport({ scale: 1 });
        const viewport = p.getViewport({ scale: width / base.width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await p.render({ canvas, viewport }).promise;
        if (this.dead) return;
        this.pages.set(key, { at: ++this.clock, tier: width, canvas, state: "ready" });
        this.evict();
        this.onLoad();
      } catch {
        const e = this.pages.get(key);
        if (e && !this.dead) e.state = e.canvas ? "ready" : "failed";
      }
    });
  }

  private evict() {
    const ready = [...this.pages].filter(([, e]) => e.canvas);
    let pixels = ready.reduce((n, [, e]) => n + e.canvas!.width * e.canvas!.height, 0);
    if (pixels <= PDF_PIXEL_BUDGET) return;
    // Zuerst die großen, lange nicht gebrauchten; die kleinste Fassung einer Seite bleibt, solange es geht.
    ready.sort((a, b) => (a[1].tier === TIERS[0] ? 1 : 0) - (b[1].tier === TIERS[0] ? 1 : 0) || a[1].at - b[1].at);
    for (const [k, e] of ready) {
      if (pixels <= PDF_PIXEL_BUDGET) break;
      pixels -= e.canvas!.width * e.canvas!.height;
      e.canvas!.width = 0; e.canvas!.height = 0; // Speicher sofort freigeben
      this.pages.delete(k);
    }
  }

  destroy() {
    this.dead = true;
    for (const d of this.docs.values()) void d.then((doc) => doc.destroy()).catch(() => undefined);
    for (const e of this.pages.values()) if (e.canvas) { e.canvas.width = 0; e.canvas.height = 0; }
    this.docs.clear();
    this.pages.clear();
  }
}
