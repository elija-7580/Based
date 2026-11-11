// @based/ui – gemeinsame React-Bausteine der Based-Oberflächen (Web, später Desktop/Mobile-Hüllen). Nur Tokens,
// keine Farbliterale (ADR 0009); Logik bleibt in @based/core.
export { VirtualList } from "./VirtualList.js";
export type { VirtualListProps } from "./VirtualList.js";
export { sameRange, scrollToReveal, windowRange } from "./virtual.js";
export type { WindowRange } from "./virtual.js";
export * from "./holdKey.js";
