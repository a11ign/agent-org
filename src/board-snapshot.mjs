#!/usr/bin/env node
// @ts-check
// command: snapshot every Project item before any board-mutating call, so a bad mutation is recoverable
// EVERY BOARD MUTATION GOES THROUGH ONE WRAPPER, AND IT SNAPSHOTS FIRST -- issue #399.
//
// 2026-09-08, 00:0xZ: adding one Status option with `updateProjectV2Field` and a full
// `singleSelectOptions` list REPLACED THE WHOLE OPTION SET -- every option was re-issued with a new id and
// every one of the Project's 112 items' Status assignment was dropped in one call:
//
//   status distribution after:  {'(NONE)': 112}
//
// Recovered completely (`restored: 112, failed: 0`) and the snapshot that made that possible existed by
// LUCK -- it had been taken minutes earlier to report a before/after count, not as a backup. Run the
// mutation first and 112 Status values across four months of tracker history would have been
// unrecoverable, with nobody able to say what they had been. A mutation named `update...Field` that
// silently rewrites its siblings is this repo's own class of defect: reading an API's surface rather than
// its behaviour.
//
// So: `withBoardSnapshot(mutate)` snapshots every item's number/title/Status to
// `runs/board-snapshots/<stamp>.json` -- printing the path, since an unprinted backup is one nobody can
// find under pressure -- and REFUSES to call `mutate` at all if the snapshot did not write. `runs/` is
// gitignored on purpose: a snapshot is a recovery artefact, not history: the tracker itself is the record.
//
// #1275: A MUTATION THAT NAMES THE ITEM IT TOUCHES SNAPSHOTS THAT ITEM, NOT THE BOARD. Every board mutation in
// `scripts/` is one item's Status (`row-claim.mjs`'s `moveProjectStatus`); #399's accident was a FIELD rewrite
// that no script sends. A full sweep before each one-item edit cost 6 GraphQL pages at 555 items plus the
// ready-issue list, and the account's GraphQL budget ran out twice on 2026-09-13. The full sweep stays for an
// unscoped call, for this file's CLI and for `ready-label-audit.mjs` -- which is where #1219/#1228's census
// still prints.
//
// The scoped half lives in `board-snapshot-scope.mjs`, pure of `gh`, so the row's acceptance can run in a job with no
// token. The one `gh` call it needs is made here, in `withBoardSnapshot`.
import { execFileSync } from "node:child_process";
// #1219: PURE, and deliberately in its own module -- see that file's header. Importing it here costs
// nothing; importing THIS file from a test costs a `token` requirement the acceptance job cannot meet.
import { statusContradictions, statusCensus } from "./board-status-health.mjs";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { READY_LABEL } from "./claim-labels.mjs";
// #1275: the scoped half, PURE OF `gh` -- see that file's header. The constants live there and are re-exported above,
// because a constant that file imported from here would carry this file's `token` into its closure.
import { PROJECT_OWNER, PROJECT_NUMBER, SNAPSHOT_DIR, snapshotStamp, graphqlErrors, describeGraphqlErrors,
  graphqlErrorFromFailedRun, persistSnapshot, touchedIssues, snapshotRoute, withScopedSnapshot, forgetScopedSnapshots,
  scopedStatusOf, readUnlessProjectUnreadable }
  from "./board-snapshot-scope.mjs";

export { PROJECT_OWNER, PROJECT_NUMBER, SNAPSHOT_DIR, snapshotStamp } from "./board-snapshot-scope.mjs";

