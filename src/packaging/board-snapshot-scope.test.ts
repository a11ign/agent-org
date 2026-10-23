/**
 * #1275: THE SCOPED HALF OF A BOARD SNAPSHOT, TESTED WITHOUT `board-snapshot.ts` -- which is this file's reason to
 * exist. That script used to run `gh`, so any test importing it needed a `token` CI's acceptance job does not have, and
 * #1275's first Acceptance command was refused for exactly that. This file imports the pure module, its pure consumer
 * (`settle-closed-status.ts`) and the closure walk that refused; the first two tests hold that line.
 *
 * A11-160, step 8: the item of one issue on the project is the CODE HOST's read (`touchedItemTextOf` of its rows), so the cases that hold what the scoped snapshot DECIDES (its route, its file, its reuse, the memory of a
 * Project the token cannot read, the count of reads a close costs) run on the fake code host: a case seeds the rows (on the board or off it, at a Status) and counts the reads the snapshot asked of the rows. The query, its
 * variables and the shape of GitHub's answer are the plugin's (`plugins/github/rows/board-snapshot-rows.test.ts`, which also holds the fake to the shape of the captured live responses). THE CASES THAT STAY AT THE SEAM hand
 * the snapshot an answer no row renders -- a response about a different issue, a list shorter than its own count, text that is not JSON, errors beside data, and the CAPTURED live responses -- through an injected `request`
 * on the real operation, which returns GitHub's text untouched.
 *
 * THE ASSERTIONS ARE ON THE REQUESTS, as #852's are: a snapshot's contents cannot show what reading it cost.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECT_NUMBER,
  PROJECT_OWNER,
  SNAPSHOT_DIR,
  forgetScopedSnapshots,
  readTouchedItems,
  snapshotRoute,
  touchedIssues,
  scopedStatusOf,
  withScopedSnapshot,
  writeScopedSnapshot,
} from "../board-snapshot-scope.ts";
import { refusalCause, PROJECT_UNREADABLE, settleClosedStatus } from "../settle-closed-status.ts";
import { closureRequirementMessage, deriveClosureRequirements } from "../acceptance-commands/command-classes-and-declarations.ts";
import { REPO } from "../project-identity.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
// The code host slot itself, not `plugins/active.ts`: that one reaches the gate's helpers and with them a `token` this file's closure must not carry (the second test holds the line).
import { forgetSlot, substituteHost } from "../plugins/code-host-slot.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";

afterEach(() => forgetSlot());

// Resolved from this file, never a path typed from the project's root: the tool sits at `packages/agent-org/` in the project and at the
// root of its own checkout, and a typed path that names no file makes `deriveClosureRequirements` answer `[]` -- a clean reading of nothing.
const THIS_FILE = fileURLToPath(import.meta.url);
const SNAPSHOT_SCRIPT = fileURLToPath(new URL("../board-snapshot.ts", import.meta.url));

/**
 * Captured LIVE 2026-09-18 against the ORG board: #1452, on `a11ign/projects/1` at "Ready".
 *
 * IT USED TO BE #1275 ON PROJECT 2, and it could not simply be re-pointed. #63 moved the repository
 * to an organisation; the user-level Project 2 stayed behind, and on the org board #1275 has no item
 * at all (`totalCount: 0`), so it cannot stand for an issue ON the board any more. Re-capturing the
 * OLD fixture under the new accessor would have been writing a response the API never returned --
 * which is the one thing a file of captures must not contain. So the subject moved to an issue that
 * genuinely is on the org board, and the old capture went with the board it described.
 */
