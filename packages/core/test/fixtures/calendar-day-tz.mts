// Hilfsprozess für calendar-day.test.ts: läuft mit der Zeitzone aus TZ. Ohne Argument: „2026-11-18“ lesen und als JSON
// ausgeben (schreibendes Gerät); mit JSON-Argument: so zeigen, wie es dieses Gerät zeigt.
import { longDate, parseDate } from "../../src/query/value.js";

const arg = process.argv[2];
console.log(arg ? longDate(JSON.parse(arg)) : JSON.stringify(parseDate("2026-11-18")));