/**
 * #852: ONE SWEEP PER PROCESS, AND THE BOUND IS WHAT MAKES THAT SAYABLE.
 *
 * Every Status move used to sweep the whole board first. Measured on this branch with an injected `run`,
 * against a 257-item board (3 pages at `items(first: 100)`):
 *
 *   1 move   ->  3 board pages, 1 item-edit, 5 gh calls
 *   3 moves  ->  9 board pages, 3 item-edits, 15 gh calls
 *   20 moves -> 60 board pages, 20 item-edits, 100 gh calls
 *
 * The page count grows with the board, so every row added made every future claim more expensive. On
 * 2026-09-13 the org exhausted its 5,000-point GraphQL budget while REST still had 4,641 left, and this
 * is the largest GraphQL consumer in the claim path -- the budget line the row said to wait for.
 *
 * THE TRADE, STATED RATHER THAN HIDDEN. The snapshot now describes the board before the FIRST mutation of
 * this process, not before each one, so an operator reading it as "the state immediately before THIS
 * change" is reading more than it says. **The age bound is what keeps the weaker claim precise**: after
 * five minutes the next mutation takes a fresh sweep, so the record is never more than five minutes older
 * than the change it covers, and the file and the log line both say which. #399's guarantee -- that a
 * mutation cannot proceed without a real snapshot on disk -- is untouched: a failed write still throws
 * before `mutate` is called.
 */
export const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

/** @type {{ path: string, takenAt: Date } | null} The snapshot this process has already taken. */
let processSnapshot = null;

/** @type {(cmd: string, args: string[]) => string} */
const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

