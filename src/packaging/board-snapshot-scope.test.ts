/**
 * #1275: THE SCOPED HALF OF A BOARD SNAPSHOT, TESTED WITHOUT `board-snapshot.mjs` -- which is this file's reason to
 * exist. That script runs `gh`, so any test importing it needs a `token` CI's acceptance job does not have, and
 * #1275's first Acceptance command was refused for exactly that. This file imports the pure module, its pure consumer
 * (`settle-closed-status.mjs`) and the closure walk that refused; the first two tests hold that line.
 *
 * The three CAPTURED responses are what `TOUCHED_ITEM_QUERY` itself returned live on 2026-09-13 (gh 2.100.0),
 * verbatim. THE ASSERTIONS ARE ON THE REQUESTS, as #852's are: a snapshot's contents cannot show what reading it cost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROJECT_NUMBER,
  PROJECT_OWNER,
  SNAPSHOT_DIR,
  TOUCHED_ITEM_QUERY,
  forgetScopedSnapshots,
  readTouchedItems,
  snapshotRoute,
  touchedIssues,
  touchedItemRequest,
  scopedStatusOf,
  withScopedSnapshot,
  writeScopedSnapshot,
} from "../../../../scripts/board-snapshot-scope.mjs";
import { refusalCause, PROJECT_UNREADABLE, settleClosedStatus } from "../../../../scripts/settle-closed-status.mjs";
import { closureRequirementMessage, deriveClosureRequirements } from "../../../../scripts/acceptance-commands.mjs";

const THIS_FILE = "packages/lab/src/packaging/board-snapshot-scope.test.ts";

/** Captured: #1275, on Project 2 at "In progress". */
const CAPTURED_ON_BOARD = "{\"data\":{\"user\":{\"projectV2\":{\"id\":\"PVT_kwHOAsR0u84BinDJ\"}},\"repository\":{\"issue\":{\"number\":1275,\"title\":\"GraphQL budget exhausted 2026-09-13 11:2xZ, consumer unknown — and gh api rate_limit reported 5000 remaining while every call was refused\",\"state\":\"OPEN\",\"projectItems\":{\"totalCount\":1,\"nodes\":[{\"id\":\"PVTI_lAHOAsR0u84BinDJzg6uCZo\",\"project\":{\"number\":2},\"fieldValueByName\":{\"name\":\"In progress\"}}]}}}}}";
/** Captured: #393, closed and never added to Project 2 -- the row #400's not-on-board wording was measured on. */
const CAPTURED_OFF_BOARD = "{\"data\":{\"user\":{\"projectV2\":{\"id\":\"PVT_kwHOAsR0u84BinDJ\"}},\"repository\":{\"issue\":{\"number\":393,\"title\":\"pre-push hook runs doc-references.test.ts without generating docs/coverage.md first, unlike CI's docs job\",\"state\":\"CLOSED\",\"projectItems\":{\"totalCount\":0,\"nodes\":[]}}}}}";
/** Captured: the same query naming project 999. `gh` exited 1 and printed this on stdout. */
const CAPTURED_NO_PROJECT = "{\"data\":{\"user\":{\"projectV2\":null},\"repository\":{\"issue\":{\"number\":1275,\"title\":\"GraphQL budget exhausted 2026-09-13 11:2xZ, consumer unknown — and gh api rate_limit reported 5000 remaining while every call was refused\",\"state\":\"OPEN\",\"projectItems\":{\"totalCount\":1,\"nodes\":[{\"id\":\"PVTI_lAHOAsR0u84BinDJzg6uCZo\",\"project\":{\"number\":2},\"fieldValueByName\":{\"name\":\"In progress\"}}]}}}},\"errors\":[{\"type\":\"NOT_FOUND\",\"path\":[\"user\",\"projectV2\"],\"locations\":[{\"line\":3,\"column\":27}],\"message\":\"Could not resolve to a ProjectV2 with the number 999.\"}]}";

/** A response of the captured shape for any issue. The shape test below pins it to the captures. */
function touched(issue: number, { onBoard = true, status = "In progress", totalCount }:
  { onBoard?: boolean; status?: string; totalCount?: number } = {}) {
  const nodes = onBoard ? [{ id: `PVTI_${issue}`, project: { number: 2 }, fieldValueByName: { name: status } }] : [];
  return JSON.stringify({ data: { user: { projectV2: { id: "PVT_kwHOAsR0u84BinDJ" } }, repository: { issue: {
    number: issue, title: `row ${issue}`, state: "OPEN", projectItems: { totalCount: totalCount ?? nodes.length, nodes },
  } } } });
}

