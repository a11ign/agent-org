#!/usr/bin/env node
// @ts-check
// DID THE CI-HEALTH COMMENT ARRIVE? -- a11ign/a11ign#3659, the standing duty of #3212's done-when 4.
//
//   node src/ci-health-liveness.ts                     read the latest Monday slot; exit 0 only for PRESENT
//   node src/ci-health-liveness.ts --repo=<owner/name> --workflow=ci-health.yml --issue=928
//                                                       name the three facts when the project does not declare them yet
//
// ## The gap
//
// `ci-health.yml` posts the chairman's CI targets on the report issue every Monday. Nothing in this org reads comments, and a
// schedule that stops firing reports nothing: GitHub disables a schedule after 60 days without repository activity, silently,
// and measured on 2026-10-05 the workflow had one run ever (a `workflow_dispatch`) and a cron slot 3 h 53 min past with no
// `schedule` run. `board-schedule-liveness.ts` names the shape; this asks the same question of this workflow, as a GATE QUESTION
// (an API call per tick, not a model turn: `.claude/rules/org-routing-and-timers.md`).
//
// ## Four verdicts, never two -- and the fifth is not "healthy"
//
//   PRESENT      the week's `schedule` run AND its `## CI health, week of <date>` comment both exist
//   NOT YET      the slot plus the grace has not passed, and one of the two is still missing
//   SILENT       grace passed and no `schedule` run exists for the slot (a comment from a dispatch does not make it present)
//   NO COMMENT   a `schedule` run exists and the comment does not
//   CANNOT TELL  a lookup failed or the project did not say which workflow and issue. NEVER reported as healthy: a rate limit
//                must not read as "nothing to see here", and the gate raises no order for it, so the tick prints it instead.
//
// ## THE GRACE IS 6 HOURS, and why that number
//
// #965 recorded GitHub starting scheduled runs about FIVE hours late (the shared cron queue, worst at the top of the hour; its
// fix moved the minute off the hour, and its own first reading still found one ~4 h late). The slot here is `:43`, off the hour,
// and the same day's reading of this very workflow was 3 h 53 min late with no run. Six hours clears the recorded five with an
// hour over; a longer grace only delays the finding, a shorter one offers `product-manager` a week that is merely late. The row
// said the claimant may refine it from #965 and the evidence above does not argue for a different number, so it stays 6.
//
// ## THE HEADING IS DERIVED FROM `scripts/ci-health.mjs`, NOT GUESSED
//
// That script's `weeklyWindow(now)` reads "the seven whole UTC days before `now`'s day" and `main` takes `date` as the window's
// `since` day; `commentHeading({ date })` is `## CI health, week of ${date}`; and `alreadyPosted` is `body.startsWith(heading)`.
// So a run on UTC day D posts under `week of (D - 7 days)`: the Monday 2026-10-05 run posts `week of 2026-09-28`, the week that
// ENDED. A dispatch on Saturday 2026-10-03 read `week of 2026-09-26`, a different heading, so it can never stand in for the
// Monday. The day used is the RUN's own UTC day, so a run GitHub delayed past midnight is still looked for under the heading it
// would have written. The test pins this against the project's own script when the host names a checkout that has one.
//
// ## Where the offer is wired, and what it does not do
//
// `ciHealthOrders` returns the gate's own order shape (`session`, `cause`, `subject`, `discriminator`, `prompt`, `causeKey`),
// the way `rowOffBoardOrders` does. The wiring is ONE line in `work-gate.ts`'s `decide`, beside `rowOffBoardOrders`
// (`orders.push(...ciHealthOrders(await readCiHealth()))`), and it is not in this row's Region, so it is named on the row and
// `product-manager` amends it in. This module also does not fix a schedule that did not fire, and does not read any other
// workflow's liveness.
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { flagValue, refuseUnknownFlags } from "./lib/cli-flags.ts";
import { homeHostConfig } from "./host-config.ts";
import { READY_LABEL } from "./claim-labels.ts";

export const VERDICT = Object.freeze({
  PRESENT: "PRESENT",
  NOT_YET: "NOT YET",
  SILENT: "SILENT",
  NO_COMMENT: "NO COMMENT",
  CANNOT_TELL: "CANNOT TELL",
});

/** Only PRESENT is a pass. NOT YET is not a finding, and CANNOT TELL is not a pass either. */
export const EXIT = Object.freeze({ PRESENT: 0, NOT_YET: 3, SILENT: 1, NO_COMMENT: 1, CANNOT_TELL: 2 });