const ITEMS_QUERY = `
  query($owner: String!, $number: Int!, $cursor: String) {
    user(login: $owner) {
      projectV2(number: $number) {
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            content { ... on Issue { number title state } }
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** @typedef {import("./board-snapshot-scope.mjs").BoardItem} BoardItem */

/**
 * One page of `gh api graphql`'s response, parsed into `BoardItem[]` plus pagination state. THROWS on any
 * shape it does not recognise -- same discipline as `ready-label-audit.mjs`'s `fetchIssues`: a snapshot
 * that silently records fewer items than the board actually holds is worse than one that refuses outright,
 * because it looks complete.
 *
 * #555: CHECKS FOR `errors` BEFORE TRUSTING `data` AT ALL, even on the exit-0 path that reaches this
 * function -- GraphQL can return a 200 carrying `data` AND `errors` together, with `nodes` full of `null`
 * exactly where the token could count an item but not read it. A caller checking only for `data` being
 * present would read that as "N items, all empty", which is the partial-board-wearing-a-complete-one's-
 * clothes shape this whole file exists to prevent, arriving through the `errors` array instead of a
 * non-zero exit -- so this is checked whether or not `run()` itself threw.
 * @param {string} raw
 * @returns {{ items: BoardItem[], hasNextPage: boolean, endCursor: string | null }}
 */
function parsePage(raw) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`board-snapshot: gh's response was not JSON -- refusing to guess. `
      + `First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const errors = graphqlErrors(parsed);
  if (errors) {
    throw new Error(`board-snapshot: GraphQL returned an error alongside its response -- refusing to `
      + `treat a partial answer as complete, even though the request otherwise succeeded. `
      + `${describeGraphqlErrors(errors)}`);
  }
  const itemsNode = /** @type {any} */ (parsed)?.data?.user?.projectV2?.items;
  if (!itemsNode || !Array.isArray(itemsNode.nodes) || !itemsNode.pageInfo) {
    throw new Error(`board-snapshot: gh's response did not have the shape data.user.projectV2.items -- `
      + `refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  const items = itemsNode.nodes.map((/** @type {unknown} */ node, /** @type {number} */ i) => {
    const n = /** @type {any} */ (node);
    if (typeof n?.id !== "string") {
      throw new Error(`board-snapshot: item ${i} has no id -- refusing to guess. `
        + `Got: ${JSON.stringify(node).slice(0, 300)}`);
    }
    const statusValue = Array.isArray(n.fieldValues?.nodes)
      ? n.fieldValues.nodes.find((/** @type {any} */ v) => v?.field?.name === "Status")
      : undefined;
    return {
      itemId: n.id,
      // A draft item (no linked issue) carries `content: null` -- recorded with `number: null` rather
      // than dropped, because a snapshot that silently drops rows is exactly the defect this file exists
      // to prevent.
      number: typeof n.content?.number === "number" ? n.content.number : null,
      title: typeof n.content?.title === "string" ? n.content.title : null,
      status: typeof statusValue?.name === "string" ? statusValue.name : null,
      // #1219: null for a draft item, which has no issue and therefore no state. NOT defaulted to
      // "OPEN" -- a draft and an open issue are different things, and `statusContradictions`
      // classifies an unknown state as neither offender rather than guessing.
      state: typeof n.content?.state === "string" ? n.content.state : null,
    };
  });
  return {
    items,
    hasNextPage: itemsNode.pageInfo.hasNextPage === true,
    endCursor: typeof itemsNode.pageInfo.endCursor === "string" ? itemsNode.pageInfo.endCursor : null,
  };
}

/**
 * Every OPEN issue carrying `ready` -- the independent population #747's floor checks the snapshot
 * against. Read with a PLAIN top-level `gh issue list`, deliberately never nested inside another
 * connection: the narrowing measured on `fieldValues` (and on `claim-provenance.mjs`'s own #683
 * measurement of a nested `timelineItems`) only happens to a connection sharing a budget with sibling
 * rows in the SAME request, and a bare `issues(first: N)` at the top level is not that shape.
 *
 * Same truncation discipline as `ready-label-audit.mjs`'s `fetchIssues`: returning exactly `limit` rows
 * is indistinguishable from a truncated result, so that is refused rather than reported as complete.
 *
 * @param {{ run?: typeof defaultRun, limit?: number }} [deps]
 * @returns {number[]}
 */
export function fetchReadyIssueNumbers({ run = defaultRun, limit = 500 } = {}) {
  /** @type {string} */
  let raw;
  try {
    raw = run("gh", ["issue", "list", "--repo", REPO, "--state", "open", "--label", READY_LABEL,
      "--limit", String(limit), "--json", "number"]);
  } catch (cause) {
    throw new Error(`board-snapshot: could not list open ${READY_LABEL} issues from ${REPO} -- refusing `
      + `to guess whether the snapshot's Status coverage is complete. `
      + `${/** @type {Error} */ (cause).message}`, { cause });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`board-snapshot: gh's ${READY_LABEL}-issue list was not JSON -- refusing to guess. `
      + `First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`board-snapshot: gh's ${READY_LABEL}-issue list was not a list -- refusing to guess. `
      + `Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  if (parsed.length === limit) {
    throw new Error(`board-snapshot: gh returned exactly the requested limit (${limit}) of open `
      + `${READY_LABEL} issues -- indistinguishable from a truncated result, refusing to check the `
      + `snapshot's Status coverage against a partial population. Raise the limit.`);
  }
  return parsed.map((/** @type {unknown} */ entry, /** @type {number} */ i) => {
    const number = /** @type {{ number?: unknown }} */ (entry)?.number;
    if (typeof number !== "number") {
      throw new Error(`board-snapshot: ${READY_LABEL}-issue list entry ${i} has no number -- refusing `
        + `to guess. Got: ${JSON.stringify(entry).slice(0, 300)}`);
    }
    return number;
  });
}