const CAPTURED_ON_BOARD = "{\"data\":{\"organization\":{\"projectV2\":{\"id\":\"PVT_kwDOExeOA84Bj5SX\"}},\"repository\":{\"issue\":{\"number\":1452,\"title\":\"release.yml's dry run cannot print versions when dispatched on a branch: changeset status needs main (Failed to find where HEAD diverged from main, run 34783509737) -- or the job must say so before the gate\",\"state\":\"OPEN\",\"projectItems\":{\"totalCount\":1,\"nodes\":[{\"id\":\"PVTI_lADOExeOA84Bj5SXzg7knyc\",\"project\":{\"number\":1},\"fieldValueByName\":{\"name\":\"Ready\"}}]}}}}}";
/** Captured: #393, closed and never added to Project 2 -- the row #400's not-on-board wording was measured on. */
const CAPTURED_OFF_BOARD = "{\"data\":{\"organization\":{\"projectV2\":{\"id\":\"PVT_kwDOExeOA84Bj5SX\"}},\"repository\":{\"issue\":{\"number\":393,\"title\":\"pre-push hook runs doc-references.test.ts without generating docs/coverage.md first, unlike CI's docs job\",\"state\":\"CLOSED\",\"projectItems\":{\"totalCount\":0,\"nodes\":[]}}}}}";
/** Captured: the same query naming project 999. `gh` exited 1 and printed this on stdout. */
const CAPTURED_NO_PROJECT = "{\"data\":{\"organization\":{\"projectV2\":null},\"repository\":{\"issue\":{\"number\":1275,\"title\":\"GraphQL budget exhausted 2026-09-13 11:2xZ, consumer unknown — and gh api rate_limit reported 5000 remaining while every call was refused\",\"state\":\"CLOSED\",\"projectItems\":{\"totalCount\":0,\"nodes\":[]}}}},\"errors\":[{\"type\":\"NOT_FOUND\",\"path\":[\"organization\",\"projectV2\"],\"locations\":[{\"line\":3,\"column\":27}],\"message\":\"Could not resolve to a ProjectV2 with the number 999.\"}]}";

/** A response of the captured shape for any issue, for a case that hands the snapshot a text at the seam. The plugin's test pins the fake's rendering to the captures. */
function touched(issue: number, { onBoard = true, status = "In progress", totalCount }:
  { onBoard?: boolean; status?: string; totalCount?: number } = {}) {
  const nodes = onBoard ? [{ id: `PVTI_${issue}`, project: { number: 1 }, fieldValueByName: { name: status } }] : [];
  return JSON.stringify({ data: { organization: { projectV2: { id: "PVT_kwHOAsR0u84BinDJ" } }, repository: { issue: {
    number: issue, title: `row ${issue}`, state: "OPEN", projectItems: { totalCount: totalCount ?? nodes.length, nodes },
  } } } });
}

/** A `request` at the seam recording every argv, answering each touched read with `answer`. */
function requestOf(answer: (issue: number) => string = (issue) => touched(issue)) {
  const argv: string[][] = [];
  const request = (args: string[]) => {
    argv.push(args);
    const issue = args.find((arg) => arg.startsWith("issue="));
    return answer(Number(issue?.slice("issue=".length)));
  };
  return { request, argv };
}

/** The `request` a case on the fake hands: the code host's fake ignores the run it is given, so one that is reached is a mistake. */
const NO_REQUEST = (): string => { throw new Error("the fake code host answers from its world, never through the request it is handed"); };

/** A process that failed as `gh` does: its message, its exit status, and the response body it printed before exiting on `.stdout`. */
const failedProcess = (message: string, stdout?: string) => Object.assign(new Error(message), { status: 1, ...(stdout === undefined ? {} : { stdout }) });

/**
 * The fake code host in place with its operations WATCHED, and its world. `reads()` is how many times the snapshot asked the code host for an issue's item, `asked()` which issues.
 * `facts` seeds each of `issues` (an item on the board at `status`, or off it) or makes the read fail as the world says.
 */
function board(issues: number[] = [], facts: { status?: string; onBoard?: boolean; failure?: Error } = {}) {
  const host = createFakeCodeHost();
  const watched = watchedRows(host);
  substituteHost(watched.host);
  const world = host.rowsWorld;
  for (const issue of issues) world.rows.set(issue, fakeRow(world, issue, { title: `Row ${issue}`, onBoard: facts.onBoard ?? true, boardStatus: facts.onBoard === false ? null : facts.status ?? "In progress" }));
  if (facts.failure !== undefined) world.failures.set("touchedItemTextOf", facts.failure);
  const asked = () => watched.calls.filter((call) => call.op === "touchedItemTextOf").map((call) => call.request.issue as number);
  return { world, calls: watched.calls, asked, reads: () => asked().length };
}

