# Based

Native, local-first notes for **macOS and iPhone**: pages, a block editor and
databases, synced through your own iCloud. It's modeled on Notion's
note-taking features and built clean-room from public documentation.

> Work in progress. See [`replica/features.csv`](replica/features.csv) for the
> feature parity matrix and [`replica/build-log.md`](replica/build-log.md) for
> progress.

## Repository layout

- `Packages/BasedCore` — model, store, editing, databases, formulas,
  import/export, search, sync core (Swift package; tested on Linux and macOS)
- `App/` — SwiftUI app for macOS and iOS
- `replica/` — recon, architecture, parity matrix, build log

## Build (core)

```bash
swift test --package-path Packages/BasedCore
```

## License

MIT