/**
 * THE FLOOR #747 ADDS. `fieldValues` carries no `totalCount` at all, so nothing inside a single
 * response can ever prove GitHub did not narrow it to fit a budget shared with the OTHER items in the
 * same page -- exactly the shape `claim-provenance.mjs` measured on #683's nested `timelineItems`
 * (nodes agreeing with totalCount while both were narrowed together). An independently-derived
 * population -- every open `ready` issue, read by a query that is not nested -- is the only thing that
 * can catch it: pure, so it is driven with real shapes rather than asserted against this file's text.
 *
 * `excludeIssueNumber`, ADDED AFTER A LIVE SELF-TRIP (#891, filed live 2026-09-09, ceo's diagnosis):
 * this floor exists to catch a `ready` row that has silently LOST its Status somewhere -- neglect. It is
 * not that when the row's own filer passed a real `gh issue create -l ready` flag straight through
 * (row-file's own `--ready` sentinel is a SEPARATE, later convention -- see row-file.mjs's own #844/#883
 * comments -- and nothing stops a caller using gh's real flag instead), the issue already carried `ready`
 * by the time `gh project item-add` ran, so THIS call's own pre-write snapshot caught the very row it was
 * about to fix and refused, always, on itself -- the #872/#867 self-trip shape recurring through a second
 * door "label lands last" never closed, because it only ever controlled row-file's OWN label-add call.
 * The row currently having its Status set by the call this floor is protecting is not evidence of
 * neglect; it is the reason the call exists. Every OTHER ready row missing its Status is unaffected --
 * this excludes at most the one issue number the caller names, never a class.
 *
 * @param {BoardItem[]} items
 * @param {number[]} readyIssueNumbers
 * @param {number | null} [excludeIssueNumber] a row's own Status-setting call must not be refused by the
 *   very absence of Status it is about to fix -- `null` (the default) excludes nothing, for every other
 *   caller (a plain snapshot, an audit) that must still see every row honestly
 * @returns {number[]} the ready issue numbers with no Status in `items` (including one missing entirely)
 */
export function readyRowsMissingStatus(items, readyIssueNumbers, excludeIssueNumber = null) {
  const statusByNumber = new Map(
    items.filter((i) => i.number !== null).map((i) => [i.number, i.status]));
  return readyIssueNumbers.filter((n) => n !== excludeIssueNumber && statusByNumber.get(n) == null);
}

/**
 * Every item currently on the board. Paginated -- #399 measured 117 items on Project 2, comfortably past
 * one page of 100. `gh` failing, or answering with a shape this function does not recognise, THROWS: it
 * never falls through to a partial or empty list, which would let a snapshot claim completeness having
 * examined only some of the board.
 *
 * #747: ALSO REFUSES if any open `ready` row comes back with no Status -- `fieldValues(first: 20)` is
 * nested inside `items(first: 100)` above, the one shape GitHub narrows to a shared budget without ever
 * reporting it (no `totalCount` on `fieldValues` to compare against `nodes.length`, unlike the items
 * connection itself). This is the check that makes a truncated read refuse rather than look complete;
 * every caller of this function -- `writeBoardSnapshot`, and `ready-label-audit.mjs`'s own
 * board-membership check, which reads through this exact query -- inherits it for free.
 *
 * `excludeIssueNumber` -- see `readyRowsMissingStatus`'s own header (#891) -- passed through unchanged so
 * a caller boarding ONE specific issue can exempt only that issue from the floor while it is mid-fix.
 *
 * @param {{ run?: typeof defaultRun, fetchReady?: typeof fetchReadyIssueNumbers,
 *   excludeIssueNumber?: number | null }} [deps]
 * @returns {BoardItem[]}
 */