const BOUND_MS = 5 * 60 * 1000;
const AT = new Date("2026-09-13T19:00:00.000Z");

/**
 * The context `withBoardSnapshot` passes. `stillValid` stands in for that file's own predicate, which its #852 tests
 * hold: valid while the file is on this in-memory disk and inside the bound.
 */
function contextOf(request: (args: string[]) => string, overrides: { at?: Date; disk?: Set<string>;
  log?: (line: string) => void; writeFile?: (path: string, data: string) => void } = {}) {
  const at = overrides.at ?? AT;
  const disk = overrides.disk ?? new Set<string>();
  return {
    request, at, now: () => at, maxAgeMs: BOUND_MS, mkdir: () => {}, log: overrides.log ?? (() => {}),
    writeFile: overrides.writeFile ?? ((path: string) => { disk.add(path); }),
    stillValid: (snapshot?: { path: string; takenAt: Date }) => snapshot !== undefined && disk.has(snapshot.path)
      && at.getTime() - snapshot.takenAt.getTime() < BOUND_MS,
  };
}

test("#1275: this file imports NOTHING from board-snapshot.ts -- the import that refused the row's acceptance", () => {
  // ceo's condition: not even a constant. Read from this file's own import statements, not from a list typed here.
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/^(?:import\s[^;]*?|\}\s*)from\s+"([^"]+)";/gm)].map((match) => match[1]);
  assert.ok(specifiers.includes("../board-snapshot-scope.ts"),
    "CONTROL: the reader finds this file's real imports, so an empty list cannot pass for a clean one");
  assert.deepEqual(specifiers.filter((specifier) => /(^|\/)board-snapshot\.ts$/.test(specifier)), []);
});

test("#1275: this file's closure needs no token -- POSITIVE CONTROL: the same walk still charges a script that spawns the code host's program", () => {
  assert.deepEqual(deriveClosureRequirements(THIS_FILE).map((hit) => closureRequirementMessage(hit)), [],
    "the acceptance job has no token, no fleet and no corpus");
  // A11-160: the call this walk used to charge board-snapshot.ts for moved into the code host, so the control is a script that makes it. The program is named through a join, never as a literal call in this file.
  const spawner = join(tmpDir("scope-closure-"), "spawner.ts");
  writeFileSync(spawner, `import { execFileSync } from "node:child_process";\nexecFileSync("${["g", "h"].join("")}", ["api", "user"]);\n`);
  const charged = deriveClosureRequirements(spawner);
  assert.ok(charged.some((hit) => hit.requirement === "token" && hit.file === spawner),
    `the walk that passes this file must still see a spawn of the code host's program, or passing proves nothing -- got ${JSON.stringify(charged)}`);
  assert.deepEqual(deriveClosureRequirements(SNAPSHOT_SCRIPT).filter((hit) => hit.requirement === "token"), [],
    "and board-snapshot.ts itself holds no such call any more: the item reads are the code host's (A11-160, step 8)");
});

test("#1275: the item of one touched issue is asked of the code host for the declared project and repository -- and the request never names gh", () => {
  const { asked, calls } = board([1275]);
  readTouchedItems([1275], { request: NO_REQUEST });
  assert.deepEqual(asked(), [1275]);
  const { request } = calls[0];
  assert.deepEqual({ owner: request.owner, repo: request.repo, project: request.project, issue: request.issue }, { owner: PROJECT_OWNER, repo: REPO, project: PROJECT_NUMBER, issue: 1275 });
  assert.equal(PROJECT_OWNER, "a11ign");
  assert.equal(PROJECT_NUMBER, 1);
  assert.equal(request.run, NO_REQUEST, "the snapshot's own request is the run the operation is handed: the caller adds the program");
});

