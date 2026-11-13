import { defineConfig } from "vitest/config";

// Golden Fixtures *.utc.json gelten für UTC (fixtures/README.md), z. B. fixtures/agents/budget.utc.json (BSD-393).
export default defineConfig({ test: { env: { TZ: "UTC" } } });
