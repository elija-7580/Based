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
export const PDF_CACHE_MAX = 10;

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

interface PageEntry { at: number; width: number; canvas?: HTMLCanvasElement; state: "loading" | "ready" | "failed" }

export class BoardPdfCache {
  private readonly docs = new Map<string, Promise<PdfDoc>>();
  private readonly pages = new Map<string, PageEntry>();
  private queue: Promise<void> = Promise.resolve();
  private clock = 0;
  private dead = false;
  constructor(private readonly resolve: (ref: string) => Promise<string> | undefined, private readonly onLoad: () => void) {}

  /**
   * Die Seite als Bild, mindestens `pxWidth` breit (auf Stufen gerundet, damit Zoomen nicht ständig neu rechnet).
   * Ist nur eine gröbere Fassung da, kommt die – und die feinere wird gerechnet.
   */
  get = (ref: string, page: number, pxWidth: number): CanvasImageSource | undefined => {
    const want = Math.min(PDF_RENDER_MAX, pxWidth <= 700 ? 700 : pxWidth <= 1300 ? 1300 : PDF_RENDER_MAX);
    const key = `${ref}#${page}`;
    const e = this.pages.get(key);
    if (e) {
      e.at = ++this.clock;
      if (e.state !== "loading" && e.state !== "failed" && e.width < want) { e.state = "loading"; this.render(ref, page, want, key); }
      return e.canvas;
    }
    this.pages.set(key, { at: ++this.clock, width: 0, state: "loading" });
    this.render(ref, page, want, key);
    return undefined;
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
        this.pages.set(key, { at: ++this.clock, width, canvas, state: "ready" });
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
    if (ready.length <= PDF_CACHE_MAX) return;
    ready.sort((a, b) => a[1].at - b[1].at);
    for (const [k, e] of ready.slice(0, ready.length - PDF_CACHE_MAX)) {
      if (e.canvas) { e.canvas.width = 0; e.canvas.height = 0; } // Speicher sofort freigeben
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
