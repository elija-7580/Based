// Formular-Ansicht (Notion „Forms“) aus Astryx-Formkomponenten. Zwei Modi: „Edit form“ (Fragen aus den Properties
// ein-/ausblenden, ordnen, Pflicht, Hilfetext, Titel/Beschreibung) und „Fill out“ (ausfüllen, absenden → neue Zeile).
// Logik und Speicherformat: @based/database-ui logic/form.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { DateInput } from "@astryxdesign/core/DateInput";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { PROPERTY_TYPE_LABELS, movePropertyInView, setPropertyVisible, visiblePropertyIDs } from "@based/core";
import {
  formDescription, formQuestions, formTitle, hiddenFormProperties, setFormDescription, setFormTitle, setQuestionDescription,
  setQuestionRequired, submitForm, validateAnswer, type FormAnswer, type FormAnswers, type FormQuestion, type FormRenderProps, type PlaceAnswer,
} from "@based/database-ui";
import { Icon } from "../icons.js";
import "./form.css";

/** Eingabe, die lokal tippt und an den Store schreibt (ohne dass Store-Echos den Cursor springen lassen). */
function useLocalText(stored: string, key: string): [string, (v: string) => void, () => void] {
  const [value, setValue] = useState(stored);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setValue(stored); }, [stored, key]);
  return [value, (v) => { editing.current = true; setValue(v); }, () => { editing.current = false; }];
}

function EditQuestion({ p, q, index, count, prev }: { p: FormRenderProps; q: FormQuestion; index: number; count: number; prev: (dir: -1 | 1) => number }) {
  const [desc, setDesc, doneDesc] = useLocalText(q.description, q.prop.id);
  const name = q.prop.name;
  return (
    <section className="db-form-question" aria-label={`Question ${name}`} data-testid="form-question">
      <HStack gap={2}>
        <span className="db-form-qtitle"><Text type="label">{name}</Text> <Text type="supporting">{PROPERTY_TYPE_LABELS[q.prop.type] ?? q.prop.type}</Text></span>
        <IconButton label={`Move ${name} up`} variant="ghost" size="sm" icon={<Icon name="up" size={16} />} isDisabled={index === 0} onClick={() => movePropertyInView(p.store, p.view.id, q.prop.id, prev(-1))} />
        <IconButton label={`Move ${name} down`} variant="ghost" size="sm" icon={<Icon name="down" size={16} />} isDisabled={index === count - 1} onClick={() => movePropertyInView(p.store, p.view.id, q.prop.id, prev(1))} />
        {q.prop.type !== "title" && <Button label={`Remove ${name}`} variant="ghost" size="sm" onClick={() => setPropertyVisible(p.store, p.view.id, q.prop.id, false)}>Remove</Button>}
      </HStack>
      <TextInput label="Help text" size="sm" width="100%" placeholder="Add a description for this question" value={desc} onChange={(v) => { setDesc(v); setQuestionDescription(p.store, p.view.id, q.prop.id, v); }} onKeyDown={(e) => { if (e.key === "Enter") doneDesc(); }} />
      <Switch label="Required" size="sm" value={q.required} onChange={(on) => setQuestionRequired(p.store, p.view.id, q.prop.id, on)} />
    </section>
  );
}

function Editor({ p }: { p: FormRenderProps }) {
  const questions = formQuestions(p.view, p.db);
  const [title, setTitle] = useLocalText(formTitle(p.view), p.view.id);
  const [desc, setDesc] = useLocalText(formDescription(p.view, p.db), p.view.id);
  const hidden = hiddenFormProperties(p.view, p.db);
  const visible = visiblePropertyIDs(p.view, p.db);
  return (
    <VStack gap={4}>
      <TextInput label="Form title" width="100%" value={title} onChange={(v) => { setTitle(v); setFormTitle(p.store, p.view.id, v); }} />
      <TextArea label="Form description" width="100%" rows={2} value={desc} onChange={(v) => { setDesc(v); setFormDescription(p.store, p.view.id, v); }} />
      {questions.map((q, i) => (
        <EditQuestion key={q.prop.id} p={p} q={q} index={i} count={questions.length}
          prev={(dir) => visible.indexOf(questions[i + dir]!.prop.id)} />
      ))}
      {hidden.length > 0 && (
        <Selector label="Add a question" placeholder="Choose a property" value="" width="100%"
          options={hidden.map((x) => ({ value: x.id, label: `${x.name} (${PROPERTY_TYPE_LABELS[x.type] ?? x.type})` }))}
          onChange={(id) => id && setPropertyVisible(p.store, p.view.id, id, true)} />
      )}
    </VStack>
  );
}

function PlaceField({ q, value, onChange, error }: { q: FormQuestion; value: PlaceAnswer; onChange: (v: PlaceAnswer) => void; error: string | undefined }) {
  const set = (k: keyof PlaceAnswer) => (v: string) => onChange({ ...value, [k]: v });
  return (
    <fieldset className="db-form-place" aria-label={q.prop.name}>
      <legend><Text type="label">{q.prop.name}{q.required ? " *" : ""}</Text></legend>
      {q.description && <Text type="supporting" display="block">{q.description}</Text>}
      <TextInput label="Name" size="sm" width="100%" value={value.name ?? ""} onChange={set("name")} />
      <TextInput label="Address" size="sm" width="100%" value={value.address ?? ""} onChange={set("address")} />
      <HStack gap={2}>
        <TextInput label="Latitude" size="sm" inputMode="decimal" placeholder="48.2082" value={value.lat ?? ""} onChange={set("lat")} />
        <TextInput label="Longitude" size="sm" inputMode="decimal" placeholder="16.3738" value={value.lon ?? ""} onChange={set("lon")} />
      </HStack>
      {error && <span role="alert" className="t-desc">{error}</span>}
    </fieldset>
  );
}

