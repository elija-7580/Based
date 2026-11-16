// BSD-417: Bewegung in TypeScript (Web Animations, Rollen) aus denselben Motion-Tokens wie das CSS
// (packages/design-tokens: --duration-fast 120 ms, --duration 180 ms, --ease-out) – keine festen Zahlen im Code. Mit
// „Bewegung reduzieren“ des Systems gibt es keine Bewegung: Animationen entfallen, Rollen springen.
import { motion } from "@based/design-tokens";

const token = (name: string): string => motion.find((t) => t.name === name)?.value ?? "";

export const MOTION = {
  /** Überfahren, Drücken, Umschalter */
  fast: parseFloat(token("duration-fast")),
  /** Menüs, Paneele, Karten, die ihren Platz wechseln */
  base: parseFloat(token("duration")),
  /** jede Bewegung: ohne Federn, ohne Schleifen */
  ease: token("ease-out"),
} as const;

export const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** `scrollIntoView`/`scrollTo` sanft – oder sofort, wenn Bewegung reduziert ist. */
export const scrollBehavior = (): ScrollBehavior => (reducedMotion() ? "auto" : "smooth");
