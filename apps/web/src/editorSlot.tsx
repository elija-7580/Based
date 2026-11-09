// Phase 2: @based/editor in den PageEditor-Steckplatz der Shell. Theme folgt dem Wurzel-Attribut data-theme;
// Inline-Datenbanken rendert der DatabaseView-Steckplatz (sobald @based/database-ui eingesteckt ist).
import { useEffect, useState } from "react";
import { PageEditor, type DatabaseRenderProps } from "@based/editor";
import { slots, type PageEditorProps } from "./slots.js";

function useRootTheme(): "light" | "dark" {
  const read = (): "light" | "dark" => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const o = new MutationObserver(() => setTheme(read()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => o.disconnect();
  }, []);
  return theme;
}

export function ShellPageEditor({ store, pageID, readOnly, onOpenPage }: PageEditorProps) {
  const theme = useRootTheme();
  const renderDatabase = (p: DatabaseRenderProps) => {
    const View = slots.DatabaseView;
    return View ? <View store={store} blockID={p.blockID} databaseID={p.databaseID} readOnly={readOnly} onOpenPage={onOpenPage} /> : null;
  };
  return (
    <div className="shell-editor">
      <PageEditor store={store} pageID={pageID} editable={!readOnly} onOpenPage={onOpenPage} theme={theme} renderDatabase={renderDatabase} />
    </div>
  );
}
