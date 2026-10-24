// module: the data the New ticket checks share -- a new-ticket request in each of its five states as `/api/writer` answers it, and an instance that writes tickets
import { queueingConfig, ticket, type InstanceAnswers } from "../../test/fixtures.ts";
import type { ConfigView, TicketView, WritersView } from "../api/types.ts";
import { answers, BACKLOG } from "../tickets/tickets-harness.tsx";

export type Run = WritersView["runs"][number];

/** The request the boards quote. */
export const REQUEST = "Add a retry button to the unreachable banner, and have it re-check every 10 seconds while the page is open.";

/** The ticket the Done board lists, as the board reads it back from the tracker. */
export const FILED = { key: "A11-143", url: "https://tracker.example/A11-143", inPick: true, title: "The unreachable banner offers Retry and re-checks every 10 seconds while the page is open", priority: 3, project: "a11ign" };

/** A new-ticket request, as `GET /api/writer` lists it; `fields` change what the state below it gives. */
export const writerRun = (fields: Partial<Run> = {}): Run => ({ id: "w1", request: REQUEST, mode: "quick", placement: "auto", phase: "running", status: "writing", form: {}, model: "sonnet", effort: "high", tickets: [], ...fields }) as Run;

/** The request in each state the strip draws, with the real strings of the backend where the boards have example text. */
export const STAGES = {
  queued: writerRun({ phase: "queued", status: "queued" }),
  writing: writerRun({ workspace: "w1", pane: "p1" }),
  waiting: writerRun({ mode: "grill", workspace: "w1", pane: "p1", status: "waiting", waiting: { question: "Which repository does the banner live in?", since: 1 } }),
  done: writerRun({ phase: "finished", status: "done", tickets: [FILED] }),
  failed: writerRun({ phase: "finished", status: "failed", failure: "the writer ended its turn without creating a ticket" }),
} as const;

export type Stage = keyof typeof STAGES;

/** The config of a machine that writes tickets: a terminal, a Grill, the repositories and priorities it offers, and the writer's host-file default. */
export const writingConfig = (fields: Partial<ConfigView> = {}): ConfigView => queueingConfig({
  terminal: "https://terminal.example/{workspace}/{pane}", repos: ["agent-org", "a11ign"], priorities: ["urgent", "high", "medium", "low", "none"],
  writerDefault: { model: "sonnet", effort: "high" }, ...fields,
} as Partial<ConfigView>);

/** Tickets in two projects with goals, which the Manual fields offer. */
export const TICKETS: readonly TicketView[] = [
  ...BACKLOG,
  ticket({ key: "A11-4", title: "In another project", project: "agent-org", goals: ["Capture quality"] }),
];

/** The runs `/api/writer` lists, which a check changes between reads, and the answers of an instance that writes tickets. */
export type WriterBoard = Readonly<{ view: { runs: Run[] }; instance: InstanceAnswers }>;

/** `more` is what else the instance answers; a function of the runs, for a `post` that adds to them. */
export function writerBoard(runs: readonly Run[] = [], more: InstanceAnswers | ((view: WriterBoard["view"]) => InstanceAnswers) = {}, config: ConfigView = writingConfig()): WriterBoard {
  const view = { runs: [...runs] };
  return { view, instance: answers(TICKETS, { config, writer: view as never, ...(typeof more === "function" ? more(view) : more) }) };
}
