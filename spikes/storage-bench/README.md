# storage-bench (ADR 0017)

Messskripte vom 17.11.2026 für `docs/adr/0017-storage-and-sync-efficiency.md`. Nicht Teil von Paketen, Lint oder CI.

```sh
mkdir -p /tmp/based-bench
cd apps/cli   # dort ist tsx installiert
# Seiten × Blöcke je Seite: erzeugt die Datei, misst Laden, Heap, Schreiben, Größe und Kompression
node --expose-gc --import tsx ../../spikes/storage-bench/bench.ts 20000 25
# SQLite-WASM (wie im Browser, ohne OPFS) gegen node:sqlite; braucht die Datei von oben
node --import tsx ../../spikes/storage-bench/wasm.mts
```

Die Browser-Zahlen im ADR stammen aus einem Playwright-Lauf mit dauerhaftem Profil:
`__based.client.command({ op: "seed", count })`, dann dreimal neu laden und die Zeit bis `data-ready` messen
(Muster: `apps/web/e2e/startup-perf.spec.ts`). Als fester Test mit Schwellen steht das im Backlog.
