// Schriften für Font „Based“ (Schibsted Grotesk, Literata), lokal gebündelt aus @fontsource-variable (SIL OFL 1.1) –
// nichts von fremden Servern.
//
// Elija 20.11.: „Die Schriften wechseln hin und her, springen hin und her.“ Drei Ursachen, hier behoben:
// - Feste Schnitte (400/500/…): Überschriften (600–700) und Fett in Literata gab es nicht, der Browser hat Medium
//   künstlich verdickt; 450 und 650 sprangen auf den nächsten Schnitt. Variable Schriften haben jedes Gewicht und
//   echte Kursive.
// - Nachgeladen erst nach dem ersten Bild und je Gewicht erst bei Bedarf (font-display: swap): Text erschien in
//   der Ersatzschrift und sprang dann um. Jetzt wartet der Start kurz auf die Dateien (main.tsx), und beim Umschalten
//   in den Einstellungen wechselt die Schrift erst, wenn sie da ist (App.tsx).
// Die @font-face-Regeln kosten nichts: Dateien holt der Browser erst, wenn die Schrift gebraucht oder geladen wird.
import "@fontsource-variable/schibsted-grotesk/wght.css";
import "@fontsource-variable/schibsted-grotesk/wght-italic.css";
import "@fontsource-variable/literata/wght.css";
import "@fontsource-variable/literata/wght-italic.css";

/** Je Familie normal und kursiv; eine variable Datei deckt alle Gewichte ab. Probe-Text = lateinischer Bereich. */
const FACES = [
  '400 16px "Schibsted Grotesk Variable"',
  'italic 400 16px "Schibsted Grotesk Variable"',
  '400 16px "Literata Variable"',
  'italic 400 16px "Literata Variable"',
];
const SAMPLE = "Based Äöü 0123";

let loading: Promise<boolean> | undefined;

/** Lädt die Schriften für Font „Based“ (einmal). true, sobald alle da sind; false, wenn der Browser sie nicht laden kann. */
export function loadBasedFonts(): Promise<boolean> {
  const fonts = (globalThis.document as Document | undefined)?.fonts;
  if (!fonts) return Promise.resolve(false);
  loading ??= Promise.all(FACES.map((f) => fonts.load(f, SAMPLE))).then((r) => r.every((x) => x.length > 0), () => false);
  return loading;
}

/** Schon geladen? (Dann kann die Schrift ohne Warten wechseln.) */
export function basedFontsReady(): boolean {
  const fonts = (globalThis.document as Document | undefined)?.fonts;
  return !!fonts && FACES.every((f) => fonts.check(f, SAMPLE));
}

/** Wartet höchstens `ms` auf die Schriften – der Start soll nie an einer Schrift hängen. */
export function waitForBasedFonts(ms: number): Promise<void> {
  return Promise.race([loadBasedFonts().then(() => undefined), new Promise<void>((r) => setTimeout(r, ms))]);
}
