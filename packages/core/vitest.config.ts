import { defineConfig } from "vitest/config";

// Golden Fixtures *.utc.json gelten für UTC (fixtures/README.md).
export default defineConfig({ test: { env: { TZ: "UTC" } } });
