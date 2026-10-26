// @ts-check
// module: which writer runs are a person's requests for tickets and which are the board's own runs for its After-merge checks (A11-302) -- PURE
import type { WriterMode, WriterRun } from "./queue-entries-and-outcomes.ts";

/** The modes of the board's own runs for its After-merge checks (`after-merge/verify.ts`): they file no ticket. */
export type CheckRunMode = Extract<WriterMode, "verify" | "migrate">;

/** The mode of a run that files tickets for a person's request: the modes that are not the board's own check runs. */
export type TicketWriterMode = Exclude<WriterMode, CheckRunMode>;

/** A writer run that files tickets for a person's request, as the Runs page lists it. */
export type TicketWriterRun = WriterRun & Readonly<{ mode: TicketWriterMode }>;

/** Whether a writer run is a person's request for tickets, and not one of the board's own check runs. PURE. */
export const isTicketWriter = (run: WriterRun): run is TicketWriterRun => run.mode === "quick" || run.mode === "grill";