export const GRACE_HOURS = 6;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const DAYS_PER_WEEK = 7;
const PAGE_SIZE = 100;

/** a cron slot in UTC; weekday 0 is Sunday */
export type Slot = { minute: number, hour: number, weekday: number };
export type Run = { id: number, event: string, created_at: string, conclusion?: string | null, status?: string | null };
/** one tracker's repository to look in; `key` is the tracker's (#4080), absent for a flag-named one */
export type Declared = { repo: string, workflow: string, issue: number, key?: string };

/** @param {Date} date @returns {string} `YYYY-MM-DD` in UTC */
const dayOf = (date: Date): string => date.toISOString().slice(0, "YYYY-MM-DD".length);

/** `scripts/ci-health.mjs`'s `commentHeading`, restated here because that file is the project's and this is the tool's. @param {string} date */
export const commentHeading = (date: string) => `## CI health, week of ${date}`;

/** The week the comment is about: the seven whole UTC days before the run's day (`weeklyWindow`). @param {string} runCreatedAt */
export function headingForRun(runCreatedAt: string) {
  const runDay = new Date(`${dayOf(new Date(runCreatedAt))}T00:00:00Z`);
  return commentHeading(dayOf(new Date(runDay.getTime() - DAYS_PER_WEEK * MS_PER_DAY)));
}

/**
 * The one cron of a workflow file, as a UTC slot. `null` when there is not exactly one numeric `m h * * d` cron, because a slot
 * this cannot name is not one to guess: the verdict for it is CANNOT TELL.
 * @param {string} workflowText @returns {Slot | null}
 */
export function slotFromWorkflow(workflowText: string): Slot | null {
  const crons = [...workflowText.matchAll(/^\s*-\s*cron:\s*["']([^"'\n]+)["']/gm)].map((m) => m[1]);
  if (crons.length !== 1) return null;
  const fields = crons[0].trim().split(/\s+/);
  const [minute, hour, dayOfMonth, month, weekday] = fields;
  const numeric = (field: string) => /^\d{1,2}$/.test(field);
  if (fields.length !== 5 || dayOfMonth !== "*" || month !== "*" || ![minute, hour, weekday].every(numeric)) return null;
  const slot = { minute: Number(minute), hour: Number(hour), weekday: Number(weekday) % DAYS_PER_WEEK };
  return slot.minute < 60 && slot.hour < 24 && Number(weekday) <= DAYS_PER_WEEK ? slot : null;
}

/** The most recent slot at or before `now`. @param {Date} now @param {Slot} slot @returns {Date} */
export function latestSlot(now: Date, { minute, hour, weekday }: Slot): Date {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));
  for (let back = 0; back <= DAYS_PER_WEEK; back += 1) {
    const candidate = new Date(today.getTime() - back * MS_PER_DAY);
    if (candidate.getUTCDay() === weekday && candidate <= now) return candidate;
  }
  throw new Error(`no ${weekday}-day slot found within a week of ${now.toISOString()}`);
}

export type Reading = { verdict: string, slotAt: string | null, graceEndsAt: string | null, heading: string | null, runId: number | null, detail: string };

/** @param {string[]} unread what could not be read, so the line says WHICH half is unknown @returns {Reading} */
const cannotTell = (unread: string[]): Reading => ({ verdict: VERDICT.CANNOT_TELL, slotAt: null, graceEndsAt: null, heading: null, runId: null,
  detail: `could not read ${unread.join("; ")}. This is INCONCLUSIVE, not healthy.` });

/**
 * THE VERDICT, PURE: a run list and a comment list are handed in, and `null` for either means that lookup failed.
 * @param {{ now: Date, slot: Slot | null, runs: Run[] | null, comments: string[] | null, workflowState?: string | null,
 *           graceHours?: number, unread?: string[] }} facts
 * `workflowState` is printed beside SILENT and decides nothing: a disabled schedule and a schedule that never fired are
 * both SILENT, and which one it is changes what `product-manager` does about it.
 * @returns {Reading}
 */
