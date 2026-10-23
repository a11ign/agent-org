import { readFileSync } from "node:fs";
import { waitingOn, todayIso, ANSWER_PREFIX, answersOwedBy, bareAnswerLabel, answersGiven, ANSWER_GIVEN_WINDOW_MS } from "../../waiting-condition.ts";
import { subjectMention, subjectRef } from "../../review-attribution.ts";
import { NEEDS_CHAIRMAN_LABEL as CHAIRMAN_LABEL, BLOCKED_LABEL } from "../../project-vocabulary.ts";
import { readUnlessRefused } from "../../ticket-port/rows-by-label.ts";
import { rows as codeHostRows } from "../../plugins/rows.ts";
import { type ConditionalReads, conditionalFor, defaultRun, isGhRun, keptClosedAnswers, readWithFirstWaveTogether, repoNow, runBatch } from "../reads/read-memo-and-exit.ts";
import { herdrRun } from "../reads.ts";
import { MAX_ROW_ORDERS_PER_TICK, REFUSAL_REASON_CHARS, REVIEWER_REGISTRY_FILE, REVIEWER_STATE_DIR, labelsOf, sessionOf } from "../vocabulary.ts";

/**
 * Why a `gh` call threw, in one line: `gh`'s own first line of stderr when it was captured (`err.stderr`, or the lines after the first of
 * a batched call's message), else the error's first line. An `execFileSync` failure's first line is `Command failed: gh <args>`, which
 * the verb already says and which a long `--search` fills the cut with, so that line is the last choice and not the first.
 */
const reasonOf = (err: unknown): string => {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const lines = [e?.stderr, e?.message ?? err].flatMap((text) => String(text ?? "").split("\n")).map((line) => line.trim()).filter(Boolean);
  return (lines.find((line) => !line.startsWith("Command failed:")) ?? lines[0] ?? "no message").slice(0, REFUSAL_REASON_CHARS);
};

/** `readClosedAnswerRows`'s last refusal as a line (`issue list: boom`: the `gh` call, then why), `null` when the last read answered. Written by that read, read by `closedAnswerRows`. */
let closedRowsRefusal: string | null = null;

/** Records the reason and answers the `null` the read returns. */
function refusedClosedRows(verb: string, reason: string): null {
  closedRowsRefusal = `${verb}: ${reason}`;
  return null;
}

/**
 * #5050: THE CLOSED ISSUES (or the closed and merged pull requests) CARRYING ANY OF THE ANSWER LABELS, as ONE aliased GraphQL read -- `repository { a0: issues(labels:["answer:x"],
 * states:CLOSED) ... }`, a connection, where `issue list --search 'label:"answer:x","answer:y"'` was a SEARCH. A search's `label:a,b` is OR and a connection's `labels:[a,b]` is AND,
 * hence one alias per label and a row carrying two of them read twice and kept once.
 *
 * @returns the rows in the shape `gh` gave (`labels` an array); `null` when the answer is not whole (`errors` beside `data` is refused too, as for the reads beside it); a throw
 * is the caller's `catch`, which names the refused call
 */
function closedRowsCarrying(names: string[], { kind, run }: { kind: "issues" | "pullRequests"; run: (args: string[]) => string; }): any[] | null {
  return codeHostRows().closedRowsCarryingLabels({ names, kind, run });
}

/**
 * #2202: THE CLOSED ROWS THAT STILL OWE AN ANSWER -- the half of `answer-owed` that `readOpenRows` cannot see.
 *
 * `answer:<session>` is the org's only machine-readable "a named session still owes an answer here", and
 * `readOpenRows` is `--state open`, so a merge that closed the row ended the wake and nothing said it had
 * stopped. Measured 2026-09-22: #1936, #1970 and #2034, each labelled 5m23s to 14m45s before the merge that
 * closed it, none of the three questions ever answered. The close path now KEEPS the label
 * (`labelsToStrip`) and says so; this is what keeps acting on it.
 *
 * #2641: A MERGE CLOSES TWO THINGS, and this read chased only one. `trunkRedOrders` names the MERGED PULL REQUEST that
 * turned `main` red as its subject, `stuckRowOf` turns that into a number and `escalateStuck` labels it `answer:ceo`; a
 * pull request that is no longer open is no `gh issue list` row and no `readPrs` row, so that label was set and read by
 * nothing. `gh pr list --state all` is asked with `-is:open` -- merged AND closed-unmerged, the open ones being
 * `readPrs`'s -- so the same label names cost ONE more call and not a second `label list`. It asks for `isDraft`
 * because that field is how `isPullRequest` knows the row came from a pull request, and so how `answerOrders` says
 * "pull request" and not "row" to the session it wakes.
 *
 * THREE CALLS, AND EVERY ONE IS EXACT. `gh` matches one whole label name, and this is a PREFIX over one name per
 * session, so the repo's own `answer:` labels are listed first and the closed rows and pull requests carrying any of
 * them are asked for by name (`label:"a","b"` is GitHub's OR). A window over the newest closed rows or merged pull
 * requests would be one call, but a question older than the window would fall out of it -- the silent-void defect
 * again, one level down -- so this pays the calls to have no such edge. `-is:open` keeps the PR read's 100 for the
 * population it is FOR: an open pull request carrying the label would otherwise spend the window.
 *
 * ALL OR NOTHING: a refusal of either read is `null` for the whole, so `closedAnswerRows` says it once rather than
 * ordering the half that answered and staying silent about the half that did not.
 *
 *
 * THE REASON IS KEPT BESIDE THE `null`, NOT IN IT (a11ign/agent-org#483): the return stays `null` so no caller changes, and
 * `closedRowsRefusal` says which call failed and its first line, for `closedAnswerRows` to print when the answer is used.
 *
 * @returns `null` when refused, never `[]` -- "could not ask" is not "nobody owes anything"
 */