test("#1275: readTouchedItems asks once per touched issue and reads the item and the Status off the world", () => {
  const { world, asked } = board();
  world.rows.set(1452, fakeRow(world, 1452, { title: "an issue on the board", onBoard: true, boardStatus: "Ready" }));
  world.rows.set(393, fakeRow(world, 393, { state: "CLOSED" }));
  assert.deepEqual(readTouchedItems([1452, 393], { request: NO_REQUEST }), {
    items: [{ itemId: "PVTI_1452", number: 1452, title: "an issue on the board", status: "Ready", state: "OPEN" }],
    notOnBoard: [393],
  });
  assert.deepEqual(asked(), [1452, 393]);
});

test("#1275 (at the seam): readTouchedItems reads the CAPTURED live responses -- the on-board item with its Status, and the closed row with no item at all", () => {
  const { request, argv } = requestOf((issue) => (issue === 1452 ? CAPTURED_ON_BOARD : CAPTURED_OFF_BOARD));
  assert.deepEqual(readTouchedItems([1452, 393], { request }), {
    items: [{ itemId: "PVTI_lADOExeOA84Bj5SXzg7knyc", number: 1452,
      title: JSON.parse(CAPTURED_ON_BOARD).data.repository.issue.title, status: "Ready", state: "OPEN" }],
    notOnBoard: [393],
  });
  assert.equal(argv.length, 2, "one request each");
});

test("#1275 ACCEPTANCE: a mutation that names its item is ROUTED to a scoped snapshot, and that snapshot costs ONE request", () => {
  assert.equal(snapshotRoute({ touchedIssues: [725], fullSnapshotValid: false }), "scoped",
    "the full route is 6 board pages and a ready-issue list at today's 555 items (board-snapshot.test.ts counts it)");
  forgetScopedSnapshots();
  const { asked, calls } = board([725]);
  let ran = false;
  withScopedSnapshot(() => { ran = true; }, [725], contextOf(NO_REQUEST));
  assert.equal(ran, true, "the mutation still runs -- this is a cost fix, not a skip");
  assert.deepEqual(asked(), [725], "one request: #725's item, and nothing else on the board");
  assert.equal(calls.length, 1, "and no other read of the code host: no board page, no ready list");
});

test("#1275 CONTROL: a snapshot is still WRITTEN and PRINTED before the mutation runs", () => {
  // Unaffected by the route, which is what makes it the row's control: send a named item down the full route and the
  // ACCEPTANCE above goes red while this stays green.
  forgetScopedSnapshots();
  board([725]);
  const order: string[] = [];
  withScopedSnapshot(() => { order.push("mutate"); }, [725], contextOf(NO_REQUEST, {
    writeFile: () => { order.push("write"); }, log: (line) => { order.push(line); } }));
  assert.equal(order[0], "write", "one snapshot written -- never #399's guarantee deleted");
  // #1352: the logged path is absolute now (the git common dir's checkout), so it is matched against the exported directory.
  assert.match(order[1] ?? "", new RegExp(`^board-snapshot: wrote ${SNAPSHOT_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\S+\\.json before mutating`),
    "and printed");
  assert.equal(order[2], "mutate", "and only then the mutation");
  assert.equal(order.length, 3);
});

test("#1275: the route -- a held full snapshot covers anything, and a mutation that names nothing still gets the full sweep", () => {
  assert.equal(snapshotRoute({ touchedIssues: null, fullSnapshotValid: false }), "full");
  assert.equal(snapshotRoute({ touchedIssues: null, fullSnapshotValid: true }), "reuse-full");
  assert.equal(snapshotRoute({ touchedIssues: [725], fullSnapshotValid: true }), "reuse-full", "#852's reuse is kept");
});