export function ciHealthLiveness({ now, slot, runs, comments, workflowState = null, graceHours = GRACE_HOURS, unread = [] }: {
        now: Date; slot: Slot | null; runs: Run[] | null; comments: string[] | null; workflowState?: string | null;
        graceHours?: number; unread?: string[];
    }): Reading {
  const missing = unread.length > 0 ? unread : [slot === null && "the workflow's one cron slot (none, or not a plain `m h * * d`)",
    runs === null && "the workflow's `schedule` runs", comments === null && "the report issue's comments"].filter((m) => typeof m === "string");
  if (slot === null || runs === null || comments === null) return cannotTell(missing);

  const slotAt = latestSlot(now, slot);
  const graceEndsAt = new Date(slotAt.getTime() + graceHours * MS_PER_HOUR);
  const slotEnd = new Date(slotAt.getTime() + DAYS_PER_WEEK * MS_PER_DAY);
  const forSlot = runs.filter((r) => r.event === "schedule" && new Date(r.created_at) >= slotAt && new Date(r.created_at) < slotEnd)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const run = forSlot[0] ?? null;
  const base = { slotAt: slotAt.toISOString(), graceEndsAt: graceEndsAt.toISOString() };
  const stillInGrace = now < graceEndsAt;

  if (run === null) {
    const anyComment = comments.some((body) => body.startsWith("## CI health, week of "));
    const beside = `workflow state: ${workflowState ?? "unread"}${anyComment ? "; a CI-health comment exists, but no `schedule` run produced one for this slot" : ""}`;
    return stillInGrace
      ? { ...base, verdict: VERDICT.NOT_YET, heading: null, runId: null, detail: `no \`schedule\` run yet; grace ends ${graceEndsAt.toISOString()} (${beside})` }
      : { ...base, verdict: VERDICT.SILENT, heading: null, runId: null, detail: `no \`schedule\` run of the ${slotAt.toISOString()} slot, ${graceHours} h grace over (${beside})` };
  }
  const heading = headingForRun(run.created_at);
  const posted = comments.some((body) => body.startsWith(heading));
  const ran = `\`schedule\` run ${run.id} (${run.created_at}, ${run.conclusion ?? run.status ?? "unknown"})`;
  if (posted) return { ...base, verdict: VERDICT.PRESENT, heading, runId: run.id, detail: `${ran} and "${heading}" are both present` };
  return { ...base, verdict: stillInGrace ? VERDICT.NOT_YET : VERDICT.NO_COMMENT, heading, runId: run.id,
    detail: `${ran} exists and "${heading}" is not on the report issue${stillInGrace ? `; grace ends ${graceEndsAt.toISOString()}` : ""}` };
}

/**
 * One line a person or a tick log can read. `repo` names the tracker's repository when more than one is read (#4080), so two lines are told apart; with one it is left out
 * and the line is the one it always was.
 * @param {Reading} reading @param {string} [repo]
 */
export function readingLine(reading: Reading, repo: string = "") {
  return `ci-health liveness${repo === "" ? "" : ` (${repo})`}: ${reading.verdict}${reading.slotAt ? ` -- slot ${reading.slotAt}` : ""}: ${reading.detail}`;
}

/**
 * THE GATE'S OFFER to `product-manager`, in `rowOffBoardOrders`'s shape. `repo` (#4080) is the tracker's repository when several are read: it joins the key, so a miss in
 * each tracker is its own question, and it is named in the prompt. Only SILENT and NO COMMENT are offered: PRESENT and NOT YET
 * are nothing to do, and CANNOT TELL is not a finding about the week (the tick prints it on stderr), so no order is raised for it.
 *
 * KEYED ON THE SLOT AND THE VERDICT, so a settled question is the same string and the wake ledger does not re-ask it, while a
 * SILENT week that becomes NO COMMENT (or a new week) is a new question.
 * @param {Reading} reading @param {string} [repo]
 * @returns {{ session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string }[]}
 */
export function ciHealthOrders(reading: Reading, repo: string = ""): { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string; }[] {
  if (reading.verdict !== VERDICT.SILENT && reading.verdict !== VERDICT.NO_COMMENT) return [];
  const half = reading.verdict === VERDICT.SILENT ? "the `schedule` run" : "the comment on the report issue";
  const discriminator = `${repo === "" ? "" : `${repo}/`}${reading.slotAt}/${reading.verdict.replace(" ", "-").toLowerCase()}`;
  return [{
    session: "product-manager",
    cause: "ci-health-missing",
    subject: "ci-health",
    discriminator,
    prompt: `The week's CI-health report did not arrive: ${half} is missing (${reading.verdict}).\n${readingLine(reading, repo)}\n`
      + `A finding is a row: file it \`${READY_LABEL}\` with the cause named (a schedule GitHub disabled after 60 days without activity, a run that failed, `
      + "a comment the script refused) and its owner. THIS ORDER DOES NOT FIX THE SCHEDULE, and it is not raised again for the same slot and verdict.",
    causeKey: `product-manager/ci-health-missing/${discriminator}`,
  }];
}