export function readClosedAnswerRows(run: (args: string[]) => string = defaultRun, goneTest: (() => ((session: string) => boolean) | null) | null = null,
  conditional: ConditionalReads | null = isGhRun(run) ? conditionalFor(undefined) : null): any[] | null {
  closedRowsRefusal = null;
  let asking = "";
  try {
    // `gh label list --json` prints ZERO BYTES, not `[]`, when nothing matches (#472): a repository with no `answer:`
    // label -- agent-org, since it became a declared tracker -- is "nobody owes anything", not a refusal. Only the
    // EMPTY stdout is read so; text that does not parse, a non-array and a thrown `gh` stay `null` below.
    // #5050: under the tick's refusal memory too -- a limit the by-label reads met is not answered by asking the label list.
    const names = readUnlessRefused({ what: "the answer: label names", run, read: () => { asking = "label list"; return codeHostRows().labelNamesWithPrefix({ prefix: ANSWER_PREFIX, run }); } });
    if (names === null) return refusedClosedRows(asking, "answered something that is not a list");
    if (names.length === 0) return [];
    // agent-org#1636: ONE ALIAS PER LABEL IS ONE GRAPHQL POINT PER LABEL PER KIND, and the label list never shrinks (34 in the home repository, 27 of them an ended session's:
    // measured 2026-10-17, 34 points for the issues read and 34 for the pull requests', every tick). An ended session's label is taken off every row it came back on
    // (`withoutEndedAnswerSessions`), so a row carrying only such labels was read for nothing: they are not asked for. `goneTest` is `endedAnswerSessionTest`, handed by the live
    // gate (a test's `run` stands for `gh` alone and must not read herdr), and `null` -- also what a herdr or a ledger that will not say gives -- asks for all.
    const isGone = goneTest === null ? null : goneTest();
    const asked = isGone === null ? names : names.filter((name) => !isGone(name.slice(ANSWER_PREFIX.length)));
    if (asked.length === 0) return [];
    // Named for what they ARE, not for the `api graphql` they travel as: the line a refusal leaves says which of the three reads failed.
    // agent-org#1636: kept for `KEPT_ANSWERS_MAX_AGE_MS` while the labels asked for are the same (`keptClosedAnswers`); a refusal is `null` there and is never kept.
    const merged = keptClosedAnswers(asked.join(","), () => {
      asking = "issue list";
      const closedIssues = closedRowsCarrying(asked, { kind: "issues", run });
      asking = "pr list";
      const closedPrs = closedRowsCarrying(asked, { kind: "pullRequests", run });
      if (closedIssues === null || closedPrs === null) {
        refusedClosedRows(closedIssues === null ? "issue list" : "pr list", "answered something that is not a list");
        return null;
      }
      return [...closedIssues, ...closedPrs];
    }, conditional);
    if (merged === null) return null;
    return withAnswerLabel(merged);
  } catch (err) {
    return refusedClosedRows(asking, reasonOf(err));
  }
}

/**
 * #2202: `readClosedAnswerRows` with its refusal SAID. Every other reader here degrades to `[]` silently, and
 * that is the one shape this row exists to end for this question -- an answer owed that stopped waking a
 * session with nothing saying it had -- so a refused read is a line, not an empty list.
 * (#3566, slice 5) HANDED THE READ, NOT MAKING IT: the read is one of the follow-ups asked together (`readOpenRowFollowUps`), and the refusal is still
 * said here, where it was, when the answer is used.
 * @param rows what `readClosedAnswerRows` answered
 */
export function closedAnswerRows(rows: any[] | null): any[] {
  if (rows === null) {
    process.stderr.write("NOTE: could not read the closed rows that still owe an answer -- a question on a row "
      + "a merge already closed -- or a pull request no longer open -- is NOT being chased this tick (#2202, #2641)."
      + `${closedRowsRefusal === null ? "" : ` Refused at ${closedRowsRefusal}`}\n`);
    return [];
  }
  return withoutEndedAnswerSessions(rows);
}

