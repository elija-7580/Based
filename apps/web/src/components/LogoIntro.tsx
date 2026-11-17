// Logo-Intro: das Based-Zeichen, das sich einmal „tippt“ (Ablauf und Begründung in logoTimeline.ts). Läuft genau einmal;
// mit „Bewegung reduzieren“ steht sofort das fertige Zeichen. Farben nur über Klassen aus Tokens (logoIntro.css).
// Das Zeichen ist eine Grafik, kein Icon – deshalb eigenes SVG (Ausnahme in tokens-only.test.ts).
import { useLayoutEffect, useRef } from "react";
import { reducedMotion } from "../shell/motion.js";
import { LOGO_INTRO_DONE, MARK, logoIntroFrame, type BlockFrame, type LogoIntroFrame } from "./logoTimeline.js";
import "./logoIntro.css";

const REST = logoIntroFrame(LOGO_INTRO_DONE);

function place(el: SVGElement | null, b: BlockFrame) {
  if (!el) return;
  el.setAttribute("opacity", b.visible ? "1" : "0");
  el.setAttribute("transform", `translate(0 ${b.dy.toFixed(3)}) rotate(${b.angle.toFixed(3)} ${b.pivotX} ${(b.pivotY - b.dy).toFixed(3)})`);
}

function Block({ rect, blockRef }: { rect: { x: number; y: number; width: number; height: number; radius: number }; blockRef: React.Ref<SVGGElement> }) {
  return (
    <g ref={blockRef}>
      <rect className="side" x={rect.x + MARK.side.dx} y={rect.y + MARK.side.dy} width={rect.width} height={rect.height} rx={rect.radius} />
      <rect className="face" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={rect.radius} />
    </g>
  );
}

export function LogoIntro({ label = "Based" }: { label?: string }) {
  const root = useRef<SVGSVGElement>(null);
  const base = useRef<SVGGElement>(null);
  const baseSide = useRef<SVGRectElement>(null);
  const baseFace = useRef<SVGRectElement>(null);
  const stem = useRef<SVGGElement>(null);
  const belly = useRef<SVGGElement>(null);
  const caret = useRef<SVGRectElement>(null);

  useLayoutEffect(() => {
    const draw = (f: LogoIntroFrame) => {
      base.current?.setAttribute("transform", `translate(0 ${f.dip.toFixed(3)})`);
      for (const r of [baseSide.current, baseFace.current]) r?.setAttribute("width", f.baseWidth.toFixed(3));
      place(stem.current, f.stem);
      place(belly.current, f.belly);
      caret.current?.setAttribute("x", String(f.caret.x));
      caret.current?.setAttribute("opacity", f.caret.opacity.toFixed(3));
      caret.current?.setAttribute("transform", `translate(0 ${f.dip.toFixed(3)})`);
      if (f.done) root.current?.setAttribute("data-state", "done");
    };
    if (reducedMotion() || typeof requestAnimationFrame !== "function") return draw(REST);
    root.current?.setAttribute("data-state", "playing");
    const start = performance.now();
    let id = 0;
    const tick = (now: number) => {
      const f = logoIntroFrame(now - start);
      draw(f);
      if (!f.done) id = requestAnimationFrame(tick);
    };
    draw(logoIntroFrame(0));
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <svg ref={root} className="logo-intro" viewBox="0 0 100 100" role="img" aria-label={label} data-testid="logo-intro" data-state="done">
      <g ref={base}>
        <rect ref={baseSide} className="base-side" x={MARK.base.x + MARK.side.dx} y={MARK.base.y + MARK.side.dy} width={REST.baseWidth} height={MARK.base.height} rx={MARK.base.radius} />
        <rect ref={baseFace} className="base" x={MARK.base.x} y={MARK.base.y} width={REST.baseWidth} height={MARK.base.height} rx={MARK.base.radius} />
      </g>
      <Block rect={MARK.stem} blockRef={stem} />
      <Block rect={MARK.belly} blockRef={belly} />
      <rect ref={caret} className="caret" x={REST.caret.x} y={MARK.caret.y} width={MARK.caret.width} height={MARK.caret.height} rx={MARK.caret.width / 2} opacity={0} />
    </svg>
  );
}