export function fetchBoardItems({ run = defaultRun, fetchReady = fetchReadyIssueNumbers,
  excludeIssueNumber = null } = {}) {
  /** @type {BoardItem[]} */
  const items = [];
  /** @type {string | null} */
  let cursor = null;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${ITEMS_QUERY}`, "-f", `owner=${PROJECT_OWNER}`,
      "-F", `number=${PROJECT_NUMBER}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    let raw;
    try {
      raw = run("gh", args);
    } catch (cause) {
      // #555: THE GRAPHQL ERROR, WHEN ONE EXISTS, NOT JUST THE COMMAND'S EXIT MESSAGE -- "could not read
      // Project 2 items" is compatible with no permission, a wrong project number, a user-vs-org shape
      // mismatch, or a query the schema rejects, and #546 sat three hours on that ambiguity. `gh`'s own
      // exit message never carries the API's answer; the FAILED PROCESS's stdout does.
      const graphqlDetail = graphqlErrorFromFailedRun(cause);
      throw new Error(`board-snapshot: could not read Project ${PROJECT_NUMBER} items -- refusing to `
        + `snapshot a partial board. ${graphqlDetail ?? /** @type {Error} */ (cause).message}`, { cause });
    }
    const page = parsePage(raw);
    items.push(...page.items);
    if (!page.hasNextPage) break;
    cursor = page.endCursor;
  }
  const readyNumbers = fetchReady({ run });
  const missing = readyRowsMissingStatus(items, readyNumbers, excludeIssueNumber);
  if (missing.length > 0) {
    throw new Error(`board-snapshot: ${missing.length} open ${READY_LABEL} row(s) came back with no `
      + `Status -- refusing to report this snapshot as complete. This is the snapshot reading short, `
      + `not the board being wrong (#747: fieldValues has no totalCount to check itself, so this is `
      + `read against an independent population instead): #${missing.join(", #")}`);
  }
  // #1219: THE CONTRADICTIONS ARE REPORTED, NOT REFUSED -- and that is a decision, not a softer guard.
  //
  // Measured when this landed: 311 closed rows at a live Status, 220 of them at `In progress`. A throw
  // would brick every snapshot and every row-filing that takes one, until somebody moved 311 rows by
  // hand -- so the guard would be removed within the hour rather than obeyed. The same trade #1158 made
  // for directory Regions and `buildAssertion` makes for an undeclared pin: a refusal that blocks the
  // repair path is not a stricter guard, it is an absent one.
  //
  // It is LOUD on every snapshot instead, and it names the count. The row's own ordering is guard first,
  // then the move -- moving them before this existed would mean doing it twice.
  const contradictions = statusContradictions(items);
  const { closedButLive, openButDone, closedUnboarded } = contradictions;
  if (closedButLive.length > 0 || openButDone.length > 0 || closedUnboarded.length > 0) {
    process.stderr.write(`board-snapshot: ${closedButLive.length} CLOSED row(s) advertise `
      + `a live Status, ${openButDone.length} OPEN row(s) advertise Done, and ${closedUnboarded.length} `
      + `CLOSED row(s) carry NO Status at all. A closed row at a live column is finished work a session `
      + `reading the board will take as available; a closed row with no Status is invisible to a check `
      + `that reads Statuses, which is why it is counted separately (#1228).\n`
      + `${statusCensus(items)}\n`);
  }
  return items;
}

/**
 * Fetches every board item and writes it to `<primary checkout>/runs/board-snapshots/<stamp>.json` (#1352: `SNAPSHOT_DIR`
 * resolves from the git common dir, not cwd), PRINTING the path --
 * whether via the returned value (callers) or `console.log` (the CLI below) -- because an unprinted backup
 * is one nobody can find under pressure. THROWS, rather than swallowing, if the fetch or the write fails:
 * the whole point of this function is that a caller who cannot get a real snapshot must not proceed to the
 * mutation it was meant to protect.
 *
 * @param {{ run?: typeof defaultRun, fetchReady?: typeof fetchReadyIssueNumbers,
 *   writeFile?: (path: string, data: string) => void,
 *   mkdir?: (path: string) => void, now?: () => Date, excludeIssueNumber?: number | null }} [deps]
 * @returns {string} the path written
 */