/**
 * #2609: A CLOSED ROW'S `answer:<session>` FOR A SESSION THAT HAS ENDED HAS NO ADDRESSEE (#2459's second producer).
 * The close path keeps the label on purpose (#2202), so a question closed unanswered still wakes the session that owes
 * the answer -- and that is right for a LIVE session and wrong for one torn down with its row: engineer instances are
 * one per row, and `worker-8` on #2116 was ordered `UNDELIVERED ... no workspace labelled` seven ticks running.
 *
 * WHAT ESTABLISHES `ended`, AND WHAT IT COSTS. The label is absent from `herdr workspace list` AND a teardown wrote it
 * down: `endedSessionLabels` reads the spare-cycle ledger and the reviewer-endings ledger, two local files and no API
 * call. Absent WITHOUT that record is not ended (`reviewer-<n>` is started after its order can exist, #2459 done-when 4),
 * and a herdr that does not answer classifies NOTHING: a blip read as every session gone would silence every question.
 * The herdr call is made only when a closed row carries an `answer:` label at all, so a quiet tracker pays nothing.
 *
 * Only the ENDED session's label is taken off the row COPY; another session's `answer:` on the same row still orders.
 */
export function withoutEndedAnswerSessions(rows: any[], { agents = liveWorkspaceLabels, ended = endedSessionLabels,
  say = (line) => process.stderr.write(line) }: { agents?: () => string[] | null; ended?: () => Map<string, number>; say?: (line: string) => void; } = {}): any[] {
  const owed = rows.filter((r) => labelsOf(r).some((n) => n.startsWith(ANSWER_PREFIX)));
  if (owed.length === 0) return rows;
  const isGone = endedSessionTest({ agents, ended }, say);
  return isGone === null ? rows : rows.map((row) => dropGoneLabels(row, isGone, say));
}

/**
 * `endedSessionTest` said nowhere: the read of the rows asks only for the labels of sessions this does not name. `listing` is a herdr listing the caller already holds (the gate reads
 * herdr ONCE per tick, so the follow-ups hand theirs and this does not read it again, nor from another moment); without one it reads the live herdr. `null` is a listing that failed.
 */
export const endedAnswerSessionTest = (listing?: { label: string; }[] | null, ended: () => Map<string, number> = endedSessionLabels) =>
  endedSessionTest({ agents: listing === undefined ? liveWorkspaceLabels : () => (listing === null ? null : listing.map((a) => a.label)), ended }, () => {});

/**
 * Has this session ENDED (see above)? `null` when herdr or the ledgers will not say, which classifies NOTHING as gone and says so through `say`.
 */
function endedSessionTest({ agents, ended }: { agents: () => string[] | null; ended: () => Map<string, number>; }, say: (line: string) => void): ((session: string) => boolean) | null {
  const live = agents();
  if (live === null) {
    say(`NOTE: herdr did not answer, so no closed row's \`${ANSWER_PREFIX}\` label was classed as gone this tick -- every one `
      + "still orders (#2609).\n");
    return null;
  }
  let gone;
  try {
    gone = ended();
  } catch (err) {
    say(`NOTE: the ended-session ledgers could not be read (${String((err as any)?.message ?? err).split("\n")[0]}) -- no closed row's \`${ANSWER_PREFIX}\` label was classed as gone this tick (#2609).\n`);
    return null;
  }
  return (session) => session !== "engineers" && !live.includes(session) && gone.has(session);
}

/**
 * `row` without its `answer:<session>` labels for sessions `isGone` names, saying each one -- as GONE, never as busy.
 */
function dropGoneLabels(row: any, isGone: (session: string) => boolean, say: (line: string) => void) {
  const goneLabels = labelsOf(row).filter((n) => n.startsWith(ANSWER_PREFIX) && isGone(n.slice(ANSWER_PREFIX.length)));
  for (const label of goneLabels) {
    say(`SKIPPED answer-owed for ${label.slice(ANSWER_PREFIX.length)} on closed row #${row.number}: that session has ENDED `
      + "(it is absent from herdr and a teardown recorded its ending), so the order would have no addressee (#2609).\n");
  }
  return goneLabels.length === 0 ? row
    : { ...row, labels: (row.labels ?? []).filter((l: any) => !goneLabels.includes(l?.name ?? l)) };
}

/**
 * Every workspace label herdr knows, or `null` when it would not say -- never `[]`, which would read as "nobody is
 * live" and class every session gone.
 */
export function liveWorkspaceLabels(): string[] | null {
  try {
    const workspaces = JSON.parse(herdrRun(["--session", "org", "workspace", "list"]))?.result?.workspaces;
    return Array.isArray(workspaces) ? workspaces.map((w: any) => String(w.label ?? "")) : null;
  } catch {
    return null;
  }
}

