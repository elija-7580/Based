// BSD-220: Einstieg ohne Oberfläche (kein CSS, kein Editor-UI) für Node, z. B. den Server: Echtzeit-Text
// (TextSession, CollabBinder) und Whiteboard-Dokumente. Seit BSD-407 Teil 4c ohne BlockNote (kein Konverter mehr).
export * from "./headless-shared.js";
export { addObject, BOARD_META, BOARD_OBJECTS, BOARD_VERSION, bringToFront, readBoard, removeObjects, updateObject } from "./whiteboard/yboard.js";
