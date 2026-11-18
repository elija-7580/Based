// Logo-Intro (Elija 17.11.): das Zeichen wird „getippt“. Zuerst zieht sich die Basislinie in einem Zug auf, dann blinkt
// eine Einfügemarke, der Stamm fällt auf die Linie, dann der Bauch. Beim Aufprall federt die Linie nach und die Blöcke
// kippeln über ihre Kanten aus, ohne umzufallen. Reine Zeitfunktion (getestet); die Ansicht steht in LogoIntro.tsx.
//
// Bewusste Ausnahme von „120/180 ms, ohne Federn“ (docs/design/README.md, Abschnitt „Logo-Intro“): ein Markenmoment,
// der einmal läuft. Die Zeiten sind deshalb eigene Werte und keine Motion-Tokens. Alle Maße im Raster des Zeichens
// (viewBox 0 0 100 100, docs/design/logo/based-mark-small.svg).

/** Rechtecke des fertigen Zeichens. */
export const MARK = {
  base: { x: 10, y: 80, width: 80, height: 9, radius: 4.5 },
  stem: { x: 20, y: 8, width: 16, height: 68, radius: 8 },
  belly: { x: 40, y: 38, width: 38, height: 38, radius: 14 },
  /** Versatz der Seitenfläche (Tiefe) nach rechts oben */
  side: { dx: 1.4, dy: -1.2 },
  caret: { y: 10, width: 1.7, height: 66 },
} as const;

/** Ablauf in Millisekunden ab Start. */
export const TIMING = {
  lineStart: 150,
  lineDuration: 600,
  caretStart: 760,
  stemKey: 1500,
  bellyKey: 1860,
  /** Fallzeit eines Blocks bis zum Aufprall */
  fall: 110,
  caretHold: 380,
  caretPeriod: 1000,
  caretLeave: 1000,
  caretFade: 300,
  /** so lange klingt das Kippeln nach dem Aufprall höchstens */
  settle: 1600,
} as const;

/** Ab hier steht das Zeichen still. */
export const LOGO_INTRO_DONE = TIMING.bellyKey + TIMING.fall + TIMING.settle;

const FALL_HEIGHT = 3.5;
const DIP = 1.9;
const STEM_TILT = 4.5;
const STEM_NUDGE = -1.8;
const BELLY_TILT = 3;
/** Abstand der Kippkante von der Blockmitte */
const STEM_EDGE = 3.8;
const BELLY_EDGE = 9.5;
const CARET_GAP = 3.6;

export interface BlockFrame {
  visible: boolean;
  /** Verschiebung nach unten (negativ: noch im Fall) */
  dy: number;
  /** Neigung in Grad, positiv im Uhrzeigersinn */
  angle: number;
  /** Drehpunkt: die Unterkante, über die der Block gerade kippt */
  pivotX: number;
  pivotY: number;
}

export interface LogoIntroFrame {
  baseWidth: number;
  /** Nachgeben der Linie (und von allem, was darauf steht) */
  dip: number;
  stem: BlockFrame;
  belly: BlockFrame;
  caret: { x: number; opacity: number };
  done: boolean;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const easeOutQuart = (k: number) => 1 - (1 - k) ** 4;
const wobble = (dt: number, amplitude: number) => (dt < 0 || dt > TIMING.settle ? 0 : amplitude * Math.exp(-dt / 280) * Math.sin(dt / 52));
const spring = (dt: number) => (dt < 0 || dt > 900 ? 0 : DIP * Math.exp(-dt / 110) * Math.sin(dt / 55));
const falling = (dt: number) => (dt < 0 ? 0 : -FALL_HEIGHT * (1 - clamp(dt / TIMING.fall) ** 2));
const blink = (since: number) => (since < TIMING.caretHold ? 1 : clamp(0.5 + 1.3 * Math.cos(((since - TIMING.caretHold) / TIMING.caretPeriod) * 2 * Math.PI)));

function block(rect: { x: number; y: number; width: number; height: number }, visible: boolean, dy: number, angle: number, edge: number): BlockFrame {
  const centre = rect.x + rect.width / 2;
  return { visible, dy, angle, pivotX: centre + (angle > 0 ? edge : angle < 0 ? -edge : 0), pivotY: rect.y + rect.height + dy };
}

/** Das Bild zum Zeitpunkt `t` (ms seit Start). Ab `LOGO_INTRO_DONE` das ruhende Zeichen. */
export function logoIntroFrame(t: number): LogoIntroFrame {
  const done = !(t < LOGO_INTRO_DONE);
  if (done) t = LOGO_INTRO_DONE;
  const stemHit = TIMING.stemKey + TIMING.fall;
  const bellyHit = TIMING.bellyKey + TIMING.fall;
  const dip = done ? 0 : spring(t - stemHit) + spring(t - bellyHit);
  const baseWidth = MARK.base.height + (MARK.base.width - MARK.base.height) * easeOutQuart(clamp((t - TIMING.lineStart) / TIMING.lineDuration));

  const stemAngle = done ? 0 : wobble(t - stemHit, STEM_TILT) + wobble(t - bellyHit, STEM_NUDGE);
  const bellyAngle = done ? 0 : wobble(t - bellyHit, BELLY_TILT);

  let caret: LogoIntroFrame["caret"] = { x: MARK.stem.x, opacity: 0 };
  if (t >= TIMING.bellyKey) {
    const since = t - TIMING.bellyKey;
    caret = { x: MARK.belly.x + MARK.belly.width + CARET_GAP, opacity: done ? 0 : blink(since) * (1 - clamp((since - TIMING.caretLeave) / TIMING.caretFade)) };
  } else if (t >= TIMING.stemKey) caret = { x: MARK.belly.x, opacity: blink(t - TIMING.stemKey) };
  else if (t >= TIMING.caretStart) caret = { x: MARK.stem.x, opacity: blink(t - TIMING.caretStart) };

  return {
    baseWidth,
    dip,
    stem: block(MARK.stem, t >= TIMING.stemKey, falling(t - TIMING.stemKey) + dip, stemAngle, STEM_EDGE),
    belly: block(MARK.belly, t >= TIMING.bellyKey, falling(t - TIMING.bellyKey) + dip, bellyAngle, BELLY_EDGE),
    caret,
    done,
  };
}