/** @returns `""` for a file that is not there; THROWS otherwise */
function evidenceText(path: string, read: typeof readFileSync): string {
  try {
    return String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return "";
    throw err;
  }
}

/** @returns an unparseable line is skipped: it cannot establish an ending */
function evidenceLines(path: string, read: typeof readFileSync): any[] {
  return evidenceText(path, read).split("\n").filter((l) => l.trim() !== "").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/**
 * WHICH LABELS A TEARDOWN RECORDED AS ENDED, and when (ms) -- the same reading as `wake.ts`'s `endedSessions`, which this
 * file cannot import (it imports this one). Two ledgers name an ending (`spare-cycles`, one line per engineer instance
 * closed; `reviewer-endings`) and two registries name what STARTED and has not ended: an entry stamped at or after the
 * ending is a later instance under the same name, and the label is not ended. THROWS on a file that exists and cannot be
 * read, so the caller drops nothing on a reading it could not make.
 */
export function endedSessionLabels({ dir = REVIEWER_STATE_DIR, read = readFileSync }: { dir?: string; read?: typeof readFileSync; } = {}): Map<string, number> {
  const ended: Map<string, number> = new Map();
  const note = (label: unknown, at: number) => {
    if (typeof label !== "string" || label === "?" || !Number.isFinite(at)) return;
    if (at > (ended.get(label) ?? -Infinity)) ended.set(label, at);
  };
  for (const cycle of evidenceLines(`${dir}/spare-cycles`, read)) note(cycle.role, Number(cycle.at));
  for (const ending of evidenceLines(`${dir}/reviewer-endings`, read)) note(ending.session, Date.parse(ending.at));
  for (const file of ["spare-instances.json", REVIEWER_REGISTRY_FILE]) {
    const text = evidenceText(`${dir}/${file}`, read);
    const registry = text === "" ? {} : JSON.parse(text);
    for (const [label, started] of Object.entries(registry ?? {}) as [string, any][]) {
      if (Number(started?.spawnedAt) >= (ended.get(label) ?? Infinity)) ended.delete(label);
    }
  }
  return ended;
}

/** The rows that owe someone an answer. */
export function withAnswerLabel(rows: any[]) {
  return (rows ?? []).filter((r) => labelsOf(r).some((n: string) => n.startsWith(ANSWER_PREFIX)));
}

/**
 * EVERY place an `answer:<session>` label can sit, as the one list `decide` takes (#2492). Three reads, one
 * input: the open rows, the open pull requests the gate already holds (`gh issue list` never returns a PR,
 * which is why a label on #2376 woke nobody), and the closed rows still owing (#2202). Kept as one named
 * function so a fourth place is one line here, and a test can call it rather than read `main`'s text. `closedRows`
 * is every subject that is no longer open: closed ISSUES (#2202) and merged or closed pull requests (#2641).
 */
export function rowsOwingAnswers({ openRows, openPrs, closedRows }: { openRows: any[]; openPrs: any[]; closedRows: any[]; }) {
  return [...withAnswerLabel(openRows), ...withAnswerLabel(openPrs), ...closedRows];
}

/**
 * `blocked` ROWS THAT NAME NOTHING A MACHINE CAN CHECK -- the root cause, not the pile.
 *
 * THE THREE WHYS, run 2026-09-20 when the chairman asked why nobody was working:
 *
 *   1. The engineer pool had ZERO claimable rows -- 1 of 38 was free and it was lane-owned.
 *   2. The whole remaining supply was ELEVEN rows labelled `blocked`, untouched since 19 Sep.
 *   3. Nothing re-examines them: `blocked` is in `NOT_STARTABLE` and filtered out AT READ TIME, so no
 *      cause can see one; and the nightly prose check caught 1 of the 11 (#72, whose body happens to
 *      say "Blocked on npmjs"). TEN WERE INVISIBLE TO EVERY CHECK IN THE SYSTEM.
 *
 * AND THE FOURTH WHY, which is where the fix belongs: #1780 added `blockedBy` and `Not-before:` as
 * PREFERRED alternatives and left `blocked` legal, unexaminable and unmigrated. So the pile both
 * persisted AND regenerated. A cause that drained today's eleven would fix the symptom; this one fires
 * on the PROPERTY -- a `blocked` label naming nothing -- so it also catches every new one.
 *
 * `blocked` IS NOT BANNED, and should not be: a wait neither mechanism can express is real (#1520 waits
 * on a hosted-runner behaviour, not a row or a date). What is refused is a `blocked` that says nothing
 * at all, because a claim nobody can evaluate is one only a human re-reading the row can ever lift --
 * which is exactly how these eleven got to be a day stale with the queue empty behind them.
 */
export function blockedWithoutReferent(rows: any[], today: string = todayIso()) {
  return (rows ?? []).filter((r) => labelsOf(r).includes(BLOCKED_LABEL)
    && waitingOn(r, today) === null
    // `needs:chairman` IS A REFERENT, AND OMITTING IT MADE THIS CAUSE LOOP.
    //
    // It names a person, it is machine-readable, `chairman-blocked` already routes it, and removing it
    // is the act of clearing -- every property `blockedBy` and `Not-before:` have. It existed before
    // this cause did, and the prompt's three options were therefore the wrong three.
    //
    // MEASURED 2026-09-20 on #72 ("configure npm trusted publishing, then revoke the token"), which
    // waits on an npm org-owner logging into npmjs.com -- a chairman action. `product-manager` read the
    // three options, correctly found that neither `--add-blocked-by` nor `Not-before:` fits, took the
    // third (name in one line what would clear it) and wrote a complete, accurate comment. The row then
    // still carried `blocked` and still named nothing checkable, SO THE CAUSE FIRED AGAIN -- and would
    // have forever. It cost one turn rather than one every two hours only because `product-manager`
    // recognised its own prior comment and declined to re-post.
    && !labelsOf(r).includes(CHAIRMAN_LABEL));
}

/**
 * One order per `blocked` row that names nothing, keyed on the row (#1799).
 *
 * TO `product-manager`: the label is process, and `agent-practices.md` names them first reader for
 * "filing and amendments ... holds, lane labels".
 *
 * ONLY WHEN THE SHELF IS EMPTY, like `epic-unfiled`: a stale `blocked` label while claimable work exists
 * is untidy; with the queue empty it is the only thing between the org and a full shelf.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * until 2026-09-21 this prompt said a comment alone was fine. #1520 -- a measurement waiting for a run count to reach 20, which is neither
 * a row, a date nor a person -- was then correctly re-answered FOUR TIMES IN NINE HOURS (23:43, 01:44, 05:45, 08:21), each a full turn
 * reaching the identical conclusion, because nothing could record that the question had been answered.
 * On 2026-09-20 eleven rows carried the `blocked` label with the queue empty behind them, one (#1731) about code fixed the day before.
 */
export function blockedReferentOrders(rows: any[], readyRows: any[], today: string = todayIso()) {
  if (readyRows.length > 0) return [];
  return blockedWithoutReferent(rows, today).slice(0, MAX_ROW_ORDERS_PER_TICK)
    .map((r: any) => ({
      session: "product-manager",
      cause: "blocked-unexaminable",
      subject: `row-${subjectRef(r.repoKey, r.number)}`,
      discriminator: subjectRef(r.repoKey, r.number),
      prompt: `${subjectMention(r)}${r.title ? ` (${r.title})` : ""} is labelled \`${BLOCKED_LABEL}\` and names NOTHING a `
        + "machine can check -- no `blockedBy` edge, no `Not-before:` line. NOTHING IN THIS ORG CAN SEE "
        + `IT: \`${BLOCKED_LABEL}\` is filtered out before any cause runs, so only a person re-reading the row can `
        + "ever lift it.\n"
        + "Read it and do ONE of four things: record the real blocker as data "
        + "(`gh issue edit " + `${r.number}` + " --add-blocked-by <n>`, or a `Not-before: YYYY-MM-DD` "
        + `line in the body); or REMOVE the \`${BLOCKED_LABEL}\` label if the condition has already become true; `
        + `or, IF IT WAITS ON A PERSON, label it \`${CHAIRMAN_LABEL}\` -- that names a referent, `
        + "`chairman-blocked` already routes it, and taking the label off is the act of clearing it; "
        + "or, if the wait is real and none of those three can express it, say on the row IN ONE LINE "
        + "what would clear it and who would notice, AND ADD A `Not-before:` FOR WHEN IT SHOULD NEXT BE "
        + "RE-CHECKED -- a week out is usually right.\n"
        + "THE `Not-before:` IS NOT OPTIONAL ON THAT LAST OPTION: nothing can record that the question "
        + "was answered, so an explanation with no horizon is not a terminal state; it is a loop the org "
        + "has been instructed to run.\n"
        + "A HORIZON IS ALSO THE HONEST ANSWER TO ROT. An unexaminable wait is exactly the kind that "
        + "quietly becomes true -- so it should go quiet for a while and then be asked ONCE more, not go "
        + "quiet forever and not be asked every two hours. Pick the date by when you would want to know "
        + "if nothing had changed.\n"
        + "Before reaching for that option at all, ask whether the wait is really on a person -- most "
        + `are, and \`${CHAIRMAN_LABEL}\` is then the honest answer.\n`
        + "THE CONDITION HAS OFTEN ALREADY CLEARED: check that first.",
      causeKey: `product-manager/blocked-unexaminable/row-${subjectRef(r.repoKey, r.number)}`,
    }));
}

/**
 * PURE. Who owes an answer on which rows -- `{ session: rows }`, oldest row first within each session.
 */
export function answersOwed(rows: any[]): Map<string, any[]> {
  const owed: Map<string, any[]> = new Map();
  for (const row of rows ?? []) {
    for (const name of labelsOf(row)) {
      if (!name.startsWith(ANSWER_PREFIX)) continue;
      const session = name.slice(ANSWER_PREFIX.length).trim();
      // AN EMPTY SESSION NAME IS NOT A SESSION. A bare `answer:` would otherwise wake a session called
      // "", which herdr reports as unknown and `wake` then counts as an order with nowhere to go.
      if (!session) continue;
      owed.set(session, [...(owed.get(session) ?? []), row]);
    }
  }
  return owed;
}

/**
 * Whether `row` is a pull request as `readPrs` returns one. `gh issue list` never returns `isDraft` or
 * `headRefOid` and `gh pr list --json` always does, so the shape says which list it came from without a
 * tag every caller would have to remember to set. A PR from `readPrs` carries no `state` either -- it reads
 * as open, which is what `--state open` made it.
 */
function isPullRequest(row: any) {
  return typeof row?.isDraft === "boolean" || typeof row?.headRefOid === "string";
}

/**
 * The sentence that says the subject is no longer open, or "" when it is. A MERGED pull request is its own case (#2641):
 * `state` is `MERGED`, not `CLOSED`, and "a merge closed it" would be the wrong verb for one that was never closed.
 *  @param subject `"row"` or `"pull request"`
 */
function closedNote(row: any, subject: string) {
  if (row.state === "MERGED") {
    return `THE ${subject.toUpperCase()} IS MERGED: it merged while your answer was still owed, and merging did not answer `
      + "it (#2641). A merged pull request still takes a comment, so answer there.\n";
  }
  if (row.state !== "CLOSED") return "";
  return `THE ${subject.toUpperCase()} IS CLOSED: ${subject === "row" ? "a merge closed it" : "it was closed"} while your answer `
    + `was still owed, and closing did not answer it (#2202). A closed ${subject} takes a comment, so answer there.\n`;
}

/**
 * One order PER ROW that owes an answer, keyed on the row.
 *
 * PER ROW FOR #1799's REASON, applied before it could bite: each row carries a DIFFERENT question, so a
 * count-keyed order would re-ask about every outstanding question each time any one of them was
 * answered. It also makes the prompt name ONE question rather than hand over a list.
 *
 * This cause had never fired when it was re-keyed -- zero ledger entries -- so unlike
 * `lane-backlog-unpromoted` there is no measured waste here, only the identical shape.
 *
 * NOT A JUDGMENT CAUSE, and the only one of the four that is not. The others ask "what should happen
 * next", a standing question deserving the 2h TTL. This names a question SOMEONE ELSE IS BLOCKED ON, so
 * it takes the 20-minute wake cadence -- 6.5 hours is what the absence of any cadence already cost.
 * It is declared `GROUPS.ACTION` in `cause-declaration.ts` (#3652): until then it was a judgment cause and
 * this paragraph was untrue of the code, so a delivery held the key for two hours even after the label was
 * removed and re-applied. The key carries no label time, so a re-applied label inside twenty minutes of a
 * delivery waits out the rest of that window, and a label left standing trips `MAX_DELIVERIES` in about two hours.
 *
 * A PULL REQUEST IS ONE OF THE `rows` (#2492). `gh issue list` does not return pull requests, so a label
 * set on a PR was read by nothing (#2376 carried `answer:worker-tooling` and `answer:ceo` and the wake
 * ledger held no `answer-owed` entry for it). `main` now hands this `readPrs`'s open PRs beside the rows.
 * GitHub numbers issues and pull requests in ONE namespace, so `row-<n>` still names exactly one thing and
 * the key needs no second spelling; only the WORDS change, so the reader looks where the question is.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * on 2026-09-20 a question sat unread for 6.5 hours while the session that asked it re-posted five times.
 */
export function answerOrders(rows: any[]) {
  const orders = [];
  for (const [session, owed] of answersOwed(rows)) {
    for (const row of owed.slice(0, MAX_ROW_ORDERS_PER_TICK)) {
      const subject = isPullRequest(row) ? "pull request" : "row";
      orders.push({
        session,
        cause: "answer-owed",
        subject: `row-${subjectRef(row.repoKey, row.number)}`,
        discriminator: subjectRef(row.repoKey, row.number),
        prompt: `${subjectMention(row)} ${isPullRequest(row) ? "IS A PULL REQUEST " : "IS "}WAITING ON AN ANSWER FROM YOU. `
          + `Another session asked you something there and cannot move until you reply -- read that ${subject}'s `
          + "most recent comments for the question.\n"
          + closedNote(row, subject)
          + `ANSWER ON THE ${subject.toUpperCase()}, then remove its \`${ANSWER_PREFIX}${session}\` label: taking the label `
          + "off IS the act of answering, and it is the only thing that stops this being asked again.\n"
          + "\"I cannot answer this\" is an answer -- say so, say who can, and re-label it to them. "
          + "What is not an answer is silence: nothing in this org reads comments, so the asker cannot move.",
        causeKey: `${session}/answer-owed/row-${subjectRef(row.repoKey, row.number)}`,
      });
    }
  }
  return orders;
}

/**
 * This row/PR's own `labeled`, `unlabeled` and `commented` timeline events, projected to the fields
 * `bareAnswerLabel` and `answersGiven` read -- never the whole payload, which on a long-lived row carries
 * every review, commit and cross-reference too. `actor` is the account that wrote the event and `id` is a
 * comment's own id (#3632).
 *
 * `null` ON A REFUSED READ, NEVER `[]`: an empty timeline would read every outstanding `answer:` label on
 * it as bare, which is the false-positive direction a refused read must not produce (`readCommitShas`'s
 * own rule, applied here).
 */
export function readRowTimeline(number: number, run: (args: string[]) => string = defaultRun): { event: string; label?: { name: string; }; actor?: string; id?: number; created_at: string; }[] | null {
  try {
    return codeHostRows().rowTimelineOf({ repo: repoNow(), number, run });
  } catch {
    return null;
  }
}

/**
 * One order: wake `holder` because `owed`'s `answer:` label has nothing said on `row` since `labelledAt`.
 */
function bareAnswerLabelOrder(row: any, holder: string, owed: string, labelledAt: string) {
  const subject = isPullRequest(row) ? "pull request" : "row";
  return {
    session: holder,
    cause: "answer-label-unexplained",
    subject: `row-${subjectRef(row.repoKey, row.number)}`,
    discriminator: `${owed}/${labelledAt}`,
    prompt: `${subjectMention(row)} carries \`${ANSWER_PREFIX}${owed}\`, applied at ${labelledAt}, with `
      + `NOTHING posted on this ${subject} since -- so ${owed} cannot tell a real question from a label `
      + "applied out of habit or by mistake (#2711).\n"
      + `POST THE QUESTION ${owed} is meant to answer, or remove the label if it no longer applies -- `
      + "leaving it as it is asks the addressee to clear a label that means nothing.",
    causeKey: `${holder}/answer-label-unexplained/row-${subjectRef(row.repoKey, row.number)}/${owed}/${labelledAt}`,
  };
}

/**
 * Every unexplained `answer:` label on ONE row/PR, turned into orders. PAID ONLY BY A ROW THAT ALREADY
 * CARRIES THE LABEL AT ALL: the timeline read happens after both cheap checks below have already refused.
 */
function bareAnswerLabelOrdersForRow(row: any, run: (args: string[]) => string, nowMs: number) {
  const holder = sessionOf(row);
  const owedSessions = answersOwedBy(row);
  if (!holder || owedSessions.length === 0) return [];
  const timeline = readRowTimeline(Number(row.number), run);
  const orders = [];
  for (const owed of owedSessions) {
    const bare = bareAnswerLabel(timeline, owed, nowMs);
    if (bare) orders.push(bareAnswerLabelOrder(row, holder, owed, bare.labelledAt));
  }
  return orders;
}

/**
 * `answerOrders`'s natural neighbour (#2711): that one wakes the NAMED session to answer; this wakes the
 * LABELLING session, because the addressee has no way to tell a real question from a label applied out of
 * habit or by mistake, and the label alone cannot say which. Live evidence: `worker-2632` added
 * `answer:ceo` to its own PR #2649 twice with no comment either time, and `ceo` cleared it twice with
 * nothing to answer.
 *
 * THE ROW'S OWN `session:` LABEL IS THE LABELLING SESSION, not the timeline's `actor.login`. Every org
 * session shares one of a handful of GitHub accounts (`.claude/rules/gh-api-budget.md`), so the timeline
 * can say which ACCOUNT wrote the label and never which SESSION -- but every observed case is the row's
 * own holder setting `answer:` on the row they are stopped on, which `sessionOf` already names. A row with
 * no holder has no session this cause can wake, so it is skipped rather than guessed at.
 *
 * @param rowsOwingAnswers `withAnswerLabel`'s output -- open rows and open pull requests together
 *
 * @param [nowMs] the gate's clock, for the label's grace window (`ANSWER_LABEL_GRACE_MS`)
 */
export function bareAnswerLabelOrders(rowsOwingAnswers: any[], run: (args: string[]) => string = defaultRun, nowMs: number = Date.now()) {
  const orders = [];
  for (const row of rowsOwingAnswers ?? []) {
    orders.push(...bareAnswerLabelOrdersForRow(row, run, nowMs));
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) return orders.slice(0, MAX_ROW_ORDERS_PER_TICK);
  }
  return orders;
}

