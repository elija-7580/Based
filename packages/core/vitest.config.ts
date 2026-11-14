import { defineConfig } from "vitest/config";

// Golden Fixtures *.utc.json gelten für UTC (fixtures/README.md).
// testTimeout 20 s (BSD-404): die Zeitmessungen (expectWithinBudget) wiederholen bis zu dreimal und messen CPU-Zeit;
// auf der geteilten 4-Kern-Maschine (Last > 20) riss sonst das Vitest-Standard-Timeout (5 s Wanduhr), nicht das Budget.
export default defineConfig({ test: { env: { TZ: "UTC" }, testTimeout: 20_000 } });
