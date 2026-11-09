// @based/database-ui – Datenbank-Ansichten für Based (BSD-155). Einhängen:
//   import { DatabaseView } from "@based/database-ui";
//   import "@based/database-ui/styles.css";
//   <DatabaseView store={store} databaseID={id} viewID={v} blockID={b} onOpenPage={(rowID) => …} />
export { DatabaseView } from "./DatabaseView.js";
export type { DatabaseViewProps } from "./DatabaseView.js";
export { ViewBody, useQuery } from "./ViewBody.js";
export { DBContext, useDatabaseContext, useDatabaseVersion, useDB } from "./context.js";
export type { DBContextValue } from "./context.js";
export { defaultIsAgentEdit } from "./logic/values.js";
