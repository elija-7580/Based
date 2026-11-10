#!/usr/bin/env node
// Einstieg des `based`-Befehls: lädt die TypeScript-Quellen über tsx (kein Build-Schritt nötig).
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
