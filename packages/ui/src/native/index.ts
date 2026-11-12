// „Nichts vom System“: Jeder Klick in Based öffnet Based-Oberfläche. Einmal am Start aufrufen (apps/web/main.tsx);
// danach gilt im ganzen Fenster: eigenes Kontextmenü, eigene Auswahlliste für jedes <select>, eigene Tooltips statt
// der title-Blase. Datum/Uhrzeit: DateField/TimeField (fields.tsx). Styles: native.css.
import { installContextMenu, type ContextMenuOptions } from "./contextMenu.js";
import { installLayers } from "./layer.js";
import { installSelects } from "./select.js";
import { installTooltips } from "./tooltip.js";

export { registerContextItems, contextEntries, pasteInto } from "./contextMenu.js";
export type { ClipboardAccess, ContextInfo, ContextMenuOptions } from "./contextMenu.js";
export { showMenu } from "./menu.js";
export { closeLayers, openLayer } from "./layer.js";
export { openSelect, selectEntries } from "./select.js";
export { openCalendar, openTimeList } from "./calendar.js";
export { DateField, TimeField } from "./fields.js";
export * from "./logic.js";

let uninstall: (() => void) | undefined;

export function installNativeFree(opts: ContextMenuOptions = {}): () => void {
  uninstall?.();
  installLayers();
  const parts = [installContextMenu(opts), installSelects(), installTooltips()];
  document.documentElement.dataset.nativeFree = "";
  uninstall = () => { parts.forEach((f) => f()); delete document.documentElement.dataset.nativeFree; uninstall = undefined; };
  return uninstall;
}