export function writeBoardSnapshot({
  run = defaultRun,
  fetchReady = fetchReadyIssueNumbers,
  writeFile = (path, data) => writeFileSync(path, data, "utf8"),
  mkdir = (path) => mkdirSync(path, { recursive: true }),
  now = () => new Date(),
  excludeIssueNumber = null,
} = {}) {
  const items = fetchBoardItems({ run, fetchReady, excludeIssueNumber });
  const takenAt = now();
  const path = `${SNAPSHOT_DIR}/${snapshotStamp(takenAt)}.json`;
  const snapshot = {
    takenAt: takenAt.toISOString(),
    // #852: SAYS WHAT IT IS, so a reader cannot infer the stronger guarantee from its presence. One
    // sweep per process now covers every board mutation that process makes within SNAPSHOT_MAX_AGE_MS,
    // so this file is the board before the FIRST of them -- not before each.
    takenBefore: "the first board mutation of this process; later mutations within "
      + `${SNAPSHOT_MAX_AGE_MS / 1000}s reuse this snapshot rather than taking their own (#852)`,
    project: { owner: PROJECT_OWNER, number: PROJECT_NUMBER },
    items,
  };
  persistSnapshot(path, snapshot, { writeFile, mkdir });
  return path;
}

/**
 * #852's validity rule, ONE COPY: a held snapshot licenses reuse while its file is still on disk and inside the bound.
 * Shared by `withBoardSnapshot` and `scopedStatus` (#1360), whose read the move must be able to reuse.
 * @param {Date} at @param {(path: string) => boolean} exists
 * @returns {(snapshot: { path: string, takenAt: Date } | null | undefined) => boolean}
 */
function snapshotStillValid(at, exists) {
  return (snapshot) => snapshot != null && exists(snapshot.path)
    && at.getTime() - snapshot.takenAt.getTime() < SNAPSHOT_MAX_AGE_MS;
}

/**
 * #1360: ISSUE N'S CURRENT STATUS, READ BY THE SCOPED SNAPSHOT ITS MOVE WOULD TAKE, with the same `gh` request and
 * validity rule `withBoardSnapshot`'s scoped route uses, so the move that follows reuses this read (see
 * `scopedStatusOf`). THROWS when the read fails, so `settleClosedStatus` refuses with the cause.
 * @param {number} issueNumber
 * @param {{ run?: typeof defaultRun, log?: (line: string) => void, exists?: (path: string) => boolean,
 *   writeFile?: (path: string, data: string) => void, mkdir?: (path: string) => void, now?: () => Date }} [deps]
 * @returns {string | null}
 */
export function scopedStatus(issueNumber, deps = {}) {
  const { run = defaultRun, log = (line) => process.stderr.write(`${line}\n`), exists = existsSync, writeFile, mkdir,
    now = () => new Date() } = deps;
  const at = now();
  return scopedStatusOf(issueNumber, { request: (args) => run("gh", args), log, at, now,
    maxAgeMs: SNAPSHOT_MAX_AGE_MS, stillValid: snapshotStillValid(at, exists), writeFile, mkdir });
}

/**
 * Wrap a board-mutating call so it can only run once a real snapshot has been written. `mutate` is never
 * invoked if `writeBoardSnapshot` throws -- that is the whole guarantee this file exists to give, and
 * `board-snapshot.test.ts`'s mutation check proves it by making the write fail and asserting `mutate` was
 * never called.
 *
 * @template T
 * `excludeIssueNumber` passes straight through to `writeBoardSnapshot` (see `readyRowsMissingStatus`'s
 * own header, #891) -- deliberately NOT destructured out alongside `log` above: this function has no
 * opinion on it, it is `moveProjectStatus`'s to set when `mutate` is specifically fixing that one issue's
 * own Status.
 *
 * #1275: `touches` names the issue(s) `mutate` changes. Given, the snapshot is SCOPED to those items -- one
 * request each -- unless a full snapshot this process already holds is still valid (#852's reuse). Absent, the
 * full sweep runs as before. An empty or non-integer `touches` refuses: a mutation cannot touch nothing.
 *
 * #1425: a sweep refused because the token cannot read the Project is refused ONCE per process. Later mutations,
 * on either route, refuse from that record without a request (`readUnlessProjectUnreadable`).
 *
 * @param {() => T} mutate the actual board-mutating call
 * @param {{ run?: typeof defaultRun, fetchReady?: typeof fetchReadyIssueNumbers,
 *   writeFile?: (path: string, data: string) => void, mkdir?: (path: string) => void, now?: () => Date,
 *   log?: (line: string) => void, exists?: (path: string) => boolean,
 *   excludeIssueNumber?: number | null, touches?: number | number[] }} [deps]
 * @returns {T}
 */
