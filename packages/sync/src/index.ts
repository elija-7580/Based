// @based/sync – lokaler Speicher (SQLite, gleiches Format wie die Swift-App) und Sync-v2-Client
// (docs/sync-protocol.md). Treiber: `@based/sync/node` (node:sqlite) und `@based/sync/wasm` (Browser-Worker, OPFS).
import { CORE_VERSION } from "@based/core";

export const SYNC_PROTOCOL_VERSION = 2;
export const coreVersion = CORE_VERSION;

export * from "./sql.js";
export { CURRENT_SCHEMA_VERSION, MIGRATIONS, PersistenceError, migrate, schemaVersion } from "./migrations.js";
export type { Migration } from "./migrations.js";
export { SqlitePersistence, decodeStamp, deviceNodeID, encodeStamp, openWorkspace, resolveNode } from "./persistence.js";
export type { ChangeEntry, DeviceNodeStore, NodeResolution, UndecodableRow } from "./persistence.js";
export { PULLED_KEY, PUSHED_KEY, SyncClient, SyncHTTPError, decodeDeletions, decodeRecords } from "./client.js";
export type { SyncClientOptions, SyncLog, SyncRoundResult, WireDeletion } from "./client.js";
// BSD-73: Versionsverlauf in einer eigenen Datei (history.sqlite, Format wie Swift)
export { HISTORY_SCHEMA, SqliteHistoryStorage } from "./history.js";
// BSD-78: Dateien als inhaltsadressierte Blobs über den Server-Sync
export { ASSET_HASH, ASSET_QUEUE_KEY, AssetError, AssetSync, DEFAULT_ASSET_CHUNK, MemoryAssetBlobStore, isAssetHash, mimeForName, sha256Hex } from "./assets.js";
export type { AssetBlobStore, AssetErrorCode, AssetMetaStore, AssetServer, AssetSyncOptions, AssetSyncStatus, QueuedUpload, StoredAsset } from "./assets.js";
