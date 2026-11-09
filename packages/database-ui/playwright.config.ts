import { defineConfig, devices } from "@playwright/test";

// BSD-155: Datenbank-Ansichten auf WebKit (iOS, Mac) und Chromium (Android, Windows); Testseite auf Port 4193.
// Gebaut + preview (Produktions-React), damit die Messungen zum Scrollen echte Werte liefern.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  // Ein Worker: die Frame-Messungen beim Scrollen sollen nicht mit parallelen Browsern um die CPU konkurrieren.
  workers: 1,
  reporter: process.env.CI ? "list" : [["list"]],
  use: { baseURL: "http://localhost:4193", viewport: { width: 1280, height: 800 } },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    // Headless-WebKit unter Linux malt in Software: mit deviceScaleFactor 2 („Desktop Safari“) braucht schon
    // eine statische HTML-Liste ~40 ms pro Scroll-Frame. Für die Messungen deshalb Faktor 1.
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: "pnpm exec vite build && pnpm exec vite preview",
    url: "http://localhost:4193",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
