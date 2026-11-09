import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// BSD-155: eigene Testseite (testpage/) für Playwright auf Port 4193; Vitest prüft die View-Logik in src/.
export default defineConfig({
  root: "testpage",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { port: 4193, strictPort: true },
  preview: { port: 4193, strictPort: true },
  test: { root: ".", include: ["src/**/*.test.{ts,tsx}"], env: { TZ: "UTC" } },
} as Parameters<typeof defineConfig>[0]);