/**
 * One order: tell `claimant` that `answered`'s question on `row` was answered, with where the answer is.
 */
function answerGivenOrder(row: any, claimant: string, given: ReturnType<typeof answersGiven>[number]) {
  const { answered, removedAt, removedBy, commentId } = given;
  const where = commentId === null
    ? `${removedBy ?? "the account that removed it"} posted no comment before removing it, so read the row's most recent comments`
    : `the answer is comment ${commentId}, the newest by ${removedBy} at or before the removal -- \`gh api repos/${repoNow()}/issues/comments/${commentId} --jq .body\``;
  return {
    session: claimant,
    cause: "answer-given",
    subject: `row-${subjectRef(row.repoKey, row.number)}`,
    discriminator: `${answered}/${removedAt}`,
    prompt: `${subjectMention(row)}: YOUR QUESTION WAS ANSWERED. \`${ANSWER_PREFIX}${answered}\` was removed at ${removedAt} by ${removedBy ?? "an unknown account"}, `
      + `and removing it IS ${answered}'s answer -- ${where}.\n`
      + "Act on it: the row is yours again, and nothing else will tell you it moved.",
    causeKey: `${claimant}/answer-given/row-${subjectRef(row.repoKey, row.number)}/${answered}/${removedAt}`,
  };
}

