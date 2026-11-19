#!/usr/bin/env bash
# BSD-548: Playwright-Browser für die CI holen – mit festem Zeitlimit je Teil, Wiederholung und klarer Meldung.
#   usage: ci/playwright-install.sh <browser>...      z. B.  ci/playwright-install.sh webkit
#
# Warum: Im vollen Lauf hingen WebKit-Shards im Schritt „playwright install --with-deps …“ (kein Testergebnis, der Job
# lief bis zum Zeitlimit oder wurde abgebrochen). Der Schritt war ein einziger Befehl ohne eigenes Zeitlimit.
# Hier getrennt:
#   1. Systempakete (apt): nur, wenn `install-deps --dry-run` fehlende Pakete meldet; man-db-Trigger aus (bremst apt
#      auf den GitHub-Runnern minutenlang); Zeitlimit PW_DEPS_TIMEOUT.
#   2. Browser-Download (aus dem Cache ~/.cache/ms-playwright meist sofort): Zeitlimit PW_DL_TIMEOUT.
#   18.11.: apt holt Pakete mit kurzen Timeouts und Wiederholungen (vorher hing der Download auf dem EC2-Mirror minutenlang
#   je Paket); das Zeitlimit für apt läuft als root (sudo timeout), sonst kann es `sudo apt-get` nicht beenden und `tee`
#   wartet bis zum Zeitlimit des Schritts.
#   Die .deb-Dateien landen in PW_APT_CACHE (Standard in der CI ~/.cache/apt-archives), den die Workflow-Vorlage per
#   actions/cache zwischen Läufen behält – auch halb fertige Downloads (partial/). Liefert der Mirror nur ~100 KB/s
#   (18.11.), installiert der nächste Lauf aus dem Cache statt 125 MB neu zu laden. Kam etwas Neues dazu, schreibt das
#   Skript apt-new=true nach GITHUB_OUTPUT (der Workflow speichert den Cache nur dann).
# Jeder Teil bis zu PW_TRIES Versuche. Hängt oder scheitert er endgültig, endet das Skript mit Exit 1 und einer
# ::error-Zeile, die den Teil, das Zeitlimit und den Grund nennt – der Job bleibt nicht offen.
# Ausgabe zusätzlich in pw-install.log (für „Log sichern“, wenn die Tests gar nicht erst starten).
#
# Umgebung: PW_DEPS_TIMEOUT (s, Standard 300), PW_DL_TIMEOUT (s, Standard 150), PW_TRIES (Standard 2),
#           PW_RETRY_PAUSE (s, Standard 10), PW_BIN (Standard: pnpm --filter @based/web exec playwright – für Tests).
#           Ungünstigster Fall 2 × 300 + 2 × 150 s + Pausen ≈ 15,3 min – darum timeout-minutes: 16 am Schritt.
set -uo pipefail
[ $# -gt 0 ] || { echo "usage: $0 <browser>..." >&2; exit 2; }
deps_to="${PW_DEPS_TIMEOUT:-300}"
dl_to="${PW_DL_TIMEOUT:-150}"
tries="${PW_TRIES:-2}"
pause="${PW_RETRY_PAUSE:-10}"
# pnpm --filter braucht den Repo-Ordner; das Log landet dort (CI: Arbeitsordner = Repo).
[ -n "${PW_BIN:-}" ] || cd "$(dirname "$0")/.." || exit 2
read -r -a pw <<< "${PW_BIN:-pnpm --filter @based/web exec playwright}"
log="${PW_INSTALL_LOG:-pw-install.log}"
: > "$log"

say() { echo "$*" | tee -a "$log"; }
as_root=() # Präfix für step(): leer = als aktueller Nutzer

# step <Name> <Zeitlimit in s> <Befehl…>: Wiederholung mit Zeitlimit; Exit 0 bei Erfolg, sonst 1 mit ::error.
step() {
  local name="$1" to="$2" i rc start why=""
  shift 2
  for ((i = 1; i <= tries; i++)); do
    start=$(date +%s)
    # timeout läuft in eigener Prozessgruppe und beendet auch Kindprozesse (apt unter sudo, Download).
    "${as_root[@]}" timeout --kill-after=20 "$to" "$@" 2>&1 | tee -a "$log"
    rc=${PIPESTATUS[0]}
    if [ "$rc" -eq 0 ]; then
      say "Playwright-Setup: $name fertig in $(( $(date +%s) - start )) s (Versuch $i/$tries)"
      return 0
    fi
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then why="hängt – nach ${to} s abgebrochen"; else why="Exit $rc"; fi
    say "::warning title=Playwright-Setup::$name: $why (Versuch $i/$tries)"
    [ "$i" -lt "$tries" ] && sleep $(( pause * i ))
  done
  say "::error title=Playwright-Setup (BSD-548)::$name für [$BROWSERS] nach $tries Versuchen gescheitert ($why). Kein Testergebnis – Runner-Image/apt/Netz prüfen, nicht die Tests."
  return 1
}

BROWSERS="$*"
say "Playwright-Setup für: $BROWSERS ($("${pw[@]}" --version 2>/dev/null || echo 'Version unbekannt'))"

# 1. Systempakete nur bei Bedarf
if "${pw[@]}" install-deps --dry-run "$@" 2>&1 | grep -q "All system dependencies are installed"; then
  say "Playwright-Setup: Systempakete schon vorhanden – apt übersprungen"
else
  if [ "${GITHUB_ACTIONS:-}" = true ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    # man-db baut nach jedem apt-Lauf den Index neu (auf ubuntu-24.04-Runnern oft Minuten) – für die CI unnötig
    sudo rm -f /var/lib/man-db/auto-update 2>/dev/null || true
    # Hängende Verbindungen nach 20 s abbrechen und neu versuchen, statt minutenlang auf ein Paket zu warten
    printf 'Acquire::http::Timeout "20";\nAcquire::https::Timeout "20";\nAcquire::Retries "5";\n' \
      | sudo tee /etc/apt/apt.conf.d/99based-ci >/dev/null || true
    # timeout als root, damit es apt-get (unter sudo) samt Kindern beenden kann
    as_root=(sudo -n -E env "PATH=$PATH")
    apt_cache="${PW_APT_CACHE:-$HOME/.cache/apt-archives}"
    mkdir -p "$apt_cache/partial"
    printf 'Dir::Cache::Archives "%s";\n' "$apt_cache" | sudo tee -a /etc/apt/apt.conf.d/99based-ci >/dev/null || true
    apt_before=$(find "$apt_cache" -type f -printf '%P %s\n' 2>/dev/null | sort | md5sum)
    say "Playwright-Setup: apt-Cache $apt_cache ($(find "$apt_cache" -maxdepth 1 -name '*.deb' | wc -l) Pakete)"
    # Auch wenn apt scheitert: Besitz zurück an den Runner (damit actions/cache speichern kann) und melden, ob sich
    # etwas geändert hat – halb fertige Downloads sind beim nächsten Lauf schon da.
    apt_done() {
      sudo chown -R "$(id -u):$(id -g)" "$apt_cache" 2>/dev/null || true
      local after
      after=$(find "$apt_cache" -type f -printf '%P %s\n' 2>/dev/null | sort | md5sum)
      [ -n "${GITHUB_OUTPUT:-}" ] && { [ "$after" != "$apt_before" ] && echo "apt-new=true" || echo "apt-new=false"; } >> "$GITHUB_OUTPUT"
    }
    trap apt_done EXIT
  fi
  export DEBIAN_FRONTEND=noninteractive
  step "Systempakete (apt)" "$deps_to" "${pw[@]}" install-deps "$@" || exit 1
  as_root=()
  if declare -F apt_done >/dev/null; then apt_done; trap - EXIT; fi
fi

# 2. Browser (Download oder Cache)
step "Browser-Download" "$dl_to" "${pw[@]}" install "$@" || exit 1
say "Playwright-Setup: bereit"
