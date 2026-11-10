// „Als PDF“: die Druckansicht einer Seite (eigenständiges HTML aus dem Exporter, mit Druck-Regeln) in einen
// unsichtbaren Rahmen laden und dessen `print()` rufen – der Druckdialog des Systems bietet „Als PDF sichern“.
// Derselbe Weg im Browser und in der Tauri-Hülle (kein Plugin). Der Rahmen bekommt nur `srcdoc`, lädt also nichts nach.

/** Lädt `html` in einen unsichtbaren Rahmen und öffnet den Druckdialog. Löst auf, sobald der Dialog angefordert ist. */
export function printHTML(html: string, title: string, doc: Document = document): Promise<void> {
  return new Promise((resolve, reject) => {
    doc.querySelectorAll("iframe[data-based-print]").forEach((f) => f.remove());
    const frame = doc.createElement("iframe");
    frame.setAttribute("data-based-print", "");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("title", title);
    frame.tabIndex = -1;
    // außerhalb des Bilds statt display:none – manche Browser drucken ausgeblendete Rahmen leer
    Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0", visibility: "hidden" });
    let done = false;
    const cleanup = () => setTimeout(() => frame.remove(), 1000);
    frame.addEventListener("load", () => {
      if (done) return;
      done = true;
      const win = frame.contentWindow;
      if (!win) {
        frame.remove();
        reject(new Error("Printing isn't available here."));
        return;
      }
      win.addEventListener("afterprint", cleanup);
      // Fallback, falls `afterprint` nicht kommt (ältere WebViews)
      setTimeout(() => frame.remove(), 10 * 60_000);
      // Bilder sind als data:-URLs eingebettet; einen Frame Zeit zum Dekodieren lassen
      setTimeout(() => {
        try {
          win.focus();
          win.print();
          resolve();
        } catch (e) {
          frame.remove();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }, 50);
    });
    frame.srcdoc = html;
    doc.body.appendChild(frame);
  });
}
