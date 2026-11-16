import type { Page } from "@playwright/test";

// BSD-301/305: gemeinsame Layout-Prüfungen für Specs (Überlauf, sich überdeckende Texte, wichtigste Bedienung im
// Startfenster). Maßstab: docs/quality/checklist.md, Abschnitt 2.

/**
 * Sucht Überläufe. Ein Fund: Element mit eigenem Text, dessen Inhalt breiter ist als sein Kasten, ohne dass das
 * gewollt ist (scrollender Bereich oder „…“), oder das aus dem Fenster ragt; dazu ein waagrechter Rollbalken der Seite.
 */
export async function overflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > innerWidth + 1) out.push(`Seite: waagrechter Rollbalken (${de.scrollWidth} > ${innerWidth})`);
    const label = (el: Element) => {
      const cls = typeof el.className === "string" && el.className ? "." + el.className.split(/\s+/).filter((c) => !/^x[0-9a-z]{5,8}$/.test(c)).slice(0, 2).join(".") : "";
      return `${el.tagName.toLowerCase()}${cls} „${(el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}“`;
    };
    /** Liegt das Element in einem Bereich, der absichtlich waagrecht rollt (Tabelle, Code, Tabs)? */
    const inScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth) return true;
      }
      return false;
    };
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
      if (el.closest(".sr-only, [aria-hidden=true], script, style, svg, [hidden]")) continue;
      // Titel-Felder (Seite, Zeile): langer Titel muss umbrechen, nicht im Feld verschwinden.
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && /title/i.test(el.getAttribute("aria-label") ?? "") && el.value !== "") {
        if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) out.push(`Titel-Feld schneidet ab: ${label(el)} „${el.value.slice(0, 40)}“`);
        continue;
      }
      const ecs = getComputedStyle(el);
      // Zeile ohne Umbruch, die abschneidet, ohne „…“ (Breadcrumb, Kopfzeilen)
      if (ecs.whiteSpace === "nowrap" && (ecs.overflowX === "hidden" || ecs.overflowX === "clip") && ecs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 1 && (el.textContent ?? "").trim() !== "" && el.getBoundingClientRect().width > 1 && !inScroller(el)) {
        const kids = [...el.children].filter((k) => (k as HTMLElement).getBoundingClientRect().right > el.getBoundingClientRect().right + 1);
        if (kids.some((k) => getComputedStyle(k).textOverflow !== "ellipsis")) out.push(`Zeile schneidet ab ohne „…“: ${label(el)}`);
      }
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
      if (!own) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue; // auch „visually hidden“ (1 × 1 px, z. B. Astryx-Feldlabels)
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.opacity === "0" || cs.clipPath !== "none" || (cs.clip !== "auto" && cs.clip !== "")) continue;
      if (inScroller(el)) continue;
      // Mit „…“ gekürzt, aber auf fast nichts (weniger als drei Zeichen Platz)
      if (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1 && el.clientWidth < parseFloat(cs.fontSize) * 2) out.push(`auf fast nichts gekürzt: ${label(el)} (${el.clientWidth} px)`);
      // Toleranz 4 px: WebKit zählt das Leerzeichen am Zeilenende umbrochener Zeilen mit (unsichtbar).
      if (el.scrollWidth > el.clientWidth + 4 && cs.display !== "inline") {
        const clipped = cs.overflowX === "hidden" || cs.overflowX === "clip";
        if (!clipped) out.push(`läuft aus dem Kasten: ${label(el)} (${el.scrollWidth} > ${el.clientWidth})`);
        else if (cs.textOverflow !== "ellipsis") out.push(`abgeschnitten ohne „…“: ${label(el)}`);
      }
      if (r.right > innerWidth + 1 || r.left < -1) {
        // Abgeschnitten durch einen Vorfahren (Menü am Rand, Seitenleiste eingefahren)? Dann ist es nicht sichtbar.
        let clippedBy = false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const pc = getComputedStyle(p);
          if (pc.overflowX !== "visible" && p.getBoundingClientRect().right <= innerWidth + 1) { clippedBy = true; break; }
        }
        if (!clippedBy) out.push(`ragt aus dem Fenster: ${label(el)} (${Math.round(r.left)}…${Math.round(r.right)} von ${innerWidth})`);
      }
    }
    return [...new Set(out)];
  });
}

