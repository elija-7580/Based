// BSD-138: das Bundle, das der Desktop-App als Resource beiliegt (keine eigene Node-Laufzeit; es läuft mit der Node
// des Nutzers, ≥ 22). Nur Weiterleitung, keine Logik (ADR 0011):
//   based-server.cjs cli …        die Kommandozeile `based` (der installierte Starter ruft das auf)
//   based-server.cjs desktop      Aufruf aus der App über das Shell-Plugin; was zu tun ist, steht in BASED_ACTION
//                                 (local | install-cli | uninstall-cli | cli-status), Werte in BASED_* – so bleibt der
//                                 erlaubte Befehl in der Capability fest (keine freien Argumente)
//   based-server.cjs …            based-server wie gewohnt (z. B. --local)
// Dynamische Importe: die CLI lädt den Server nicht mit.
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const env = process.env;

async function desktop(): Promise<void> {
  const action = env.BASED_ACTION ?? "";
  if (action === "local") {
    const { main } = await import("../../server/src/main.js");
    await main(["--local", "--port", env.BASED_PORT ?? "47821", "--db", env.BASED_DB ?? "local-server.sqlite", "--coding-root", env.BASED_CODING_ROOT ?? homedir()]);
    return;
  }
  const { defaultTarget, installStarter, starterStatus, uninstallStarter } = await import("../../cli/src/install.js");
  const target = env.BASED_TARGET || defaultTarget(homedir());
  let result: unknown;
  if (action === "install-cli") {
    result = installStarter({ target, node: process.execPath, nodeVersion: process.version, bundle: env.BASED_BUNDLE ?? process.argv[1] ?? "", path: env.PATH });
  } else if (action === "uninstall-cli") result = uninstallStarter(target);
  else if (action === "cli-status") result = { ok: true, ...starterStatus(target), node: process.execPath, nodeVersion: process.version };
  else {
    result = { ok: false, message: `unknown action ${action}` };
    process.exitCode = 2;
  }
  process.stdout.write(`BASED_RESULT ${JSON.stringify(result)}\n`);
}

void (async () => {
  if (argv[0] === "cli") {
    const { main } = await import("../../cli/src/main.js");
    process.exitCode = await main(argv.slice(1));
  } else if (argv[0] === "desktop") {
    await desktop();
  } else {
    const { main } = await import("../../server/src/main.js");
    await main(argv);
  }
})();
