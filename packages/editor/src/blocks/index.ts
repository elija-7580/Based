// BSD-381 (ADR 0016): neuer Block-Editor. E0 = Gerüst (Anzeige direkt aus den Records), Testseite als Fixture.
export { BlockPage } from "./BlockPage.js";
export type { BlockPageProps } from "./BlockPage.js";
export { blockTree, flatIDs, outlineOf, OPAQUE_TYPES } from "./tree.js";
export type { BlockNode } from "./tree.js";
export { BLOCK_FIXTURE_TITLE, FIXTURE_TABLE_ROWS, blockFixtureOutline, buildBlockFixture } from "./fixture.js";
