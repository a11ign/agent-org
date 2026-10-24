// module: the stand-in instance of the New ticket page checks -- the Tickets board's instance, as a machine that writes tickets, with the requests the ten boards draw
import type { ConfigView, WritersView } from "../../src/api/types.ts";
import { ticketsBoardStand, type InstanceAnswers, type Stand } from "../fixtures.ts";

export type Run = WritersView["runs"][number];

/** The request the boards quote. */
export const REQUEST = "Add a retry button to the unreachable banner, and have it re-check every 10 seconds while the page is open.";

const run = (fields: Partial<Run>): Run => ({ id: "w1", request: REQUEST, mode: "quick", placement: "auto", phase: "running", status: "writing", form: {}, model: "sonnet", effort: "high", tickets: [], ...fields }) as Run;

/** The five states the strip draws, with the strings the backend gives where the boards have example text. */
export const RUNS = {
  queued: run({ phase: "queued", status: "queued" }),
  writing: run({ workspace: "w1", pane: "p1" }),
  waiting: run({ mode: "grill", workspace: "w1", pane: "p1", status: "waiting", waiting: { question: "Which repository does the banner live in?", since: 1 } }),
  done: run({
    phase: "finished", status: "done",
    tickets: [{ key: "A11-143", url: "https://linear.app/a11ign/issue/A11-143", inPick: true, title: "The unreachable banner offers Retry and re-checks every 10 seconds while the page is open", priority: 3, project: "a11ign" }],
  }),
  failed: run({ phase: "finished", status: "failed", failure: "the writer ended its turn without creating a ticket" }),
} as const satisfies Record<string, Run>;

/** The writer's choices on the board: Sonnet at high effort, a terminal for Grill, and the repositories and priorities the Manual fields offer. */
const writing = (config: ConfigView, fields: Partial<ConfigView>): ConfigView => ({
  ...config, terminal: "https://terminal.example/{workspace}/{pane}", repos: ["agent-org", "a11ign"], priorities: ["urgent", "high", "medium", "low", "none"],
  writerDefault: { model: "sonnet", effort: "high" }, writerGrill: true, ...fields,
} as ConfigView);

/** What the board stand's instance answers beside its tickets, for `/api/writer` and the requests posted to it. */
export type Writing = Readonly<{ runs?: readonly Run[]; config?: Partial<ConfigView>; post?: "accepting" | InstanceAnswers["post"] }>;

/** The Tickets board's stand as a machine that writes tickets: `runs` listed by `/api/writer`, a `post` that answers the requests, and `config` over the writer's own. */
export function writingStand({ runs = [], config = {}, post }: Writing = {}): Stand & Readonly<{ view: { runs: Run[] } }> {
  const stand = ticketsBoardStand();
  const view = { runs: [...runs] };
  const personal = stand.instances?.personal as InstanceAnswers;
  const answer = post === "accepting" ? accepting(view) : post;
  const instance: InstanceAnswers = { ...personal, config: writing(personal.config as ConfigView, config), writer: view as never, ...(answer === undefined ? {} : { post: answer }) };
  return { ...stand, instances: { personal: instance }, view };
}

/** A `post` that takes every request: it lists a queued run for the body, and answers with the requests after it. */
export function accepting(view: { runs: Run[] }): NonNullable<InstanceAnswers["post"]> {
  return (path, body) => {
    if (path !== "/api/writer") return { runs: view.runs };
    const asked = body as { request: string; mode: Run["mode"]; placement: Run["placement"] };
    view.runs.push(run({ id: `w${view.runs.length + 1}`, request: asked.request, mode: asked.mode, placement: asked.placement, phase: "queued", status: "queued" }));
    return { runs: view.runs };
  };
}

/**
 * A serving whose instances each answer `/api/writer` with no requests, for a check of the Tickets page that is not about them: the page reads them beside the tickets. An instance
 * is wrapped, not copied, so a getter it has (a read that fails while a link is down) still answers as it is read.
 */
export function withWriter({ stand, ...serving }: Readonly<{ stand?: Stand; hold?: boolean }>): Readonly<{ stand?: Stand; hold?: boolean }> {
  if (stand === undefined) return serving;
  const answering = (instance: InstanceAnswers): InstanceAnswers => ("writer" in instance ? instance : Object.create(instance, { writer: { value: { runs: [] }, enumerable: true } }));
  const instances = Object.fromEntries(Object.entries(stand.instances ?? {}).map(([name, instance]) => [name, answering(instance)]));
  return { ...serving, stand: { ...stand, instances } };
}
