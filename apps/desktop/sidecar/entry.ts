// BSD-138: eine Beilage für zwei Rollen (spart eine zweite Node-Laufzeit im App-Paket):
//   based-server --local …   lokaler Server (Sidecar, startet das Web-Frontend über das Shell-Plugin)
//   based-server cli …       die Kommandozeile `based`; ebenso, wenn die Datei als `based` aufgerufen wird
//                            (der installierte Befehl ist ein Symlink hierher)
// Nur Weiterleitung, keine Logik (ADR 0011). Dynamische Importe: die CLI lädt den Server nicht mit.
import { basename } from "node:path";

const argv = process.argv.slice(2);
const asCli = /^based(\.exe)?$/i.test(basename(process.argv0)) || argv[0] === "cli";
void (async () => {
  if (asCli) {
    const { main } = await import("../../cli/src/main.js");
    process.exitCode = await main(argv[0] === "cli" ? argv.slice(1) : argv);
  } else {
    const { main } = await import("../../server/src/main.js");
    await main();
  }
})();
