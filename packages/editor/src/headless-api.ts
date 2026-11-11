// Typen von `@based/editor/headless` für Pakete mit exactOptionalPropertyTypes (z. B. apps/server). Laufzeit:
// headless.ts. Dass beide zusammenpassen, prüft test/headless.test.ts.
import type { BlockConverter } from "./yjs/session.js";
export * from "./headless-shared.js";
/** Konverter BlockNote ⇄ Y-XML mit dem Based-Schema (läuft ohne DOM). */
export declare function createConverter(): BlockConverter;
export { addObject, BOARD_META, BOARD_OBJECTS, BOARD_VERSION, bringToFront, readBoard, removeObjects, updateObject } from "./whiteboard/yboard.js";
