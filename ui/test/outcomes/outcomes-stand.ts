// module: a stand-in for `/api/outcomes` of an instance -- the answer the Outcomes page reads -- for this page's checks (A11-430)
//
// THE ANSWER IS THE INSTANCE'S OWN: the real route (`outcomesAnswer`) over an outcome log and a host file in a scratch folder, so the figures, the words a dollar figure is priced at, and the
// refusal of an unreadable log are the backend's, and a price changed in the host file is in the next read, as on an instance. Every other call is the shell's stand-in (`../fixtures.ts`).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOutcome, outcomeRecordOf, outcomesPath, type OutcomeRecord, type OutcomeReview, type OutcomeRound } from "../../../src/ticket-mode/outcomes/outcome-record.ts";
import { outcomesAnswer } from "../../../src/ticket-mode/outcomes/route.ts";
import type { PriceRow } from "../../../src/trace/prices.ts";
import type { Fetch } from "../../src/api/request.ts";
import { HERE, standFetch, type Failure, type Stand } from "../fixtures.ts";

export const DAY = 24 * 60 * 60 * 1000;
/** The instance's clock: the end of the week the page opens on. */
export const NOW = Date.parse("2026-11-14T12:00:00Z");
const MILLION = 1_000_000;
export const OPUS = "claude-opus-5-5";
export const SONNET = "claude-sonnet-5-5";

/** `input` and `output` million tokens of `model`. */
const spent = (model: string, input: number, output: number) => ({ [model]: { input: input * MILLION, output: output * MILLION, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
const round = (at: number, outcome: string, tokens: ReturnType<typeof spent>): OutcomeRound => ({ startedAt: at - 1, endedAt: at, outcome, tokens });
const review = (pr: string, verdict: string, at: number): OutcomeReview => ({ pr, head: `h${at}`, verdict, posted: at, at, tokens: spent(OPUS, 0, 0) });

type Run = Readonly<{ ticket: string; model: string; effort: string; labels: readonly string[]; prs: readonly string[]; rounds: readonly OutcomeRound[]; reviews?: readonly OutcomeReview[] }>;
const record = ({ ticket, model, effort, labels, prs, rounds, reviews }: Run): OutcomeRecord =>
  outcomeRecordOf({ ticket, model, effort, repos: ["agent-org"], labels, prs }, { since: rounds[0].endedAt - 1, rounds, ...(reviews === undefined ? {} : { reviews }) });

const PR = "https://github.com/a11ign/agent-org/pull/";

/**
 * The week of the ticket's acceptance: runs on opus/high and sonnet/medium in agent-org.
 *   A11-1 opus/high: 1 round, 1 PR approved at its first review, 1M in and 1M out of Opus.
 *   A11-2 opus/high: 2 rounds (the first asked a person), 1 PR blocked then approved, 1M in of Opus.
 *   A11-3 sonnet/medium: 1 round, 1 PR approved at its first review, 1M in of Sonnet.
 * And A11-9, three weeks before: outside the window.
 */
export const WEEK: readonly OutcomeRecord[] = [
  record({ ticket: "A11-1", model: "opus", effort: "high", labels: ["Feature"], prs: [`${PR}1`], rounds: [round(NOW - DAY, "ready-pr", spent(OPUS, 1, 1))], reviews: [review(`${PR}1`, "convinced", NOW - DAY + 1)] }),
  record({ ticket: "A11-2", model: "opus", effort: "high", labels: ["Bug"], prs: [`${PR}2`], rounds: [round(NOW - 3 * DAY, "needs-human", spent(OPUS, 0.5, 0)), round(NOW - 2 * DAY, "ready-pr", spent(OPUS, 0.5, 0))],
    reviews: [review(`${PR}2`, "not-convinced", NOW - 3 * DAY + 1), review(`${PR}2`, "convinced", NOW - 2 * DAY + 1)] }),
  record({ ticket: "A11-3", model: "sonnet", effort: "medium", labels: ["Bug"], prs: [`${PR}3`], rounds: [round(NOW - 4 * DAY, "ready-pr", spent(SONNET, 1, 0))], reviews: [review(`${PR}3`, "convinced", NOW - 4 * DAY + 1)] }),
  record({ ticket: "A11-9", model: "opus", effort: "high", labels: ["Bug"], prs: [`${PR}9`], rounds: [round(NOW - 21 * DAY, "ready-pr", spent(OPUS, 9, 9))] }),
];

/** An instance's state folder and host file, in a scratch folder: `prices` is the host file's `tickets.prices`, absent for the published table; `log` replaces the log's text. */
export type OutcomesFiles = Readonly<{ stateDir: string; hostPath: string; setPrices: (prices: readonly PriceRow[] | undefined) => void; setLog: (text: string) => void }>;

/** A scratch instance holding `records` in its outcome log, and a host file naming `prices`. */
export function outcomesFiles(records: readonly OutcomeRecord[] = WEEK, prices?: readonly PriceRow[]): OutcomesFiles {
  const stateDir = mkdtempSync(join(tmpdir(), "outcomes-page-"));
  const hostPath = join(stateDir, "host.json");
  for (const each of records) appendOutcome(outcomesPath(stateDir), each);
  const setPrices = (rows: readonly PriceRow[] | undefined) => writeFileSync(hostPath, JSON.stringify({ tickets: rows === undefined ? {} : { prices: rows } }));
  setPrices(prices);
  return { stateDir, hostPath, setPrices, setLog: (text) => writeFileSync(outcomesPath(stateDir), text) };
}

/** A `fetch` whose `/api/outcomes` is the real route over `files` at {@link NOW}, or `fails`, and whose every other call is the shell's stand-in over `stand`. */
export function outcomesFetch(files: OutcomesFiles, { stand = { connections: [HERE] }, fails }: Readonly<{ stand?: Stand; fails?: Failure }> = {}): Fetch & Readonly<{ paths: string[] }> {
  const shell = standFetch(stand);
  const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const [, query = ""] = /\/api\/outcomes(?:\?(.*))?$/.exec(path) ?? [];
    if (!/\/api\/outcomes(\?|$)/.test(path)) return shell(input, init);
    shell.paths.push(path);
    const [status, body] = fails === undefined ? outcomesAnswer({ stateDir: files.stateDir, hostPath: files.hostPath, now: NOW }, new URLSearchParams(query)) : [fails.status, { error: fails.error }];
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return Object.assign(serve as Fetch, { paths: shell.paths });
}
