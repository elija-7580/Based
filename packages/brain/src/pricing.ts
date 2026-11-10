// Grobe Kostenschätzung aus dem Modellnamen (Swift `ModelPricing`, BasedBrain/Agent/AgentBudget.swift): Preisklassen
// in USD je Million Tokens. Nur eine Schätzung – im Chat als solche gekennzeichnet; lokale Modelle kosten nichts.
import type { Usage } from "./messages.js";

export interface Price {
  input: number;
  output: number;
}

export const PRICE_CLASSES = {
  free: { input: 0, output: 0 },
  small: { input: 1, output: 5 },
  balanced: { input: 3, output: 15 },
  strong: { input: 5, output: 25 },
} as const satisfies Record<string, Price>;

/** Preisklasse aus dem Modellnamen (Anbieter-Präfix erlaubt, z. B. „ollama/llama3“). */
export function priceFor(model: string): Price {
  const m = model.toLowerCase();
  if (m.startsWith("ollama/") || m.startsWith("apple/") || m.includes("on-device")) return PRICE_CLASSES.free;
  if (["haiku", "mini", "flash", "nano", "small"].some((s) => m.includes(s))) return PRICE_CLASSES.small;
  if (["opus", "gpt-5", "-pro", "ultra"].some((s) => m.includes(s))) return PRICE_CLASSES.strong;
  return PRICE_CLASSES.balanced;
}

export function estimateCost(model: string, usage: Usage): number {
  const p = priceFor(model);
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
}

/** „1.2k“, „34k“, „1.1M“. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

/** „$0.0042“, „$0.13“, „$2.40“. */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "$" + usd.toFixed(4);
  return "$" + usd.toFixed(2);
}
