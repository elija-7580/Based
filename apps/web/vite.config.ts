import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";

// BSD-319: Version und Commit für „Problem melden“ und Settings → Diagnostics. V setzt der Desktop-Workflow (0.1.<Lauf>).
const commit = (() => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
})();

export default defineConfig({
  plugins: [react()],
  define: {
    __BASED_VERSION__: JSON.stringify(process.env.V ?? process.env.BASED_VERSION ?? ""),
    __BASED_COMMIT__: JSON.stringify(commit),
    // AI-Schalter (shell/ai.ts): Beta-Builds bieten AI nicht an; E2E/Entwicklung kann den Standard auf „an“ setzen.
    __BASED_AI_OPTION__: JSON.stringify(process.env.BASED_CHANNEL !== "beta"),
    __BASED_AI_DEFAULT__: JSON.stringify(process.env.BASED_AI_DEFAULT === "on"),
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  // BSD-153: Store-Worker als ES-Modul (SQLite-WASM lädt sein .wasm relativ zum Modul).
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
} as Parameters<typeof defineConfig>[0]);