/**
 * #3632: THE CLAIMANT WHOSE QUESTION WAS JUST ANSWERED -- `answer-owed`'s other half. That cause wakes the
 * ANSWERER while the label stands; nothing woke the ASKER when it came off, so an answered claimant that had
 * gone idle waited for `claim-stalled`'s next nudge, up to 120 minutes (#3566 sat 44 past its answer).
 *
 * PAID ONLY BY A CLAIMED ROW TOUCHED INSIDE THE WINDOW: removing a label writes `updatedAt`, so a row not
 * updated since `ANSWER_GIVEN_WINDOW_MS` cannot hold a removal in it and is never read, and the per-row
 * timeline is the same read the bare-label cause makes. `null` for a refused timeline, never an order from
 * a guess. NO ORDER FOR A CLAIMANT HERDR SAYS IS NOT LIVE (`liveWorkspaceLabels`), the same reading
 * `withoutEndedAnswerSessions` uses; when herdr will not say (`null`), the order is made, as there.
 *
 * (#3566, slice 3) THE TIMELINES ARE ASKED TOGETHER (`readWithFirstWaveTogether`): the lane cost the SUM of its per-row reads, 11 calls and 11.9 s of a
 * 46.6 s gate in one run at load 45.5. EVERY touched live row is read, even when `MAX_ROW_ORDERS_PER_TICK` would have stopped the old loop early,
 * because a row's order count is known only after its timeline is read, so no smaller set is provably enough; the orders are still the first
 * `MAX_ROW_ORDERS_PER_TICK`, in the order the rows came. herdr is asked ONCE, before the read, because the rehearsal runs the read twice.
 *
 *
 *  @param [batch] the default is `runBatch` for `gh` itself and none for a `run` handed in
 */