/** Keys and value types, recursively -- what a fixture must share with the response it stands in for. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]));
  }
  return value === null ? "null" : typeof value;
}

/** A `request` recording every argv, answering each touched read with `answer`. */
function requestOf(answer: (issue: number) => string = (issue) => touched(issue)) {
  const argv: string[][] = [];
  const request = (args: string[]) => {
    argv.push(args);
    const issue = args.find((arg) => arg.startsWith("issue="));
    return answer(Number(issue?.slice("issue=".length)));
  };
  return { request, argv };
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

test("#1275: this file imports NOTHING from board-snapshot.mjs -- the import that refused the row's acceptance", () => {
  // ceo's condition: not even a constant. Read from this file's own import statements, not from a list typed here.
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/^(?:import\s[^;]*?|\}\s*)from\s+"([^"]+)";/gm)].map((match) => match[1]);
  assert.ok(specifiers.includes("../../../../scripts/board-snapshot-scope.mjs"),
    "CONTROL: the reader finds this file's real imports, so an empty list cannot pass for a clean one");
  assert.deepEqual(specifiers.filter((specifier) => /(^|\/)board-snapshot\.mjs$/.test(specifier)), []);
});

test("#1275: this file's closure needs no token -- POSITIVE CONTROL: the same walk still charges board-snapshot.mjs for its gh call", () => {
  assert.deepEqual(deriveClosureRequirements(THIS_FILE).map((hit) => closureRequirementMessage(hit)), [],
    "the acceptance job has no token, no fleet and no corpus");
  const snapshotScript = deriveClosureRequirements("scripts/board-snapshot.mjs");
  assert.ok(snapshotScript.some((hit) => hit.requirement === "token" && hit.file === "scripts/board-snapshot.mjs"),
    "the walk that passes this file must still see the gh call left in board-snapshot.mjs, or passing proves "
    + `nothing -- got ${JSON.stringify(snapshotScript)}`);
});

