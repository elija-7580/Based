// Wohin der Befehl verbindet und mit welchem Token (Swift `CLIConfig`). Reihenfolge: --url / BASED_URL / Datei;
// Token: BASED_TOKEN / --token-file / BASED_TOKEN_FILE / Datei. Dateien, die andere lesen dürfen, werden abgelehnt.
import { CLIError, type CLIOptions } from "./args.js";

export interface CLIConfig {
  url: string;
  token: string;
  /** Woher der Token kam (für `based config`; nie der Token selbst). */
  tokenSource: string;
}

export interface ConfigIO {
  env: Record<string, string | undefined>;
  home: string;
  readFile: (path: string) => string | undefined;
  /** POSIX-Rechte (undefined = unbekannt). */
  fileMode?: (path: string) => number | undefined;
}

export const configPath = (home: string) => `${home}/.config/based/config.json`;

const nonEmpty = (s: string | undefined) => {
  const t = s?.trim();
  return t ? t : undefined;
};

/** Nur https, außer für den eigenen Rechner (sonst ginge der Token unverschlüsselt). */
export function checkURL(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new CLIError(`Not a URL: ${url}`);
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new CLIError("Use https:// (plain http only for localhost) — the token would travel unencrypted.");
  }
  return url.replace(/\/+$/, "");
}

export function resolveConfig(options: CLIOptions, io: ConfigIO): CLIConfig {
  const cfgPath = configPath(io.home);
  let fileURL: string | undefined, fileToken: string | undefined;
  const raw = io.readFile(cfgPath);
  if (raw !== undefined) {
    try {
      const v = JSON.parse(raw) as { url?: unknown; token?: unknown };
      fileURL = typeof v.url === "string" ? v.url : undefined;
      fileToken = typeof v.token === "string" ? v.token : undefined;
    } catch {
      throw new CLIError(`${cfgPath} is not valid JSON`);
    }
  }
  const url = nonEmpty(options.url) ?? nonEmpty(io.env.BASED_URL) ?? nonEmpty(fileURL);
  if (!url) throw new CLIError("No server configured. Run `based login --url <https://your-server>` or set BASED_URL.");
  const checked = checkURL(url);
  const private_ = (p: string) => {
    const m = io.fileMode?.(p);
    if (m !== undefined && (m & 0o077) !== 0) throw new CLIError(`${p} is readable by others (chmod 600 ${p})`);
  };
  const envToken = nonEmpty(io.env.BASED_TOKEN);
  if (envToken) return { url: checked, token: envToken, tokenSource: "BASED_TOKEN" };
  const tokenFile = nonEmpty(options.tokenFile) ?? nonEmpty(io.env.BASED_TOKEN_FILE);
  if (tokenFile) {
    private_(tokenFile);
    const t = nonEmpty(io.readFile(tokenFile));
    if (!t) throw new CLIError(`Token file ${tokenFile} is missing or empty`);
    return { url: checked, token: t, tokenSource: `file ${tokenFile}` };
  }
  const t = nonEmpty(fileToken);
  if (t) {
    private_(cfgPath);
    return { url: checked, token: t, tokenSource: cfgPath };
  }
  throw new CLIError("No token. Set BASED_TOKEN, use --token-file, or run `based login`.");
}

export const configFileContents = (url: string, token: string) => JSON.stringify({ url, token }) + "\n";
