// Writes tokens.css from tokens.json.
import { writeFileSync } from "node:fs";
import { buildCss } from "../src/index.ts";

writeFileSync(new URL("../tokens.css", import.meta.url), buildCss());
console.log("tokens.css written");
