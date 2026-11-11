// BSD-220: Einstieg ohne Oberfläche (kein CSS, kein Editor-UI) für Node, z. B. den Server: Y.Doc ↔ Records
// (DocSession) und der Konverter mit dem Based-Schema. Strenge Pakete prüfen gegen `headless-api.ts` (siehe
// package.json, Bedingung `types`), weil die BlockNote-Typen nicht mit exactOptionalPropertyTypes kompilieren.
export * from "./headless-shared.js";
export { createConverter } from "./schema/schema.js";
export { addObject, BOARD_META, BOARD_OBJECTS, BOARD_VERSION, bringToFront, readBoard, removeObjects, updateObject } from "./whiteboard/yboard.js";
