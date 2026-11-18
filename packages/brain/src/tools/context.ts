// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Was die Werkzeug-Dateien vom Host bekommen: den Store und ein paar gemeinsame Helfer. `WorkspaceTools` baut das.
import type { Author, Block, BoardFileInfo, MarkdownExporter, MarkdownImporter, SearchFilters, WorkspaceStore } from "@based/core";
import type { AgentBrain } from "../agentbrain/store.js";
import type { Recall } from "../recall/recall.js";
import type { RelationGraph } from "../recall/graph.js";
import type { ToolResult } from "../engine.js";
import type { Databases } from "./databases.js";
import type { Args } from "./base.js";

export interface ToolCtx {
  readonly store: WorkspaceStore;
  readonly databases: Databases;
  /** Eine Seite (nicht im Papierkorb, außer `allowTrashed`), sonst ToolError. */
  page(id: string, allowTrashed?: boolean): Block;
  title(id: string): string;
  /** „- Titel (id: …)“ */
  line(id: string): string;
  importer(): MarkdownImporter;
  exporter(): MarkdownExporter;
  search(query: string, limit: number, filters?: SearchFilters): { pageID: string; snippet?: string | undefined }[];
  fileInfo(ref: string, known: BoardFileInfo | undefined): BoardFileInfo | undefined;
  graph(): RelationGraph;
  brain(): AgentBrain;
  recall(): Recall;
  /** Ein anderes Werkzeug derselben Schicht aufrufen (z. B. `upload_file` → `draw_board`). */
  callSync(name: string, input: Args, actor?: Author): ToolResult;
}
