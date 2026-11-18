// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Der Importer liegt im Kern (packages/core/src/interop/prepare-files.ts), damit die App, der Server und die
// Werkzeuge der Agenten denselben Weg gehen. Diese Datei hält die bisherigen Importpfade der App.
export {
  DRAIN_WINDOW_BYTES, DRAIN_WINDOW_FILES, drainDeferred, prepareFiles, StreamingAssetSink,
  type ImportFile, type ImportPayload, type PreparedArchive, type PrepareOptions, type StreamedAsset,
} from "@based/core";