test("#1275: the scoped file is named for its item, records it, and says it is not the board", () => {
  forgetScopedSnapshots();
  board([725]);
  const written: Array<{ path: string; data: string }> = [];
  const log: string[] = [];
  withScopedSnapshot(() => {}, [725], contextOf(NO_REQUEST, {
    writeFile: (path, data) => { written.push({ path, data }); }, log: (line) => { log.push(line); } }));
  assert.equal(written.length, 1);
  assert.equal(written[0].path, `${SNAPSHOT_DIR}/2026-09-13T19-00-00-000Z-issue-725.json`);
  const parsed = JSON.parse(written[0].data);
  assert.deepEqual(parsed.scope, { issues: [725] });
  assert.deepEqual(parsed.project, { owner: "a11ign", number: 1 });
  assert.deepEqual(parsed.items, [{ itemId: "PVTI_725", number: 725, title: "Row 725", status: "In progress", state: "OPEN" }]);
  assert.deepEqual(parsed.notOnBoard, []);
  assert.match(parsed.takenBefore, /SCOPED to the item\(s\) that mutation touches, not the whole board \(#1275\).*within 300s/s,
    "and the file says so, so nobody takes it for the board");
  assert.match(log.join("\n"), new RegExp(`wrote ${SNAPSHOT_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/2026-09-13T19-00-00-000Z-issue-725\\.json before mutating #725`));
});

test("#1275: an issue NOT on the board is recorded as such, and the mutation still runs so gh can say so", () => {
  forgetScopedSnapshots();
  board([393], { onBoard: false });
  const written: string[] = [];
  let ran = false;
  withScopedSnapshot(() => { ran = true; }, [393], contextOf(NO_REQUEST, {
    writeFile: (_path, data) => { written.push(data); } }));
  assert.equal(ran, true, "`gh project item-edit` names a row that is not on the board, and moveProjectStatus reads "
    + "that as notOnBoard (#400) -- refusing here would replace that wording with this file's");
  assert.deepEqual(JSON.parse(written[0]).items, []);
  assert.deepEqual(JSON.parse(written[0]).notOnBoard, [393]);
});

test("#1275: a token that cannot read the Project is REFUSED, and the close path still classifies it as project-unreadable", () => {
  forgetScopedSnapshots();
  const fake = board([1275], { failure: failedProcess("Command failed: gh api graphql ...", CAPTURED_NO_PROJECT) });
  let ran = false;
  let message = "";
  try {
    withScopedSnapshot(() => { ran = true; }, [1275], contextOf(NO_REQUEST));
  } catch (error) {
    message = (error as Error).message;
  }
  assert.equal(ran, false, "no snapshot, no mutation (#399)");
  assert.equal(fake.reads(), 1);
  assert.match(message, /NOT_FOUND \(organization\.projectV2\): Could not resolve to a ProjectV2 with the number 999/,
    "GraphQL's own error, read off the failed process's stdout (#555)");
  assert.equal(refusalCause(`could not move #1275's Status to "Done" -- ${message}`), PROJECT_UNREADABLE,
    "settle-closed-status.ts's own classifier: #546's bridge reads this cause, and a scoped read must still produce it");
  assert.equal(refusalCause("could not move #1275's Status to \"Done\" -- board-snapshot: gh's response for #1275 "
    + "did not have the shape"), "other", "CONTROL: the classifier is not satisfied by any board-snapshot refusal");
});

test("#1275 (at the seam): the SAME captured error on a zero exit -- errors beside data -- is refused before data is read", () => {
  forgetScopedSnapshots();
  let ran = false;
  assert.throws(() => withScopedSnapshot(() => { ran = true; }, [1275], contextOf(() => CAPTURED_NO_PROJECT)),
    /GraphQL returned an error alongside its response.*NOT_FOUND \(organization\.projectV2\)/s);
  assert.equal(ran, false);
});

test("#1275 (at the seam): an answer about a different issue, a list shorter than its own count, or not JSON is refused -- never 'not on the board'", () => {
  forgetScopedSnapshots();
  assert.throws(() => withScopedSnapshot(() => {}, [725], contextOf(requestOf(() => touched(999)).request)),
    /did not have the shape .* for that issue/s);
  assert.throws(() => withScopedSnapshot(() => {}, [725], contextOf(requestOf((n) => touched(n, { totalCount: 2 })).request)),
    /came back 1 of 2 -- refusing to read a partial list as "not on the board"/);
  assert.throws(() => withScopedSnapshot(() => {}, [725], contextOf(requestOf(() => "not json").request)),
    /response for #725 was not JSON/);
});

test("#1275: a second move of the SAME item reuses its scoped snapshot; a different item takes its own", () => {
  forgetScopedSnapshots();
  const fake = board([725, 726]);
  const context = contextOf(NO_REQUEST);
  withScopedSnapshot(() => {}, [725], context);
  withScopedSnapshot(() => {}, [725], context);
  assert.equal(fake.reads(), 1, "a claim then a decline of one row: one read");
  withScopedSnapshot(() => {}, [726], context);
  assert.equal(fake.reads(), 2, "a scoped file never licenses a mutation of a different item");
});

test("#1275: a scoped snapshot deleted from disk, or past the bound, is read again", () => {
  forgetScopedSnapshots();
  const fake = board([725]);
  const disk = new Set<string>();
  const at = (ms: number) => contextOf(NO_REQUEST, { disk, at: new Date(AT.getTime() + ms) });
  withScopedSnapshot(() => {}, [725], at(0));
  withScopedSnapshot(() => {}, [725], at(1000));
  assert.equal(fake.reads(), 1, "still on disk and inside the bound: reused");
  disk.clear(); // `rm -rf runs/`
  withScopedSnapshot(() => {}, [725], at(2000));
  assert.equal(fake.reads(), 2, "the file is gone, so the reuse is not taken -- #852's disk re-read, per item");
  withScopedSnapshot(() => {}, [725], at(2000 + BOUND_MS));
  assert.equal(fake.reads(), 3, "past the bound: a fresh read");
});

test("#1275: #399's guarantee holds on the scoped path -- a failed write means the mutation never runs", () => {
  forgetScopedSnapshots();
  board([725]);
  let ran = false;
  assert.throws(() => withScopedSnapshot(() => { ran = true; }, [725], contextOf(NO_REQUEST, {
    writeFile: () => { throw new Error("read-only filesystem"); } })), /could not write the snapshot .*refusing to proceed/s);
  assert.equal(ran, false);
});

test("#1275: `touches` names issues or nothing -- anything else refuses, before any request", () => {
  assert.equal(touchedIssues(undefined), null);
  assert.deepEqual(touchedIssues(725), [725]);
  assert.deepEqual(touchedIssues([725, 726]), [725, 726]);
  for (const touches of [[], 7.5, [725, Number.NaN], "725"]) {
    assert.throws(() => touchedIssues(touches), /`touches` must name the issue\(s\) this mutation changes/,
      JSON.stringify(touches));
  }
  forgetScopedSnapshots();
  const fake = board([725]);
  let ran = false;
  assert.throws(() => withScopedSnapshot(() => { ran = true; }, [], contextOf(NO_REQUEST)), /`touches` must name/);
  assert.equal(ran, false, "an empty list is vacuously 'every one held' -- a mutation with no snapshot behind it");
  assert.equal(fake.calls.length, 0);
});

test("#1275: one scoped snapshot of several issues names them all, in the file and its name", () => {
  board([725, 726]);
  const written: Array<{ path: string; data: string }> = [];
  const path = writeScopedSnapshot([725, 726], { request: NO_REQUEST, maxAgeMs: BOUND_MS, mkdir: () => {},
    writeFile: (p, data) => { written.push({ path: p, data }); }, now: () => AT });
  assert.equal(path, `${SNAPSHOT_DIR}/2026-09-13T19-00-00-000Z-issue-725-726.json`);
  assert.deepEqual(JSON.parse(written[0].data).items.map((item: { number: number }) => item.number), [725, 726]);
});

// --- #1360: settling a closed row reads its Status ONCE, and a row already at Done issues no mutation ---
//
// ceo's ruling: done-when 1 holds only as a measured count. Each case drives settleClosedStatus with the lookup and a
// move built the way the entry points build them -- scopedStatusOf for the Status, and withScopedSnapshot around the
// mutation as moveProjectStatus does (#1275) -- and counts every request and every mutation. Counts, not floors.

/** A move shaped like moveProjectStatus: the mutation inside withScopedSnapshot, a throw reported as a refusal. */
function moveThroughScope(context: ReturnType<typeof contextOf>, counter: { mutations: number }) {
  return (n: number, status: string) => {
    try {
      withScopedSnapshot(() => { counter.mutations += 1; }, [n], context);
      return { moved: true as const };
    } catch (error) {
      return { moved: false as const, notOnBoard: false, reason: `could not move #${n}'s Status to "${status}" -- ${(error as Error).message}` };
    }
  };
}

/** A fresh scoped record, the fake board seeded with `issues` as `facts` say, the context built on it, and a mutation counter. */
function scopedRun(issues: number[], facts: Parameters<typeof board>[1]) {
  forgetScopedSnapshots();
  const fake = board(issues, facts);
  return { fake, context: contextOf(NO_REQUEST), counter: { mutations: 0 } };
}

function settleCounted(n: number, facts: Parameters<typeof board>[1], { lookup = true } = {}) {
  const { fake, context, counter } = scopedRun([n], facts);
  const outcome = settleClosedStatus(n, { moveStatus: moveThroughScope(context, counter), log: () => {},
    ...(lookup ? { currentStatus: (issue: number) => scopedStatusOf(issue, context) } : {}) });
  return { requests: fake.reads(), mutations: counter.mutations, outcome };
}

test("#1360 DONE-WHEN 1, measured: a row already at Done costs exactly 1 request and 0 mutations", () => {
  const { requests, mutations, outcome } = settleCounted(1298, { status: "Done" });
  assert.equal(requests, 1);
  assert.equal(mutations, 0);
  assert.deepEqual(outcome, { settled: true, refused: [] });
});

test("#1360 DONE-WHEN 1, measured: a row at a live Status costs exactly 1 request and 1 mutation -- the move reuses the read", () => {
  const { requests, mutations, outcome } = settleCounted(1393, { status: "In progress" });
  assert.equal(requests, 1, "the move reused the read the lookup took; two here would be a second read per row");
  assert.equal(mutations, 1);
  assert.deepEqual(outcome, { settled: true, refused: [] });
});

test("#1360 DONE-WHEN 1, measured: an unreadable Project costs exactly 1 request, 0 mutations, and refuses project-unreadable", () => {
  const { requests, mutations, outcome } = settleCounted(1332, { failure: failedProcess("Command failed: gh api graphql", CAPTURED_NO_PROJECT) });
  assert.equal(requests, 1, "the move never read again after the lookup's read failed");
  assert.equal(mutations, 0);
  assert.equal(outcome.settled, false);
  assert.equal(outcome.refused[0].cause, PROJECT_UNREADABLE);
});

test("#1360 CONTROL, today's cost: the same Done row settled WITHOUT the lookup costs 1 request and 1 mutation", () => {
  // What the three counts above are measured against: the mutation the lookup saves is this one.
  const { requests, mutations } = settleCounted(1298, { status: "Done" }, { lookup: false });
  assert.equal(requests, 1);
  assert.equal(mutations, 1);
});

test("#1360 a row NOT on the board reads as null and is moved as before, still on the one read", () => {
  const { requests, mutations } = settleCounted(393, { onBoard: false });
  assert.equal(requests, 1);
  assert.equal(mutations, 1, "null is not Done: the move runs, and gh's own 'is not an item' answer settles it");
});

// --- #1425: a Project the token cannot read is refused ONCE per process, not once per row ---------------------------
//
// closeRows job 103788334114 (trunk run 34781170721): 7 rows settled against a Project CI's token cannot read (#546),
// each with its own failed read. #1360 cut each row to one read, and nothing recorded the refusal, so the next row read
// again. A project-unreadable refusal is a fact about the token and the Project rather than about an item, so it
// answers every later read in the process. Counts, not floors.

const SEVEN_ROWS = [1393, 1332, 1267, 1400, 1394, 1350, 1384];

/** The Project as CI's token meets it (#546): the read fails with exit 1 and GraphQL's NOT_FOUND on stdout. */
const unreadableProject = { failure: failedProcess("Command failed: gh api graphql", CAPTURED_NO_PROJECT) };

/** The close path over `rows` in ONE process: one scoped context, and the lookup and move as the entry points build them. */
function settleRows(rows: number[], facts: Parameters<typeof board>[1]) {
  const { fake, context, counter } = scopedRun(rows, facts);
  const outcomes = rows.map((n) => settleClosedStatus(n, { moveStatus: moveThroughScope(context, counter),
    log: () => {}, currentStatus: (issue: number) => scopedStatusOf(issue, context) }));
  return { requests: fake.reads(), mutations: counter.mutations, outcomes };
}

test("#1425 DONE-WHEN 2, measured: 7 rows against an unreadable Project make ONE request, and all 7 refuse project-unreadable", () => {
  const { requests, mutations, outcomes } = settleRows(SEVEN_ROWS, unreadableProject);
  assert.equal(requests, 1, "the first row's refused read is recorded, and the other six refuse from the record");
  assert.equal(mutations, 0);
  assert.deepEqual(outcomes.map((outcome) => outcome.refused.map((refusal) => refusal.cause)),
    SEVEN_ROWS.map(() => [PROJECT_UNREADABLE]),
    "every row still refuses with the cause #546's DEGRADED bridge reads; a record that lost it would fail the run");
});

test("#1425: the MOVE's own scoped read honours the record too -- 7 moves with no lookup make ONE request", () => {
  const { fake, context } = scopedRun(SEVEN_ROWS, unreadableProject);
  let mutations = 0;
  const messages = SEVEN_ROWS.map((n) => {
    try {
      withScopedSnapshot(() => { mutations += 1; }, [n], context);
      return "mutated";
    } catch (error) {
      return (error as Error).message;
    }
  });
  assert.equal(fake.reads(), 1);
  assert.equal(mutations, 0, "no snapshot, no mutation (#399), for a recorded refusal as for the first");
  assert.deepEqual(messages.map((message) => refusalCause(message)), SEVEN_ROWS.map(() => PROJECT_UNREADABLE));
  assert.match(messages[1], /not reading Project 1 again for #1332 -- an earlier read in this process was refused/,
    "a refusal from the record says it made no request, so nobody reads it as a second failed read");
});

test("#1425 CONTROL: a failure that is NOT project-unreadable is not recorded -- 7 rows still make 7 requests", () => {
  const { requests, outcomes } = settleRows(SEVEN_ROWS, { failure: failedProcess("Command failed: gh api graphql\nerror connecting to api.github.com") });
  assert.equal(requests, 7, "a transient failure on one item says nothing about the next, so each is read");
  assert.deepEqual(outcomes.map((outcome) => outcome.refused.map((refusal) => refusal.cause)), SEVEN_ROWS.map(() => ["other"]));
});

test("#1425 POSITIVE CONTROL: a readable board still reads each row once and moves it -- 7 rows, 7 requests, 7 mutations", () => {
  const { requests, mutations, outcomes } = settleRows(SEVEN_ROWS, { status: "In progress" });
  assert.equal(requests, 7, "one scoped read per row, which that row's move reuses (#1360)");
  assert.equal(mutations, 7);
  assert.ok(outcomes.every((outcome) => outcome.settled));
});

test("#1425: forgetting the process's snapshots forgets the record, so the next read asks again", () => {
  settleRows([1393], unreadableProject);
  const { requests, outcomes } = settleRows([1393], { status: "Done" });
  assert.equal(requests, 1, "a record that survived the reset would refuse a readable board without asking");
  assert.deepEqual(outcomes, [{ settled: true, refused: [] }]);
});