/**
 * BSD-301 Teil 4: Sucht Textzeilen zweier verschiedener Elemente, die sich sichtbar überdecken (z. B. ein Etikett, das
 * unter einen Knopf rutscht, oder zwei absolut gesetzte Beschriftungen). Gemessen werden die Zeilenkästen der
 * Textknoten (Range.getClientRects), beschnitten auf die sichtbaren Bereiche ihrer Vorfahren.
 */
export async function overlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    interface Box { l: number; t: number; r: number; b: number; el: Element; text: string }
    const boxes: Box[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const clipOf = (el: Element) => {
      let c = { l: 0, t: 0, r: innerWidth, b: innerHeight };
      for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const r = p.getBoundingClientRect();
        c = { l: Math.max(c.l, r.left), t: Math.max(c.t, r.top), r: Math.min(c.r, r.right), b: Math.min(c.b, r.bottom) };
      }
      return c;
    };
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? "").trim();
      const el = n.parentElement;
      if (!text || !el) continue;
      if (el.closest(".sr-only, [aria-hidden=true], script, style, svg, [hidden], noscript, [data-tooltip], [role=tooltip]")) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const cs = getComputedStyle(el);
      if (cs.clipPath !== "none" || (cs.clip !== "auto" && cs.clip !== "")) continue;
      const clip = clipOf(el);
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        const b = { l: Math.max(r.left, clip.l), t: Math.max(r.top, clip.t), r: Math.min(r.right, clip.r), b: Math.min(r.bottom, clip.b) };
        if (b.r - b.l > 2 && b.b - b.t > 2) boxes.push({ ...b, el, text });
      }
    }
    boxes.sort((a, b) => a.t - b.t);
    const out = new Set<string>();
    const name = (x: Box) => `${x.el.tagName.toLowerCase()}${typeof x.el.className === "string" && x.el.className ? "." + x.el.className.split(/\s+/)[0] : ""} „${x.text.slice(0, 30)}“`;
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i]!;
      for (let j = i + 1; j < boxes.length && boxes[j]!.t < a.b; j++) {
        const b = boxes[j]!;
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
        const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
        // Benachbarte Zeilen mit knappem Zeilenabstand berühren sich: erst ab einem Drittel der Zeilenhöhe zählt es.
        if (!(w > 4 && h > Math.min(a.b - a.t, b.b - b.t) / 3)) continue;
        // Verdeckt statt überdeckt: Liegt über der Stelle ein deckender Kasten des einen (z. B. die Kopfzeile, unter
        // der der Text weiterrollt), sieht man den anderen Text nicht – das ist kein Fund.
        const cx = (Math.max(a.l, b.l) + Math.min(a.r, b.r)) / 2, cy = (Math.max(a.t, b.t) + Math.min(a.b, b.b)) / 2;
        const hit = document.elementFromPoint(cx, cy);
        const top = hit && (a.el.contains(hit) || hit.contains(a.el) ? a : b.el.contains(hit) || hit.contains(b.el) ? b : undefined);
        if (!top) continue; // etwas Drittes liegt darüber
        const other = top === a ? b : a;
        let covered = false;
        for (let p: Element | null = top.el; p && !p.contains(other.el); p = p.parentElement) {
          const bg = getComputedStyle(p).backgroundColor;
          const m = /rgba?\(([^)]*)\)/.exec(bg);
          const alpha = m ? Number(m[1]!.split(",")[3] ?? 1) : 0;
          if (alpha > 0.9) { covered = true; break; }
        }
        if (!covered) out.add(`überdeckt sich: ${name(a)} ↔ ${name(b)}`);
      }
    }
    return [...out];
  });
}

/** BSD-301 Teil 4: Die wichtigste Bedienung eines Screens liegt ohne Scrollen ganz im Fenster. */
export async function primaryVisible(page: Page, sel: string): Promise<string | undefined> {
  const box = await page.locator(sel).first().boundingBox();
  const vp = page.viewportSize()!;
  if (!box) return `wichtigste Bedienung fehlt: ${sel}`;
  if (box.x < -1 || box.y < -1 || box.x + box.width > vp.width + 1 || box.y + box.height > vp.height + 1) return `wichtigste Bedienung nicht im Startfenster: ${sel} (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)})`;
  return undefined;
}