// ---- the reads -------------------------------------------------------------------------------------------

export type Gh = (args: string[]) => string;

const defaultGh: Gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * PAGE_SIZE * 1024 });

/**
 * One lookup, whose failure is RECORDED and never read as empty: a thrown call or an unparseable answer is `{ value: null, why }`.
 * @template T @param {string} what @param {() => T} read @returns {{ value: T | null, why: string | null }}
 */
function attempt<T>(what: string, read: () => T): { value: T | null; why: string | null; } {
  try {
    return { value: read(), why: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    return { value: null, why: `${what} (${message})` };
  }
}

/**
 * Everything the verdict needs, read from GitHub. `gh api` spends the CORE pool, so the account that runs this must be named by
 * the caller (`gh-api-budget.md`); this reads no other pool.
 * @param {Declared} declared @param {Date} now @param {{ gh?: Gh }} [deps]
 */
export function readFacts({ repo, workflow, issue }: Declared, now: Date, { gh = defaultGh }: { gh?: Gh; } = {}) {
  const meta = attempt("the workflow's state", () => JSON.parse(gh(["api", `repos/${repo}/actions/workflows/${workflow}`])));
  const text = attempt("the workflow file (cron)", () => gh(["api", `repos/${repo}/contents/${meta.value?.path ?? `.github/workflows/${workflow}`}`, "-H", "Accept: application/vnd.github.raw"]));
  const slot = text.value === null ? null : slotFromWorkflow(text.value);
  const since = slot === null ? null : latestSlot(now, slot).toISOString().replace(".000", "");
  const runs = attempt("the workflow's `schedule` runs", () => JSON.parse(gh(["api",
    `repos/${repo}/actions/workflows/${workflow}/runs?event=schedule&per_page=${PAGE_SIZE}`])).workflow_runs);
  const comments = attempt("the report issue's comments", () => JSON.parse(gh(["api", "--paginate", "--slurp",
    `repos/${repo}/issues/${issue}/comments?per_page=${PAGE_SIZE}${since ? `&since=${since}` : ""}`])).flat().map((c: { body: string; }) => c.body));
  return {
    slot, runs: runs.value, comments: comments.value, workflowState: meta.value?.state ?? null,
    unread: [meta, text, runs, comments].flatMap((r) => (r.why ? [r.why] : [])),
  };
}

/**
 * The project's declaration of WHICH workflow and WHICH issue, beside `units.traceWeeklyIssue`'s own: `units.ciHealthWorkflow` and
 * `units.ciHealthIssue`, looked for in the repository of EVERY declared tracker (#4080), each answering for itself. An absent or malformed declaration is a reason, never a default.
 * @param {string} text the project's `.agent-org/project.json` @returns {{ declared: Declared[] } | { refusal: string }}
 */
export function declarationFrom(text: string): { declared: Declared[]; } | { refusal: string; } {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return { refusal: "the project declaration (it is not valid JSON)" }; }
  const trackers: any[] = Array.isArray(parsed?.tracker) ? parsed.tracker : [];
  const { ciHealthWorkflow: workflow, ciHealthIssue: issue } = parsed?.units ?? {};
  if (trackers.length === 0 || trackers.some((tracker) => typeof tracker?.repo !== "string" || tracker.repo === "")) {
    return { refusal: "the project declaration (it does not declare a `repo` for every entry of `tracker`)" };
  }
  if (typeof workflow !== "string" || workflow === "") return { refusal: "the project declaration (it does not declare units.ciHealthWorkflow, the workflow file name)" };
  if (!Number.isInteger(issue) || issue <= 0) return { refusal: "the project declaration (it does not declare units.ciHealthIssue, the report issue as a positive integer)" };
  return { declared: trackers.map((tracker) => ({ key: typeof tracker.key === "string" ? tracker.key : "", repo: tracker.repo, workflow, issue })) };
}

/**
 * The whole reading: declared or flagged facts in, one `Reading` out. Never throws for a failed lookup.
 * @param {{ declared: Declared } | { refusal: string }} where @param {Date} now @param {{ gh?: Gh }} [deps] @returns {Reading}
 */
