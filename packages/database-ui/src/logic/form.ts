// Formular-Ansicht (Notion „Forms“): Fragen aus den Properties der Ansicht, Ausfüllen, Prüfen pro Property-Typ,
// Absenden legt eine Zeile an. Rein, ohne React; die Oberfläche (Astryx) liegt in der Shell.
//
// Speicher: welche Properties gefragt werden und in welcher Reihenfolge, steht wie bei allen Ansichten in
// `view.properties` (sichtbar/Reihenfolge). Titel, Beschreibung, Pflichtfeld und Hilfetext liegen in `view.form` –
// ein Feld, das die Swift-App nicht kennt und dank „loose“-Schema unverändert mitschreibt (ADR 0002). Kein Feld ist
// Pflicht: ohne `view.form` gilt der Name der Ansicht als Titel und die Beschreibung der Datenbank.
import {
  addRow, plainText, propertyOf, pv, updateView, visiblePropertyIDs, values,
  type Database, type DatabaseView, type PropertySchema, type PropertyValue, type WorkspaceStore,
} from "@based/core";
import { coordinateError, encodePlace, parseCoordinate } from "./place.js";

/** Typen, die ein Formular abfragen kann (wie Swift FormLayout.supported). */
export const FORM_TYPES: ReadonlySet<string> = new Set(["title", "text", "number", "select", "multiSelect", "status", "date", "checkbox", "url", "email", "phone", "place"]);

export interface FormQuestionConfig {
  required?: boolean;
  description?: string;
}

export interface FormConfig {
  title?: string;
  description?: string;
  questions?: Record<string, FormQuestionConfig>;
}

export interface FormQuestion {
  prop: PropertySchema;
  required: boolean;
  description: string;
}

export interface PlaceAnswer { name?: string; address?: string; lat?: string; lon?: string }
/** Antwort je Property-Typ: Text (auch Zahl, Datum „YYYY-MM-DD[THH:MM]“, Option-ID), Liste (Multi-Select), Haken, Ort. */
export type FormAnswer = string | string[] | boolean | PlaceAnswer;
export type FormAnswers = Record<string, FormAnswer | undefined>;

export function formConfig(view: DatabaseView): FormConfig {
  const f = (view as { form?: unknown }).form;
  return f && typeof f === "object" && !Array.isArray(f) ? (f as FormConfig) : {};
}

export function formTitle(view: DatabaseView): string {
  const t = formConfig(view).title;
  return typeof t === "string" && t.trim() ? t : view.name;
}

export function formDescription(view: DatabaseView, db: Database): string {
  const d = formConfig(view).description;
  return typeof d === "string" ? d : db.summary !== undefined ? plainText(db.summary) : "";
}

/** Fragen in Anzeigereihenfolge. Der Titel ist standardmäßig Pflicht (wie in Swift), alles andere optional. */
export function formQuestions(view: DatabaseView, db: Database): FormQuestion[] {
  const cfg = formConfig(view).questions ?? {};
  return visiblePropertyIDs(view, db).flatMap((id) => {
    const prop = propertyOf(db, id);
    if (!prop || !FORM_TYPES.has(prop.type)) return [];
    const q = cfg[id] ?? {};
    return [{ prop, required: typeof q.required === "boolean" ? q.required : prop.type === "title", description: typeof q.description === "string" ? q.description : prop.description ?? "" }];
  });
}

/** Properties, die man als Frage hinzufügen kann (unterstützt, noch nicht sichtbar). */
export function hiddenFormProperties(view: DatabaseView, db: Database): PropertySchema[] {
  const shown = new Set(visiblePropertyIDs(view, db));
  return db.properties.filter((p) => FORM_TYPES.has(p.type) && !shown.has(p.id));
}

// MARK: Einstellungen (je ein Undo-Schritt)

function patchForm(store: WorkspaceStore, viewID: string, name: string, f: (c: FormConfig) => void) {
  updateView(store, viewID, (v) => {
    const cfg: FormConfig = structuredClone(formConfig(v));
    f(cfg);
    if (cfg.questions && Object.keys(cfg.questions).length === 0) delete cfg.questions;
    if (Object.keys(cfg).length === 0) delete (v as { form?: unknown }).form;
    else (v as { form?: unknown }).form = cfg;
  }, name, `form:${viewID}:${name}`);
}

export const setFormTitle = (store: WorkspaceStore, viewID: string, title: string) =>
  patchForm(store, viewID, "Form title", (c) => { if (title.trim()) c.title = title; else delete c.title; });

export const setFormDescription = (store: WorkspaceStore, viewID: string, description: string | undefined) =>
  patchForm(store, viewID, "Form description", (c) => { if (description === undefined) delete c.description; else c.description = description; });

function patchQuestion(store: WorkspaceStore, viewID: string, propID: string, name: string, f: (q: FormQuestionConfig) => void) {
  patchForm(store, viewID, name, (c) => {
    const qs = { ...(c.questions ?? {}) };
    const q = { ...(qs[propID] ?? {}) };
    f(q);
    if (Object.keys(q).length === 0) delete qs[propID];
    else qs[propID] = q;
    c.questions = qs;
  });
}

export const setQuestionRequired = (store: WorkspaceStore, viewID: string, propID: string, required: boolean) =>
  patchQuestion(store, viewID, propID, "Required", (q) => { q.required = required; });

export const setQuestionDescription = (store: WorkspaceStore, viewID: string, propID: string, description: string) =>
  patchQuestion(store, viewID, propID, "Question description", (q) => { if (description.trim()) q.description = description; else delete q.description; });