function Field({ q, value, onChange, error }: { q: FormQuestion; value: FormAnswer | undefined; onChange: (v: FormAnswer) => void; error: string | undefined }) {
  const { prop } = q;
  const common = { label: prop.name, width: "100%", isRequired: q.required, ...(q.description ? { description: q.description } : {}), ...(error ? { status: { type: "error" as const, message: error } } : {}) };
  const text = typeof value === "string" ? value : "";
  switch (prop.type) {
    case "text": return <TextArea {...common} rows={3} value={text} onChange={onChange} />;
    case "number": return <TextInput {...common} inputMode="decimal" value={text} onChange={onChange} />;
    case "email": return <TextInput {...common} type="email" value={text} onChange={onChange} />;
    case "url": return <TextInput {...common} type="url" value={text} onChange={onChange} />;
    case "phone": return <TextInput {...common} type="tel" value={text} onChange={onChange} />;
    case "select": case "status":
      return <Selector {...common} placeholder="Choose an option" value={text} hasClear onChange={(v) => onChange(v ?? "")}
        options={(prop.options ?? []).map((o) => ({ value: o.id, label: o.name }))} />;
    case "multiSelect":
      return (
        <CheckboxList {...common} value={Array.isArray(value) ? value : []} onChange={onChange}>
          {(prop.options ?? []).map((o) => <CheckboxListItem key={o.id} value={o.id} label={o.name} />)}
        </CheckboxList>
      );
    case "checkbox": return <CheckboxInput {...common} value={value === true} onChange={onChange} />;
    case "date": return <DateInput {...common} value={(text || undefined) as never} hasClear onChange={(v) => onChange(v ?? "")} />;
    case "place": return <PlaceField q={q} value={typeof value === "object" && !Array.isArray(value) ? value : {}} onChange={onChange} error={error} />;
    default: return <TextInput {...common} value={text} onChange={onChange} />;
  }
}

function Filler({ p }: { p: FormRenderProps }) {
  const questions = useMemo(() => formQuestions(p.view, p.db), [p.view, p.db]);
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(0);
  const set = (q: FormQuestion) => (v: FormAnswer) => {
    setAnswers((a) => ({ ...a, [q.prop.id]: v }));
    // Fehler verschwindet, sobald die Antwort passt (geprüft wird erst beim Absenden).
    if (errors[q.prop.id] && !validateAnswer(q, v)) setErrors((e) => { const n = { ...e }; delete n[q.prop.id]; return n; });
  };
  const submit = () => {
    const r = submitForm(p.store, p.view, answers);
    if (!r.ok) { setErrors(r.errors); return; }
    setErrors({});
    setAnswers({});
    setSubmitted((n) => n + 1);
  };
  const description = formDescription(p.view, p.db);
  return (
    <form className="db-form-fill" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}>
      <VStack gap={5}>
        <VStack gap={1}>
          <Heading level={2}>{formTitle(p.view)}</Heading>
          {description && <Text type="supporting" display="block">{description}</Text>}
        </VStack>
        {submitted > 0 && (
          <Banner status="success" title={submitted === 1 ? "Response submitted" : `${submitted} responses submitted`} description="A new page was added to the database." isDismissable onDismiss={() => setSubmitted(0)} />
        )}
        {errors[""] && <Banner status="error" title={errors[""]} />}
        <FormLayout>
          {questions.map((q) => <Field key={`${q.prop.id}:${submitted}`} q={q} value={answers[q.prop.id]} onChange={set(q)} error={errors[q.prop.id]} />)}
        </FormLayout>
        <HStack gap={3}>
          <Button label="Submit" variant="primary" type="submit" isDisabled={p.locked} tooltip="Submit (⌘↩)" />
          <Text type="supporting" hasTabularNumbers>{p.responses.toLocaleString("en-US")} {p.responses === 1 ? "response" : "responses"}</Text>
        </HStack>
      </VStack>
    </form>
  );
}

export function FormView(p: FormRenderProps) {
  const [mode, setMode] = useState<"edit" | "fill">(p.locked ? "fill" : "edit");
  const shown = p.locked ? "fill" : mode;
  return (
    <div className="db-form-scroll">
    <div className="db-form" data-testid="form-view" data-mode={shown}>
      {!p.locked && (
        <SegmentedControl label="Form mode" size="sm" value={shown} onChange={(v) => setMode(v === "fill" ? "fill" : "edit")}>
          <SegmentedControlItem value="edit" label="Edit form" />
          <SegmentedControlItem value="fill" label="Fill out" />
        </SegmentedControl>
      )}
      {shown === "edit" ? <Editor p={p} /> : <Filler p={p} />}
    </div>
    </div>
  );
}