export function readCiHealth(where: { declared: Declared; } | { refusal: string; }, now: Date, deps?: { gh?: Gh; }): Reading {
  if ("refusal" in where) return cannotTell([where.refusal]);
  return ciHealthLiveness({ now, ...readFacts(where.declared, now, deps) });
}

/**
 * One reading per declared tracker (#4080), in declaration order. A tracker whose lookup fails is CANNOT TELL for THAT tracker, and the others are read all the same:
 * a refusal on one repository is never allowed to hide another's verdict.
 * @param {{ declared: Declared[] } | { refusal: string }} where @param {Date} now @param {{ gh?: Gh }} [deps]
 * @returns {{ repo: string, reading: Reading }[]} `repo` is `""` for a refusal, which belongs to no tracker
 */
export function readCiHealthAll(where: { declared: Declared[]; } | { refusal: string; }, now: Date, deps?: { gh?: Gh; }): { repo: string; reading: Reading; }[] {
  if ("refusal" in where) return [{ repo: "", reading: readCiHealth(where, now, deps) }];
  return where.declared.map((declared) => {
    try {
      return { repo: declared.repo, reading: readCiHealth({ declared }, now, deps) };
    } catch (cause) {
      return { repo: declared.repo, reading: cannotTell([`the lookup in ${declared.repo} (${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)})`]) };
    }
  });
}

/**
 * THE EXIT OF SEVERAL READINGS: the most alarming one decides, so a healthy tracker never excuses another. A finding (SILENT, NO COMMENT) is KNOWN to be wrong and outranks
 * CANNOT TELL, which may be nothing; CANNOT TELL outranks NOT YET, which is only early; only all PRESENT is a pass. One reading gives the code it always did.
 * @param {Reading[]} readings @returns {number}
 */
export function exitFor(readings: Reading[]): number {
  const code = { [VERDICT.PRESENT]: EXIT.PRESENT, [VERDICT.NOT_YET]: EXIT.NOT_YET, [VERDICT.SILENT]: EXIT.SILENT,
    [VERDICT.NO_COMMENT]: EXIT.NO_COMMENT, [VERDICT.CANNOT_TELL]: EXIT.CANNOT_TELL };
  const rank = [EXIT.PRESENT, EXIT.NOT_YET, EXIT.CANNOT_TELL, EXIT.SILENT];
  return readings.map((reading) => code[(reading.verdict as keyof typeof code)]).reduce((worst, next) => (rank.indexOf(next) > rank.indexOf(worst) ? next : worst), EXIT.PRESENT);
}

/** The project's declaration, from the host's primary project's checkout. @returns {{ declared: Declared[] } | { refusal: string }} */
function declaredByProject(): { declared: Declared[]; } | { refusal: string; } {
  const host = homeHostConfig();
  const checkout = host.projects.find((p) => p.id === host.primary)?.checkout;
  if (!checkout) return { refusal: `the project declaration (the host names no checkout for its primary project ${host.primary})` };
  try {
    return declarationFrom(readFileSync(join(checkout, ".agent-org", "project.json"), "utf8"));
  } catch (cause) {
    return { refusal: `the project declaration (${cause instanceof Error ? cause.message : String(cause)})` };
  }
}

/** @returns {{ declared: Declared[] } | { refusal: string }} the three flags together override the declaration, so a live reading needs no a11ign edit */
function declaredByFlags(): { declared: Declared[]; } | { refusal: string; } {
  const [repo, workflow, issue] = ["repo", "workflow", "issue"].map((name) => flagValue(process.argv.slice(2), name));
  if (repo === undefined && workflow === undefined && issue === undefined) return declaredByProject();
  if (!repo || !workflow || !/^[1-9]\d*$/.test(issue ?? "")) return { refusal: "the flags (--repo, --workflow and --issue must be given together, the issue a positive integer)" };
  return { declared: [{ repo, workflow, issue: Number(issue) }] };
}

function main() {
  refuseUnknownFlags(["--repo=", "--workflow=", "--issue="], { entry: import.meta.url, command: "node src/ci-health-liveness.ts" });
  const readings = readCiHealthAll(declaredByFlags(), new Date());
  const several = readings.length > 1;
  for (const { repo, reading } of readings) {
    const named = several ? repo : "";
    console.log(readingLine(reading, named));
    for (const order of ciHealthOrders(reading, named)) console.log(`gate offer to ${order.session} [${order.causeKey}]: ${order.prompt.split("\n")[0]}`);
  }
  process.exit(exitFor(readings.map(({ reading }) => reading)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