// MARK: Prüfen

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^\s/$.?#]+\.[^\s]+$/i;
const PHONE = /^\+?[0-9 ()./-]{3,}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

const str = (a: FormAnswer | undefined) => (typeof a === "string" ? a.trim() : "");

export function isBlank(a: FormAnswer | undefined): boolean {
  if (a === undefined || a === false) return true;
  if (typeof a === "string") return a.trim() === "";
  if (Array.isArray(a)) return a.length === 0;
  if (typeof a === "object") return !["name", "address", "lat", "lon"].some((k) => (a as Record<string, string | undefined>)[k]?.trim());
  return false;
}

/** Datum aus „YYYY-MM-DD“ oder „YYYY-MM-DDTHH:MM“ (lokale Zeit) → Swift-Sekunden; `undefined` wenn ungültig. */
export function parseFormDate(s: string): { start: number; includeTime: boolean } | undefined {
  const m = DATE.exec(s.trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)];
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || h > 23 || mi > 59) return undefined;
  return { start: values.fromJSDate(date), includeTime: m[4] !== undefined };
}

/** Fehlermeldung für eine Antwort, sonst `undefined`. */
export function validateAnswer(q: FormQuestion, a: FormAnswer | undefined): string | undefined {
  const { prop } = q;
  if (isBlank(a)) return q.required ? (prop.type === "checkbox" ? "Check this box to continue" : "This question is required") : undefined;
  switch (prop.type) {
    case "number": {
      const n = Number(str(a).replace(/[\s,]/g, ""));
      return Number.isFinite(n) ? undefined : "Enter a number";
    }
    case "email": return EMAIL.test(str(a)) ? undefined : "Enter an email address";
    case "url": return URL_LIKE.test(str(a)) ? undefined : "Enter a link";
    case "phone": return PHONE.test(str(a)) && /\d/.test(str(a)) ? undefined : "Enter a phone number";
    case "date": return parseFormDate(str(a)) ? undefined : "Enter a valid date";
    case "select": case "status": return prop.options?.some((o) => o.id === str(a)) ? undefined : "Choose an option";
    case "multiSelect": {
      const ids = Array.isArray(a) ? a : [];
      return ids.every((id) => prop.options?.some((o) => o.id === id)) ? undefined : "Choose from the options";
    }
    case "place": {
      const p = (typeof a === "object" && !Array.isArray(a) ? a : {}) as PlaceAnswer;
      return coordinateError(p.lat, p.lon);
    }
    default: return undefined;
  }
}

export function validateForm(questions: readonly FormQuestion[], answers: FormAnswers): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const q of questions) {
    const e = validateAnswer(q, answers[q.prop.id]);
    if (e) errors[q.prop.id] = e;
  }
  return errors;
}

/** Ort wie Swift `PlaceValue.raw`: ohne Koordinaten und Adresse nur der Name, sonst JSON mit sortierten Schlüsseln. */
export function placeRaw(p: PlaceAnswer): string | undefined {
  const lat = parseCoordinate(p.lat), lon = parseCoordinate(p.lon);
  const ok = lat !== undefined && lon !== undefined && !Number.isNaN(lat) && !Number.isNaN(lon);
  return encodePlace({ ...(p.name ? { name: p.name } : {}), ...(p.address ? { address: p.address } : {}), ...(ok ? { lat, lon } : {}) });
}

/** Antworten → Titel und Werte einer neuen Zeile (nur gültige, nicht-leere Antworten). */
export function answersToRow(questions: readonly FormQuestion[], answers: FormAnswers): { title: string; values: Record<string, PropertyValue> } {
  let title = "";
  const out: Record<string, PropertyValue> = {};
  for (const q of questions) {
    const a = answers[q.prop.id], p = q.prop;
    if (isBlank(a) || validateAnswer({ ...q, required: false }, a)) continue;
    switch (p.type) {
      case "title": title = str(a); break;
      case "text": out[p.id] = pv("text", (a as string).replace(/^\s+|\s+$/g, "")); break;
      case "number": out[p.id] = pv("number", Number(str(a).replace(/[\s,]/g, ""))); break;
      case "url": case "email": case "phone": out[p.id] = pv(p.type, str(a)); break;
      case "select": case "status": out[p.id] = pv(p.type, str(a)); break;
      case "multiSelect": out[p.id] = pv("multiSelect", [...new Set(a as string[])]); break;
      case "checkbox": out[p.id] = pv("checkbox", true); break;
      case "date": out[p.id] = pv("date", parseFormDate(str(a))!); break;
      case "place": { const raw = placeRaw(a as PlaceAnswer); if (raw) out[p.id] = pv("place", raw); break; }
    }
  }
  return { title, values: out };
}

export type SubmitResult = { ok: true; rowID: string } | { ok: false; errors: Record<string, string> };

/** Formular absenden: prüfen, dann eine Zeile anlegen (ein Undo-Schritt). */
export function submitForm(store: WorkspaceStore, view: DatabaseView, answers: FormAnswers): SubmitResult {
  const db = store.databases.get(view.databaseID);
  if (!db || db.locked) return { ok: false, errors: { "": "This database is locked" } };
  const questions = formQuestions(view, db);
  const errors = validateForm(questions, answers);
  if (Object.keys(errors).length) return { ok: false, errors };
  const { title, values: vals } = answersToRow(questions, answers);
  const rowID = addRow(store, db.id, { ...(title ? { title } : {}), values: vals });
  return rowID ? { ok: true, rowID } : { ok: false, errors: { "": "Couldn’t save the response" } };
}
