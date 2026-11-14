// Vorschau für HTML-Codeblöcke (beide Editoren): abgeschotteter Rahmen ohne Netz.
/** Kein Netz, keine Formulare nach außen; Skripte nur im abgeschotteten Rahmen. */
export const HTML_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/** Inhalt des Vorschau-Rahmens: CSP vorneweg, dann der Code. */
export function htmlPreviewDoc(code: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">${code}`;
}

/** Vorschau-Rahmen für HTML-Code: sandbox ohne allow-same-origin (eigene, undurchsichtige Origin), kein Referrer. */
export function htmlPreviewFrame(code: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "bx-html-preview-wrap";
  wrap.contentEditable = "false";
  const label = document.createElement("div");
  label.className = "bx-html-preview-label";
  label.textContent = "Preview";
  const frame = document.createElement("iframe");
  frame.className = "bx-html-preview";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", "HTML preview");
  frame.srcdoc = htmlPreviewDoc(code);
  wrap.append(label, frame);
  return wrap;
}
