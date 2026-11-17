// BSD-138: das Bundle, das der Desktop-App als Resource beiliegt (keine eigene Node-Laufzeit; es läuft mit der Node
// des Nutzers, ≥ 22). Nur Weiterleitung, keine Logik (ADR 0011):
//   based-server.cjs cli …        die Kommandozeile `based` (der installierte Starter ruft das auf)
//   based-server.cjs desktop      Aufruf aus der App über das Shell-Plugin; was zu tun ist, steht in BASED_ACTION
//                                 (local | install-cli | uninstall-cli | cli-status), Werte in BASED_* – so bleibt der
//                                 erlaubte Befehl in der Capability fest (keine freien Argumente)
//   based-server.cjs …            based-server wie gewohnt (z. B. --local)
// Dynamische Importe: die CLI lädt den Server nicht mit.
// BSD-455: BASED_CHANNEL=beta (Based Beta) – eigener Port, eigene Discovery-Datei, eigener Befehl `based-beta`.
import { homedir } from "node:os";
import { desktopChannel, desktopPlaces } from "../../../packages/core/src/desktop-channel.js";

const argv = process.argv.slice(2);
const env = process.env;

async function desktop(): Promise<void> {
  const action = env.BASED_ACTION ?? "";
  const channel = desktopChannel(env.BASED_CHANNEL);
  if (action === "local") {
    const { main } = await import("../../server/src/main.js");
    await main(["--local", "--port", env.BASED_PORT ?? String(desktopPlaces(channel).port), "--db", env.BASED_DB ?? "local-server.sqlite", "--coding-root", env.BASED_CODING_ROOT ?? homedir()]);
    return;
  }
  const { defaultTarget, installStarter, starterStatus, uninstallStarter } = await import("../../cli/src/install.js");
  const target = env.BASED_TARGET || defaultTarget(homedir(), channel);
  let result: unknown;
  if (action === "install-cli") {
    result = installStarter({ target, node: process.execPath, nodeVersion: process.version, bundle: env.BASED_BUNDLE ?? process.argv[1] ?? "", path: env.PATH, channel });
  } else if (action === "uninstall-cli") result = uninstallStarter(target, channel);
  else if (action === "cli-status") result = { ok: true, ...starterStatus(target, channel), node: process.execPath, nodeVersion: process.version };
  else {
    result = { ok: false, message: `unknown action ${action}` };
    process.exitCode = 2;
  }
  process.stdout.write(`BASED_RESULT ${JSON.stringify(result)}\n`);
}

// BSD-424: Ein Startfehler war ein unbehandelter Promise-Fehler – Node druckt den Stacktrace und als letzte Zeile
// „Node.js v26.x“, und genau die zeigte die App an. Jetzt eine Zeile mit der Ursache (stdout für die Hülle, stderr fürs
// Protokoll) und Exit 1.
function fail(e: unknown): void {
  const message = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 500);
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  process.exitCode = 1;
  // erst beenden, wenn beide Zeilen draußen sind (Pipes sind auf macOS asynchron)
  process.stdout.write(`BASED_LOCAL_FAILED ${JSON.stringify({ message, ...(code ? { code } : {}) })}\n`, () =>
    process.stderr.write(`based-server: ${message}\n`, () => process.exit(1)));
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
})().catch(fail);
