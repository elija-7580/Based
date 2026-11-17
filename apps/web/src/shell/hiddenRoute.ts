// BSD-486: Alte Links und Tabs auf Ansichten, die dieser Build oder diese Einstellung ausblendet (#meetings, #graph,
// #coding im Beta-Build; #chat, #tasks, #agent-…, #project-… ohne AI), landen auf Home – und die Adresse wird per
// replaceState zu #home, damit Neuladen und Zurück nicht wieder auf die ausgeblendete Ansicht führen.
import { commandVisible } from "./beta.js";
import type { Route } from "./router.js";

const GATED = new Set<Route["name"]>(["graph", "meetings", "coding"]);
const AI_ROUTES = new Set<Route["name"]>(["chat", "tasks", "coding", "agent", "project"]);

/** Ist diese Ansicht hier ausgeblendet? Dann führt die Shell auf Home (nicht in die Library). */
export function hiddenRoute(r: Route, ai: boolean, visible: (id: string) => boolean = commandVisible): boolean {
  if (GATED.has(r.name) && !visible(r.name)) return true;
  return !ai && AI_ROUTES.has(r.name);
}
