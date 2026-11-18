// BSD-220: Einstieg ohne Oberfläche (kein CSS, kein Editor-UI) für Node, z. B. den Server: Echtzeit-Text
// (TextSession, CollabBinder) und Whiteboard-Dokumente. Seit BSD-407 Teil 4c ohne BlockNote (kein Konverter mehr).
export * from "./headless-shared.js";
export { addObject, BOARD_META, BOARD_OBJECTS, BOARD_VERSION, boardObjectsMap, bringToFront, readBoard, readObject, removeObjects, updateObject } from "./whiteboard/yboard.js";
// BSD-264: Board-Sitzung (Records ⇄ Y.Doc, Undo)
export { BOARD_LOCAL, BOARD_STORE, BoardSession, type BoardOps, type BoardPeer, type BoardSessionOptions } from "./whiteboard/session.js";
