// Dünner Zugang zum Agent Brain im Store-Worker (worker/brain.ts) über den vorhandenen StoreClient.
import type { MemoryKind, MemoryRecord, SemanticHit, SkillCorrection, SkillRecord, SkillRouting, ToolResult, ToolSpec } from "@based/brain";
import type { JSONValue } from "@based/core";
import type { BrainAction, BrainStatus, ResolvedCitation, SkillImportReport } from "../worker/brain.js";
import type { StoreClient } from "../worker/client.js";

export class BrainClient {
  constructor(private readonly client: Pick<StoreClient, "request">) {}

  private call<T>(action: BrainAction): Promise<T> {
    return this.client.request<T>({ type: "brain", action });
  }

  status() { return this.call<BrainStatus>({ op: "status" }); }
  ensure() { return this.call<{ root: string }>({ op: "ensure" }); }
  skills() { return this.call<SkillRecord[]>({ op: "skills" }); }
  saveSkill(name: string, description: string, body: string) { return this.call<{ id: string; created: boolean }>({ op: "saveSkill", name, description, body }); }
  setSkillEnabled(id: string, enabled: boolean) { return this.call<void>({ op: "setSkillEnabled", id, enabled }); }
  importSkills(files: { name: string; bytes: ArrayBuffer }[]) { return this.call<SkillImportReport>({ op: "importSkills", files }); }
  exportSkills(ids?: string[]) { return this.call<ArrayBuffer>(ids ? { op: "exportSkills", ids } : { op: "exportSkills" }); }
  route(query: string, corrections: SkillCorrection[]) { return this.call<SkillRouting>({ op: "route", query, corrections }); }
  skillsByID(ids: string[]) { return this.call<SkillRecord[]>({ op: "skillsByID", ids }); }
  memories() { return this.call<MemoryRecord[]>({ op: "memories" }); }
  saveMemory(m: { title: string; kind: MemoryKind; body: string; updates?: string | undefined }) {
    return this.call<string>(m.updates ? { op: "saveMemory", title: m.title, kind: m.kind, body: m.body, updates: m.updates } : { op: "saveMemory", title: m.title, kind: m.kind, body: m.body });
  }
  personNames() { return this.call<string[]>({ op: "personNames" }); }
  resolveCitations(markers: { kind: "block" | "page"; id: string }[]) { return this.call<Record<string, ResolvedCitation | null>>({ op: "resolveCitations", markers }); }
  related(pageID: string, limit?: number) { return this.call<(SemanticHit & { title: string })[]>(limit ? { op: "related", pageID, limit } : { op: "related", pageID }); }
  toolSpecs() { return this.call<ToolSpec[]>({ op: "toolSpecs" }); }
  tool(name: string, input: JSONValue) { return this.call<ToolResult>({ op: "tool", name, input }); }
}
