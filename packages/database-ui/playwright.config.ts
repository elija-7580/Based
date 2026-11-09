import { defineConfig, devices } from "@playwright/test";

// BSD-155: Datenbank-Ansichten auf WebKit (iOS, Mac) und Chromium (Android, Windows); Testseite auf Port 4193.
// Gebaut + preview (Produktions-React), damit die Messungen zum Scrollen echte Werte liefern.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  reporter: process.env.CI ? "list" : [["list"]],
  use: { baseURL: "http://localhost:4193", viewport: { width: 1280, height: 800 } },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: "pnpm exec vite build && pnpm exec vite preview",
    url: "http://localhost:4193",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