export function withBoardSnapshot(mutate, deps = {}) {
  const { log = (line) => process.stdout.write(`${line}\n`), exists = existsSync, touches, ...snapshotDeps } = deps;
  const issues = touchedIssues(touches);
  const now = snapshotDeps.now ?? (() => new Date());
  const at = now();
  const stillValid = snapshotStillValid(at, exists);
  const held = processSnapshot;
  // #852 REUSE RE-READS THE DISK RATHER THAN TRUSTING A REMEMBERED PATH.
  //
  // worker-judge's blocker on #1281, driven: the snapshot was written, `rm -rf runs/` took it, and the
  // next mutation proceeded with nothing behind it. `runs/` is gitignored, so `git clean -xdf` removes
  // it too, and `rm -rf runs/` appears three times in this repo's own comments as a scenario worth
  // defending a corpus from. WITHOUT THIS CHECK THE GUARANTEE MOVES FROM MUTATION TIME TO SWEEP TIME --
  // true of a process's first mutation and false of every reused one, which is not what #399 promises.
  const route = snapshotRoute({ touchedIssues: issues, fullSnapshotValid: held !== null && stillValid(held) });
  if (route === "reuse-full") {
    const reused = /** @type {{ path: string, takenAt: Date }} */ (held);
    log(`board-snapshot: reusing ${reused.path}, taken ${describeAge(at, reused.takenAt)} before this `
      + "mutation -- one sweep per process (#852)");
    return mutate();
  }
  if (route === "scoped") {
    const { run = defaultRun, writeFile, mkdir } = snapshotDeps;
    // #1275: THE ONE `gh` CALL THE SCOPED HALF NEEDS, made here so `board-snapshot-scope.mjs` never names `gh` and
    // its test can run in a job with no token.
    return withScopedSnapshot(mutate, /** @type {number[]} */ (issues), { request: (args) => run("gh", args), log, at,
      now, maxAgeMs: SNAPSHOT_MAX_AGE_MS, stillValid, writeFile, mkdir });
  }
  const path = readUnlessProjectUnreadable(() => writeBoardSnapshot({ ...snapshotDeps, now }), "the board");
  processSnapshot = { path, takenAt: at };
  log(`board-snapshot: wrote ${path} before mutating`);
  return mutate();
}

/**
 * How long ago, in the words the log line needs. Whole seconds: a snapshot's age is never sub-second.
 * @param {Date} at @param {Date} takenAt
 */
function describeAge(at, takenAt) {
  // SUB-SECOND AGES IN MILLISECONDS: rounding two quick mutations to `0s` reads as "no time passed"
  // rather than "under a second", and the age is the field a reader checks against the change it covers.
  const ms = at.getTime() - takenAt.getTime();
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

/**
 * FORGET THE PROCESS'S SNAPSHOT. For tests, and named as such: module state that survives between cases
 * is how one test's arrangement becomes another's silent precondition, and every assertion about "the
 * first mutation" here depends on which mutation was first.
 */
export function forgetProcessSnapshot() {
  processSnapshot = null;
  forgetScopedSnapshots();
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  // Guarded per #164, and takes no flags at all -- this entry point only ever takes a snapshot, it never
  // mutates, so there is nothing for a flag to configure.
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/board-snapshot.mjs" });
  try {
    const path = writeBoardSnapshot();
    process.stdout.write(`wrote ${path}\n`);
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`);
    process.exitCode = 1;
  }
}
