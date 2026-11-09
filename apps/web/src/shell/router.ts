// BSD-153: Navigation über schlichte Hash-Namen (#home, #graph, #appearance, #trash, #page-<id>; die claude.ai-
// Vorschau kennt nur #name, „settings“ ist dort reserviert) mit eigenem Verlauf für Vor/Zurück.

export type Route =
  | { name: "home" }
  | { name: "graph" }
  | { name: "settings" }
  | { name: "trash" }
  | { name: "page"; id: string };

export function routeToHash(r: Route): string {
  switch (r.name) {
    case "home": return "home";
    case "graph": return "graph";
    case "settings": return "appearance";
    case "trash": return "trash";
    case "page": return "page-" + r.id;
  }
}

export function routeFromHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  if (h.startsWith("page-") && h.length > 5) return { name: "page", id: decodeURIComponent(h.slice(5)) };
  switch (h) {
    case "graph": return { name: "graph" };
    case "appearance": case "settings": return { name: "settings" };
    case "trash": return { name: "trash" };
    default: return { name: "home" };
  }
}

export const sameRoute = (a: Route, b: Route) => routeToHash(a) === routeToHash(b);

/**
 * Verlauf für Vor/Zurück. Der Browser-Verlauf trägt den Index im `history.state`, damit Zurück/Vor im Browser und
 * die Knöpfe der Shell dasselbe tun.
 */
export class History {
  private index = 0;
  private length = 1;
  private listeners = new Set<() => void>();
  route: Route;

  constructor(private readonly win: Pick<Window, "location" | "history" | "addEventListener"> = window) {
    this.route = routeFromHash(win.location.hash);
    const st = win.history.state as { i?: number; n?: number } | null;
    if (typeof st?.i === "number") {
      this.index = st.i;
      this.length = Math.max(st.n ?? st.i + 1, st.i + 1);
    } else win.history.replaceState({ i: 0, n: 1 }, "", "#" + routeToHash(this.route));
    win.addEventListener("popstate", () => {
      const s = win.history.state as { i?: number } | null;
      this.index = typeof s?.i === "number" ? s.i : this.index;
      this.route = routeFromHash(win.location.hash);
      this.emit();
    });
  }

  get canBack() {
    return this.index > 0;
  }
  get canForward() {
    return this.index < this.length - 1;
  }

  navigate(r: Route, opts: { replace?: boolean } = {}) {
    if (sameRoute(r, this.route) && !opts.replace) return;
    this.route = r;
    if (opts.replace) this.win.history.replaceState({ i: this.index, n: this.length }, "", "#" + routeToHash(r));
    else {
      this.index += 1;
      this.length = this.index + 1;
      this.win.history.pushState({ i: this.index, n: this.length }, "", "#" + routeToHash(r));
    }
    this.emit();
  }

  back() {
    if (this.canBack) this.win.history.back();
  }
  forward() {
    if (this.canForward) this.win.history.forward();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
