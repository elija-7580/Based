// ADR 0011: Logik liegt in packages/*, die Hüllen (apps/*) bleiben dünn.
// Diese Regel verhindert die Gegenrichtung: packages/* importieren nie aus apps/*.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/target/**", "**/.build/**", "Packages/**", "App/**", "spikes/**", "Web/**", "**/playwright-report/**", "**/test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/*.{js,mjs,cjs}"], languageOptions: { globals: globals.node } },
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }] } },
  {
    files: ["packages/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@based/web", "@based/web/*", "@based/desktop", "@based/desktop/*", "@based/server", "@based/server/*"], message: "packages/* dürfen nicht aus apps/* importieren (ADR 0011)." },
          { group: ["**/apps/**", "../../apps/*", "../../../apps/*"], message: "packages/* dürfen nicht aus apps/* importieren (ADR 0011)." }
        ]
      }]
    }
  }
);
