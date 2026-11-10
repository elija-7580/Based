// @based/database-ui – Datenbank-Ansichten für Based (BSD-155). Einhängen:
//   import { DatabaseView } from "@based/database-ui";
//   import "@based/database-ui/styles.css";
//   <DatabaseView store={store} databaseID={id} viewID={v} blockID={b} onOpenPage={(rowID) => …} />
export { DatabaseView } from "./DatabaseView.js";
export type { DatabaseViewProps, PeekOptions, PeekRenderProps } from "./DatabaseView.js";
export { RowProperties } from "./RowProperties.js";
export { OPEN_MODE_LABELS, openModeOf, parsePeek, peekPosition, peekShortcut, restorePeek, rowOrder, serializePeek } from "./logic/peek.js";
export type { OpenMode, PeekPosition, PeekState } from "./logic/peek.js";
export { ViewBody, useQuery } from "./ViewBody.js";
export { DBContext, ShellSlots, useDatabaseContext, useDatabaseVersion, useDB } from "./context.js";
export type { DBContextValue, FileHost, FormRenderProps, RowActions } from "./context.js";
export {
  FORM_TYPES, answersToRow, formConfig, formDescription, formQuestions, formTitle, hiddenFormProperties, isBlank, parseFormDate, placeRaw,
  setFormDescription, setFormTitle, setQuestionDescription, setQuestionRequired, submitForm, validateAnswer, validateForm,
} from "./logic/form.js";
export type { FormAnswer, FormAnswers, FormConfig, FormQuestion, FormQuestionConfig, PlaceAnswer, SubmitResult } from "./logic/form.js";
export { defaultIsAgentEdit } from "./logic/values.js";
