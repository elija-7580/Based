import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  // BSD-153: Store-Worker als ES-Modul (SQLite-WASM lädt sein .wasm relativ zum Modul).
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
} as Parameters<typeof defineConfig>[0]);
