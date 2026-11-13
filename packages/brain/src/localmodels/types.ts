// BSD-231/BSD-399: Typen der lokalen Modelle (eigene Datei, damit catalog.ts und index.ts keinen Import-Zyklus bilden).

export type LocalModelPurpose = "transcription" | "embeddings" | "redact";

export interface LocalModelFile {
  /** Pfad im Modell-Speicher (relativ, ohne ..). */
  path: string;
  /** Feste Quelle (https). Leer = vom eigenen based-server (`<server>/models/<modell>/<pfad>`). */
  url?: string;
  size: number;
  sha256: string;
}

export interface LocalModelSpec {
  id: string;
  purpose: LocalModelPurpose;
  name: string;
  version: string;
  license: string;
  files: readonly LocalModelFile[];
}