test("#1275: the fixture builder models the shape TOUCHED_ITEM_QUERY returned live, on and off the board", () => {
  assert.deepEqual(shapeOf(JSON.parse(touched(1275))), shapeOf(JSON.parse(CAPTURED_ON_BOARD)));
  assert.deepEqual(shapeOf(JSON.parse(touched(393, { onBoard: false }))), shapeOf(JSON.parse(CAPTURED_OFF_BOARD)));
  // What no stub can see, and the captures were read through: the request names the Project, whose refusal the close
  // path classifies, and asks for the count a short list is checked against.
  assert.match(TOUCHED_ITEM_QUERY, /user\(login: \$owner\) \{ projectV2\(number: \$project\) \{ id \} \}/);
  assert.match(TOUCHED_ITEM_QUERY, /projectItems\(first: 10\) \{\s+totalCount/);
});

test("#1275: the request for one touched issue is the query and its four variables -- and it never names gh", () => {
  assert.deepEqual(touchedItemRequest(1275), ["api", "graphql", "-f", `query=${TOUCHED_ITEM_QUERY}`,
    "-f", "owner=DanBeckDev", "-f", "name=a11y-witness", "-F", "project=2", "-F", "issue=1275"]);
  assert.equal(PROJECT_OWNER, "DanBeckDev");
  assert.equal(PROJECT_NUMBER, 2);
  assert.ok(!touchedItemRequest(1275).includes("gh"), "the caller adds gh -- board-snapshot.test.ts's #1275 WIRING");
});

test("#1275: readTouchedItems asks once per touched issue and reads the captured responses", () => {
  const { request, argv } = requestOf((issue) => (issue === 1275 ? CAPTURED_ON_BOARD : CAPTURED_OFF_BOARD));
  assert.deepEqual(readTouchedItems([1275, 393], { request }), {
    items: [{ itemId: "PVTI_lAHOAsR0u84BinDJzg6uCZo", number: 1275,
      title: JSON.parse(CAPTURED_ON_BOARD).data.repository.issue.title, status: "In progress", state: "OPEN" }],
    notOnBoard: [393],
  });
  assert.deepEqual(argv, [touchedItemRequest(1275), touchedItemRequest(393)]);
});

test("#1275 ACCEPTANCE: a mutation that names its item is ROUTED to a scoped snapshot, and that snapshot costs ONE request", () => {
  assert.equal(snapshotRoute({ touchedIssues: [725], fullSnapshotValid: false }), "scoped",
    "the full route is 6 board pages and a ready-issue list at today's 555 items (board-snapshot.test.ts counts it)");
  forgetScopedSnapshots();
  const { request, argv } = requestOf();
  let ran = false;
  withScopedSnapshot(() => { ran = true; }, [725], contextOf(request));
  assert.equal(ran, true, "the mutation still runs -- this is a cost fix, not a skip");
  assert.deepEqual(argv, [touchedItemRequest(725)], "one request: #725's item, and nothing else on the board");
});

test("#1275 CONTROL: a snapshot is still WRITTEN and PRINTED before the mutation runs", () => {
  // Unaffected by the route, which is what makes it the row's control: send a named item down the full route and the
  // ACCEPTANCE above goes red while this stays green.
  forgetScopedSnapshots();
  const order: string[] = [];
  withScopedSnapshot(() => { order.push("mutate"); }, [725], contextOf(requestOf().request, {
    writeFile: () => { order.push("write"); }, log: (line) => { order.push(line); } }));
  assert.equal(order[0], "write", "one snapshot written -- never #399's guarantee deleted");
  assert.match(order[1] ?? "", /^board-snapshot: wrote runs\/board-snapshots\/\S+\.json before mutating/, "and printed");
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
  const written: Array<{ path: string; data: string }> = [];
  const log: string[] = [];
  withScopedSnapshot(() => {}, [725], contextOf(requestOf().request, {
    writeFile: (path, data) => { written.push({ path, data }); }, log: (line) => { log.push(line); } }));
  assert.equal(written.length, 1);
  assert.equal(written[0].path, `${SNAPSHOT_DIR}/2026-09-13T19-00-00-000Z-issue-725.json`);
  const parsed = JSON.parse(written[0].data);
  assert.deepEqual(parsed.scope, { issues: [725] });
  assert.deepEqual(parsed.project, { owner: "DanBeckDev", number: 2 });
  assert.deepEqual(parsed.items, [{ itemId: "PVTI_725", number: 725, title: "row 725", status: "In progress", state: "OPEN" }]);
  assert.deepEqual(parsed.notOnBoard, []);
  assert.match(parsed.takenBefore, /SCOPED to the item\(s\) that mutation touches, not the whole board \(#1275\).*within 300s/s,
    "and the file says so, so nobody takes it for the board");
  assert.match(log.join("\n"), /wrote runs\/board-snapshots\/2026-09-13T19-00-00-000Z-issue-725\.json before mutating #725/);
});

test("#1275: an issue NOT on the board is recorded as such, and the mutation still runs so gh can say so", () => {
  forgetScopedSnapshots();
  const written: string[] = [];
  let ran = false;
  withScopedSnapshot(() => { ran = true; }, [393], contextOf(requestOf(() => CAPTURED_OFF_BOARD).request, {
    writeFile: (_path, data) => { written.push(data); } }));
  assert.equal(ran, true, "`gh project item-edit` names a row that is not on the board, and moveProjectStatus reads "
    + "that as notOnBoard (#400) -- refusing here would replace that wording with this file's");
  assert.deepEqual(JSON.parse(written[0]).items, []);
  assert.deepEqual(JSON.parse(written[0]).notOnBoard, [393]);
});

test("#1275: a token that cannot read the Project is REFUSED, and the close path still classifies it as project-unreadable", () => {
  forgetScopedSnapshots();
  const request = (): string => {
    const error = new Error("Command failed: gh api graphql ...") as Error & { stdout: string; status: number };
    error.stdout = CAPTURED_NO_PROJECT;
    error.status = 1;
    throw error;
  };
  let ran = false;
  let message = "";
  try {
    withScopedSnapshot(() => { ran = true; }, [1275], contextOf(request));
  } catch (error) {
    message = (error as Error).message;
  }
  assert.equal(ran, false, "no snapshot, no mutation (#399)");
  assert.match(message, /NOT_FOUND \(user\.projectV2\): Could not resolve to a ProjectV2 with the number 999/,
    "GraphQL's own error, read off the failed process's stdout (#555)");
  assert.equal(refusalCause(`could not move #1275's Status to "Done" -- ${message}`), PROJECT_UNREADABLE,
    "settle-closed-status.mjs's own classifier: #546's bridge reads this cause, and a scoped read must still produce it");
  assert.equal(refusalCause("could not move #1275's Status to \"Done\" -- board-snapshot: gh's response for #1275 "
    + "did not have the shape"), "other", "CONTROL: the classifier is not satisfied by any board-snapshot refusal");
});

test("#1275: the SAME captured error on a zero exit -- errors beside data -- is refused before data is read", () => {
  forgetScopedSnapshots();
  let ran = false;
  assert.throws(() => withScopedSnapshot(() => { ran = true; }, [1275], contextOf(() => CAPTURED_NO_PROJECT)),
    /GraphQL returned an error alongside its response.*NOT_FOUND \(user\.projectV2\)/s);
  assert.equal(ran, false);
});

test("#1275: an answer about a different issue, a list shorter than its own count, or not JSON is refused -- never 'not on the board'", () => {
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
  const { request, argv } = requestOf();
  const context = contextOf(request);
  withScopedSnapshot(() => {}, [725], context);
  withScopedSnapshot(() => {}, [725], context);
  assert.equal(argv.length, 1, "a claim then a decline of one row: one read");
  withScopedSnapshot(() => {}, [726], context);
  assert.equal(argv.length, 2, "a scoped file never licenses a mutation of a different item");
});

test("#1275: a scoped snapshot deleted from disk, or past the bound, is read again", () => {
  forgetScopedSnapshots();
  const { request, argv } = requestOf();
  const disk = new Set<string>();
  const at = (ms: number) => contextOf(request, { disk, at: new Date(AT.getTime() + ms) });
  withScopedSnapshot(() => {}, [725], at(0));
  withScopedSnapshot(() => {}, [725], at(1000));
  assert.equal(argv.length, 1, "still on disk and inside the bound: reused");
  disk.clear(); // `rm -rf runs/`
  withScopedSnapshot(() => {}, [725], at(2000));
  assert.equal(argv.length, 2, "the file is gone, so the reuse is not taken -- #852's disk re-read, per item");
  withScopedSnapshot(() => {}, [725], at(2000 + BOUND_MS));
  assert.equal(argv.length, 3, "past the bound: a fresh read");
});

test("#1275: #399's guarantee holds on the scoped path -- a failed write means the mutation never runs", () => {
  forgetScopedSnapshots();
  let ran = false;
  assert.throws(() => withScopedSnapshot(() => { ran = true; }, [725], contextOf(requestOf().request, {
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
  const { request, argv } = requestOf();
  let ran = false;
  assert.throws(() => withScopedSnapshot(() => { ran = true; }, [], contextOf(request)), /`touches` must name/);
  assert.equal(ran, false, "an empty list is vacuously 'every one held' -- a mutation with no snapshot behind it");
  assert.equal(argv.length, 0);
});

test("#1275: one scoped snapshot of several issues names them all, in the file and its name", () => {
  const written: Array<{ path: string; data: string }> = [];
  const path = writeScopedSnapshot([725, 726], { request: requestOf().request, maxAgeMs: BOUND_MS, mkdir: () => {},
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

function settleCounted(n: number, answer: (issue: number) => string, { lookup = true } = {}) {
  forgetScopedSnapshots();
  const { request, argv } = requestOf(answer);
  const context = contextOf(request);
  const counter = { mutations: 0 };
  const outcome = settleClosedStatus(n, { moveStatus: moveThroughScope(context, counter), log: () => {},
    ...(lookup ? { currentStatus: (issue: number) => scopedStatusOf(issue, context) } : {}) });
  return { requests: argv.length, mutations: counter.mutations, outcome };
}

test("#1360 DONE-WHEN 1, measured: a row already at Done costs exactly 1 request and 0 mutations", () => {
  const { requests, mutations, outcome } = settleCounted(1298, (n) => touched(n, { status: "Done" }));
  assert.equal(requests, 1);
  assert.equal(mutations, 0);
  assert.deepEqual(outcome, { settled: true, refused: [] });
});

test("#1360 DONE-WHEN 1, measured: a row at a live Status costs exactly 1 request and 1 mutation -- the move reuses the read", () => {
  const { requests, mutations, outcome } = settleCounted(1393, (n) => touched(n, { status: "In progress" }));
  assert.equal(requests, 1, "the move reused the read the lookup took; two here would be a second read per row");
  assert.equal(mutations, 1);
  assert.deepEqual(outcome, { settled: true, refused: [] });
});

test("#1360 DONE-WHEN 1, measured: an unreadable Project costs exactly 1 request, 0 mutations, and refuses project-unreadable", () => {
  const { requests, mutations, outcome } = settleCounted(1332, () => {
    const error = Object.assign(new Error("Command failed: gh api graphql"), { status: 1, stdout: CAPTURED_NO_PROJECT });
    throw error;
  });
  assert.equal(requests, 1, "the move never read again after the lookup's read failed");
  assert.equal(mutations, 0);
  assert.equal(outcome.settled, false);
  assert.equal(outcome.refused[0].cause, PROJECT_UNREADABLE);
});

test("#1360 CONTROL, today's cost: the same Done row settled WITHOUT the lookup costs 1 request and 1 mutation", () => {
  // What the three counts above are measured against: the mutation the lookup saves is this one.
  const { requests, mutations } = settleCounted(1298, (n) => touched(n, { status: "Done" }), { lookup: false });
  assert.equal(requests, 1);
  assert.equal(mutations, 1);
});

test("#1360 a row NOT on the board reads as null and is moved as before, still on the one read", () => {
  const { requests, mutations } = settleCounted(393, (n) => touched(n, { onBoard: false }));
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

/** An answer failing exactly as CI's token does against the Project (#546): exit 1, GraphQL's NOT_FOUND on stdout. */
const unreadableProject = (): string => {
  throw Object.assign(new Error("Command failed: gh api graphql"), { status: 1, stdout: CAPTURED_NO_PROJECT });
};

/** The close path over `rows` in ONE process: one scoped context, and the lookup and move as the entry points build them. */
function settleRows(rows: number[], answer: (issue: number) => string) {
  forgetScopedSnapshots();
  const { request, argv } = requestOf(answer);
  const context = contextOf(request);
  const counter = { mutations: 0 };
  const outcomes = rows.map((n) => settleClosedStatus(n, { moveStatus: moveThroughScope(context, counter),
    log: () => {}, currentStatus: (issue: number) => scopedStatusOf(issue, context) }));
  return { requests: argv.length, mutations: counter.mutations, outcomes };
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
  forgetScopedSnapshots();
  const { request, argv } = requestOf(unreadableProject);
  const context = contextOf(request);
  let mutations = 0;
  const messages = SEVEN_ROWS.map((n) => {
    try {
      withScopedSnapshot(() => { mutations += 1; }, [n], context);
      return "mutated";
    } catch (error) {
      return (error as Error).message;
    }
  });
  assert.equal(argv.length, 1);
  assert.equal(mutations, 0, "no snapshot, no mutation (#399), for a recorded refusal as for the first");
  assert.deepEqual(messages.map((message) => refusalCause(message)), SEVEN_ROWS.map(() => PROJECT_UNREADABLE));
  assert.match(messages[1], /not reading Project 2 again for #1332 -- an earlier read in this process was refused/,
    "a refusal from the record says it made no request, so nobody reads it as a second failed read");
});

test("#1425 CONTROL: a failure that is NOT project-unreadable is not recorded -- 7 rows still make 7 requests", () => {
  const { requests, outcomes } = settleRows(SEVEN_ROWS, () => {
    throw Object.assign(new Error("Command failed: gh api graphql\nerror connecting to api.github.com"), { status: 1 });
  });
  assert.equal(requests, 7, "a transient failure on one item says nothing about the next, so each is read");
  assert.deepEqual(outcomes.map((outcome) => outcome.refused.map((refusal) => refusal.cause)), SEVEN_ROWS.map(() => ["other"]));
});

test("#1425 POSITIVE CONTROL: a readable board still reads each row once and moves it -- 7 rows, 7 requests, 7 mutations", () => {
  const { requests, mutations, outcomes } = settleRows(SEVEN_ROWS, (n) => touched(n, { status: "In progress" }));
  assert.equal(requests, 7, "one scoped read per row, which that row's move reuses (#1360)");
  assert.equal(mutations, 7);
  assert.ok(outcomes.every((outcome) => outcome.settled));
});

test("#1425: forgetting the process's snapshots forgets the record, so the next read asks again", () => {
  settleRows([1393], unreadableProject);
  const { requests, outcomes } = settleRows([1393], (n) => touched(n, { status: "Done" }));
  assert.equal(requests, 1, "a record that survived the reset would refuse a readable board without asking");
  assert.deepEqual(outcomes, [{ settled: true, refused: [] }]);
});