export function answerGivenOrders(openRows: any[], run: (args: string[]) => string = defaultRun, nowMs: number = Date.now(), agents: () => string[] | null = liveWorkspaceLabels, batch: typeof runBatch | undefined = run === defaultRun ? runBatch : undefined) {
  const touched = (openRows ?? []).filter((row) => sessionOf(row) !== null
    && nowMs - Date.parse(String(row.updatedAt)) <= ANSWER_GIVEN_WINDOW_MS);
  if (touched.length === 0) return [];
  const live = agents();
  const askable = touched.filter((row) => live === null || live.includes((sessionOf(row) as string)));
  return readWithFirstWaveTogether((read) => answerGivenOrdersFromTimelines(askable, read, nowMs), run, batch);
}

/** @param rows touched, claimed and live */
function answerGivenOrdersFromTimelines(rows: any[], run: (args: string[]) => string, nowMs: number) {
  const orders = [];
  for (const row of rows) {
    const claimant = (sessionOf(row) as string);
    const timeline = readRowTimeline(Number(row.number), run);
    for (const given of answersGiven(timeline, claimant, nowMs)) orders.push(answerGivenOrder(row, claimant, given));
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) return orders.slice(0, MAX_ROW_ORDERS_PER_TICK);
  }
  return orders;
}

export const answerGivenOrdersOrNone = (orders: ReturnType<typeof answerGivenOrders> | undefined) => orders ?? [];

export const bareAnswerOrdersOrNone = (orders: ReturnType<typeof bareAnswerLabelOrders> | undefined) => orders ?? [];
