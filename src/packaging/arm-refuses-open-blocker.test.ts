// no-token: none -- every read and write goes through the fake code host; nothing here reaches GitHub, git, herdr or the fleet
//
// A11-160 (step 5): `arm-pr` and the sweep's refusals are CORE'S DECISIONS, and they run on the fake code host's world (a pull request, the rows it closes and their blockers). What the code host asks of GitHub
// to read a row's blocked-by edges, and the shapes of answer it refuses, are the GitHub plugin's (`plugins/github/rows/arming.test.ts`); the sweep as a real process over a stub `gh` is the plugin's end to end
// (`plugins/github/rows/arm-refuses-open-blocker-process.test.ts`).
/**
 * #3544: A PULL REQUEST WHOSE CLOSING ROW HAS AN OPEN `blocked-by` EDGE IS NOT ARMED, and the refusal names the blocker.
 *
 * Measured 2026-10-04: #3507 (closing row #3422) merged at 18:43:41Z although #3422 carried a native `blocked-by` edge on #3509,
 * whose own body warned that merging #3507 first would break the chairman's reply path. No arming path read the edge.
 *
 * THE FIXTURE IS #3422's REAL EDGE LIST, `EDGES_3422`: two blockers, #3509 OPEN and #3414 CLOSED. The CLOSED one is in the fixture on purpose -- only an OPEN
 * blocker counts, so a verdict that named #3414 would be reading the wrong half. The controls change ONE thing each, so a refusal cannot pass by never being reached.
 *
 * THE MUTANT is the tree before this row (`origin/main` at the branch point): there `blockerVerdict` does not exist and both doors
 * arm #3507. The doors' tests below fail there on BEHAVIOUR (the pull request is armed), the decider's on its absence; the run is
 * pasted on the row.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as armPr from "../arm-pr.ts";
import { refusalBeforeArming } from "../auto-arm-sweep.ts";
import { testEach } from "../lib/test-each.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { fakePull } from "../plugins/fakes/code-host-pulls.ts";

const { runArmPr, EXIT } = armPr;
const REPO = "a11ign/a11ign";
type Blocker = [number, "OPEN" | "CLOSED"];
/** A row of the world: the blockers it names (a blocker with no row of its own reads as open, as a node with no state does), or `"unread"` for an edge list that cannot be read whole. */
type RowSpec = Blocker[] | "unread" | "absent";

/** #3422's edge list: the agent-org pin move OPEN, the milestones source CLOSED. */
const EDGES_3422: Blocker[] = [[3509, "OPEN"], [3414, "CLOSED"]];
const CLEARED_3422: Blocker[] = [[3509, "CLOSED"], [3414, "CLOSED"]];
const UNBLOCKED: Blocker[] = [];
const BODY = "Closes #3422\n\nAcceptance:\n```bash\npnpm test\n```";

afterEach(() => forgetActivation());

/** The fake code host with the rows of `rows` in the repository `repo` (numbers) and in the repositories `foreign` names (`owner/name#number`). */
function worldOf(rows: Record<number, RowSpec>, { repo = REPO, foreign = {} as Record<string, RowSpec> } = {}) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = repo;
  const seat = (spec: RowSpec, number: number, put: (row: ReturnType<typeof fakeRow>) => void) => {
    if (spec === "absent") return;
    const blockers = spec === "unread" ? [] : spec;
    for (const [blocker, state] of blockers) if (state === "CLOSED" && !world.rows.has(blocker)) world.rows.set(blocker, fakeRow(world, blocker, { state: "CLOSED" }));
    for (const [blocker, state] of blockers) if (state === "OPEN" && !world.rows.has(blocker)) world.rows.set(blocker, fakeRow(world, blocker));
    put(fakeRow(world, number, { blockedBy: blockers.map(([blocker]) => blocker), blockedByUnread: spec === "unread" }));
  };
  for (const [number, spec] of Object.entries(rows)) seat(spec, Number(number), (row) => world.rows.set(row.number, row));
  for (const [key, spec] of Object.entries(foreign)) seat(spec, Number(key.split("#")[1]), (row) => world.foreignRows.set(key, row));
  substituteCodeHost(host);
  return { host, world };
}

const why = (verdict: { kind: string }) => ("why" in verdict ? String(verdict.why) : "");
const blockedBy = (verdict: { kind: string }) => ("blockers" in verdict ? verdict.blockers : null);
const reads = (world: { calls: string[] }) => world.calls.filter((call) => call.startsWith("openBlockersOfRow ")).map((call) => call.split(" ")[1]);

// --- the shared decision ---

test("#3544 (1) the decider: #3422's real edge list is BLOCKED, naming the OPEN blocker and the row it blocks -- not the closed one", () => {
  worldOf({ 3422: EDGES_3422 });
  const verdict = armPr.blockerVerdict({ repo: REPO, prBody: BODY });
  assert.equal(verdict.kind, "open-blocker");
  assert.deepEqual(blockedBy(verdict), [3509]);
  assert.match(why(verdict), /closing row #3422 is blocked by open #3509/);
  assert.doesNotMatch(why(verdict), /#3414/, "a CLOSED blocker is a wait that has cleared");
  assert.match(why(verdict), /arms on the tick after that blocker closes/);
});

test("#3544 (2) CONTROLS: the same row with its blocker CLOSED, with no edges at all, and with a blocker that has no row of its own (read as open)", () => {
  const ask = (spec: RowSpec) => { worldOf({ 3422: spec }); return armPr.blockerVerdict({ repo: REPO, prBody: BODY }); };
  assert.deepEqual(ask(CLEARED_3422), { kind: "clear" }, "the positive control: this is the arming case");
  assert.deepEqual(ask(UNBLOCKED), { kind: "clear" });
  const { world } = worldOf({ 3422: [] });
  world.rows.get(3422)!.blockedBy = [3509];
  assert.equal(armPr.blockerVerdict({ repo: REPO, prBody: BODY }).kind, "open-blocker", "a blocker with no state reads as OPEN, as `waitingOn` reads it");
});

test("#3544 (3) an unreadable edge list is `cannot-ask`, naming the read that failed -- never clear", () => {
  const unreadable: Record<string, () => void> = {
    "the read throws": () => { worldOf({ 3422: EDGES_3422 }).world.failures.set("openBlockersOfRow", new Error("HTTP 502")); },
    "the edge list cannot be read whole (no list, or a page was not read)": () => { worldOf({ 3422: "unread" }); },
    "the row cannot be found": () => { worldOf({}); },
  };
  assert.ok(Object.keys(unreadable).length >= 3, "the cases exist, so the loop below cannot pass by being empty");
  for (const [name, arrange] of Object.entries(unreadable)) {
    arrange();
    const verdict = armPr.blockerVerdict({ repo: REPO, prBody: BODY });
    assert.equal(verdict.kind, "cannot-ask", name);
    assert.match(why(verdict), /could not read closing row #3422's blocked-by edges/, name);
  }
  worldOf({});
  assert.equal(armPr.blockerVerdict({ repo: REPO, prBody: null }).kind, "cannot-ask", "a body that was not read");
  assert.equal(armPr.blockerVerdict({ repo: REPO, prBody: undefined }).kind, "cannot-ask");
});

test("#3544 (3) CONTROLS: a complete list is clear, and an OPEN node already read is blocked", () => {
  worldOf({ 3422: [[3414, "CLOSED"]] });
  assert.equal(armPr.blockerVerdict({ repo: REPO, prBody: BODY }).kind, "clear");
  worldOf({ 3422: [[3509, "OPEN"]] });
  assert.equal(armPr.blockerVerdict({ repo: REPO, prBody: BODY }).kind, "open-blocker");
});

test("#3544 (4) a PR closing SEVERAL rows is refused when ANY has an open blocker, and the message names THAT row", () => {
  const body = "Closes #3400\nCloses #3422";
  const ask = (rows: Record<number, RowSpec>) => { worldOf(rows); return armPr.blockerVerdict({ repo: REPO, prBody: body }); };

  const second = ask({ 3400: UNBLOCKED, 3422: EDGES_3422 });
  assert.equal(second.kind, "open-blocker");
  assert.match(why(second), /closing row #3422 is blocked by open #3509/, "the SECOND row, not the first");
  assert.doesNotMatch(why(second), /#3400/);

  const first = ask({ 3400: [[3600, "OPEN"]], 3422: CLEARED_3422 });
  assert.match(why(first), /closing row #3400 is blocked by open #3600/);
  assert.doesNotMatch(why(first), /#3422/);

  const both = ask({ 3400: [[3600, "OPEN"]], 3422: EDGES_3422 });
  assert.deepEqual(blockedBy(both), [3600, 3509]);
  assert.match(why(both), /#3400 is blocked by open #3600; closing row #3422 is blocked by open #3509/);

  assert.deepEqual(ask({ 3400: UNBLOCKED, 3422: CLEARED_3422 }), { kind: "clear" }, "the control: every row clear arms");
  assert.equal(ask({ 3400: UNBLOCKED, 3422: "absent" }).kind, "cannot-ask", "one unreadable row among clear ones");
  assert.equal(ask({ 3400: "absent", 3422: EDGES_3422 }).kind, "open-blocker", "a definite block outranks an unreadable row");
});

test("#3544 (5) `Closes: none` has no closing row: clear, and not one read is made", () => {
  const { world } = worldOf({});
  assert.deepEqual(armPr.blockerVerdict({ repo: REPO, prBody: "Closes: none — a docs-only change" }), { kind: "clear" });
  assert.deepEqual(reads(world), []);
  assert.deepEqual(armPr.blockerVerdict({ repo: REPO, prBody: "" }), { kind: "clear" }, "an empty body names no row");
  assert.deepEqual(reads(world), []);
});

test("#3544 a row named in another repository (`Closes owner/repo#n`) is read THERE, and named with its repository", () => {
  const { world } = worldOf({}, { repo: "a11ign/agent-org", foreign: { [`${REPO}#3422`]: EDGES_3422 } });
  const verdict = armPr.blockerVerdict({ repo: "a11ign/agent-org", prBody: `Closes ${REPO}#3422` });
  assert.deepEqual(reads(world), [`${REPO}#3422`], "the tracker the row lives in, not the PR's own repository");
  assert.match(why(verdict), new RegExp(`closing row ${REPO}#3422 is blocked by open #3509`));
});

// --- #470: a blocker the same merge closes is not a blocker (lab#39 deadlocked on `Closes: #4305, #4372`, #4305 blocked by #4372) ---

test("#470 the lab#39 case: `Closes: #5, #6` where row 5 is blocked by open #6 is clear -- the merge is the blocker's only exit", () => {
  worldOf({ 5: [[6, "OPEN"]], 6: UNBLOCKED });
  assert.deepEqual(armPr.blockerVerdict({ repo: REPO, prBody: "Closes: #5, #6" }), { kind: "clear" });
});

testEach("#470 CONTROL: the body `Closes: #5, #6` with row 5 blocked by open #7 is `open-blocker` naming #7 and not #6", [
  {
    name: "row 5 blocked by open #7, which the PR does not close",
    row5Blockers: [7],
    message: /closing row #5 is blocked by open #7\. Declared order is enforced: it arms on the tick after that blocker closes/,
  },
  {
    name: "row 5 blocked by open #6 AND open #7 names #7 only",
    row5Blockers: [6, 7],
    message: /closing row #5 is blocked by open #7\. Declared order/,
  },
], (c) => {
  worldOf({ 5: c.row5Blockers.map((number): Blocker => [number, "OPEN"]), 6: UNBLOCKED });
  const verdict = armPr.blockerVerdict({ repo: REPO, prBody: "Closes: #5, #6" });
  assert.equal(verdict.kind, "open-blocker");
  assert.deepEqual(blockedBy(verdict), [7]);
  assert.match(why(verdict), c.message);
  assert.doesNotMatch(why(verdict), /#6/);
});

test("#470 CONTROL: `Closes: #5` alone with row 5 blocked by open #6 still refuses, naming #6", () => {
  worldOf({ 5: [[6, "OPEN"]] });
  const verdict = armPr.blockerVerdict({ repo: REPO, prBody: "Closes: #5" });
  assert.equal(verdict.kind, "open-blocker");
  assert.deepEqual(blockedBy(verdict), [6]);
  assert.match(why(verdict), /closing row #5 is blocked by open #6/);
});

test("#470 CONTROL: a closing row in ANOTHER repository (`a11ign/a11ign#6`) is not matched by the bare blocker 6 of a row in the PR's own repository", () => {
  const { world } = worldOf({ 5: [[6, "OPEN"]] }, { repo: "a11ign/agent-org", foreign: { [`${REPO}#6`]: UNBLOCKED } });
  const verdict = armPr.blockerVerdict({ repo: "a11ign/agent-org", prBody: "Closes: #5, a11ign/a11ign#6" });
  assert.deepEqual(reads(world), ["a11ign/agent-org#5", "a11ign/a11ign#6"], "both rows read, each in its own tracker");
  assert.equal(verdict.kind, "open-blocker");
  assert.deepEqual(blockedBy(verdict), [6]);
  assert.match(why(verdict), /closing row #5 is blocked by open #6/);
});

test("#470 the other half of the key: the same pair named in the PR's own repository with its full name IS the same row, so it clears", () => {
  worldOf({ 5: [[6, "OPEN"]], 6: UNBLOCKED }, { repo: "a11ign/agent-org" });
  assert.deepEqual(armPr.blockerVerdict({ repo: "a11ign/agent-org", prBody: "Closes: #5, a11ign/agent-org#6" }), { kind: "clear" });
});

test("#470 a closing blocker's OWN open blockers still count, and an unreadable row among the pair is still `cannot-ask`", () => {
  const body = "Closes: #5, #6";
  worldOf({ 5: [[6, "OPEN"]], 6: [[8, "OPEN"]] });
  const own = armPr.blockerVerdict({ repo: REPO, prBody: body });
  assert.equal(own.kind, "open-blocker");
  assert.deepEqual(blockedBy(own), [8]);
  const reason = why(own);
  assert.match(reason, /closing row #6 is blocked by open #8/);
  assert.doesNotMatch(reason, /closing row #5/);
  worldOf({ 5: [[6, "OPEN"]], 6: "unread" });
  const unread = armPr.blockerVerdict({ repo: REPO, prBody: body });
  assert.equal(unread.kind, "cannot-ask", "row 5 is cleared by the pair, row 6 was not read: not a row with no blocker");
  assert.match(why(unread), /could not read closing row #6's blocked-by edges/);
});

// --- door one: the per-PR `arm` job ---

type Fixture = { rows: Record<number, RowSpec>; comments?: string[]; refuse?: "commentOnPull" | "readPullComments"; body?: string };

function driveArm({ rows, comments = [], refuse, body = BODY }: Fixture) {
  const { world } = worldOf(rows);
  const pull = fakePull(world, 3507, { body, author: "worker-1", comments: [...comments] });
  if (refuse !== undefined) world.failures.set(refuse, new Error(refuse === "commentOnPull" ? "HTTP 403" : "HTTP 502"));
  const said: string[] = [];
  const code = runArmPr({ argv: ["--pr=3507", `--repo=${REPO}`], env: {}, sleep: () => "ok" as const,
    log: (l: string) => said.push(l), error: (l: string) => said.push(l), lanes: { lanes: [] } });
  return { code, said: said.join("\n"), merged: pull.armed, commented: pull.comments.slice(comments.length) };
}

test("#3544 (1) arm-pr: #3507 over #3422's real edges is NOT armed -- no arm, exit DONE, the line names both numbers", () => {
  const out = driveArm({ rows: { 3422: EDGES_3422 } });
  assert.equal(out.merged, false, out.said);
  assert.equal(out.code, EXIT.DONE, "waiting on a row is not a failure, as a hold is not");
  assert.match(out.said, /NOT arming #3507 -- closing row #3422 is blocked by open #3509/);
});

test("#3544 (2) arm-pr CONTROL: the same PR with the blocker CLOSED ARMS, so the refusal above was reached and decided", () => {
  const out = driveArm({ rows: { 3422: CLEARED_3422 } });
  assert.equal(out.merged, true, out.said);
  assert.equal(out.commented.length, 0, "an armed PR gets no refusal comment");
});

test("#3544 (3) arm-pr: an unreadable edge list arms nothing and exits CANNOT_ASK, the code an unreadable label list already gets", () => {
  for (const rows of [{ 3422: "unread" }, {}] as Record<number, RowSpec>[]) {
    const out = driveArm({ rows });
    assert.equal(out.merged, false, out.said);
    assert.equal(out.code, EXIT.CANNOT_ASK);
    assert.match(out.said, /could not read closing row #3422's blocked-by edges/);
    assert.equal(out.commented.length, 0, "nothing is known, so nothing is announced");
  }
});

test("#3544 (3) arm-pr: a refused read of the edges arms nothing and exits CANNOT_ASK", () => {
  const { world } = worldOf({ 3422: EDGES_3422 });
  world.failures.set("openBlockersOfRow", new Error("HTTP 502"));
  const pull = fakePull(world, 3507, { body: BODY, author: "worker-1" });
  const said: string[] = [];
  const code = runArmPr({ argv: ["--pr=3507", `--repo=${REPO}`], env: {}, sleep: () => "ok" as const, log: (l: string) => said.push(l), error: (l: string) => said.push(l), lanes: { lanes: [] } });
  assert.equal(pull.armed, false);
  assert.equal(code, EXIT.CANNOT_ASK);
  assert.match(said.join("\n"), /could not read closing row #3422's blocked-by edges: HTTP 502/);
  assert.equal(pull.comments.length, 0);
});

test("#3544 (4)(5) arm-pr: any blocked row among several refuses; `Closes: none` arms as before", () => {
  const several = driveArm({ body: "Closes #3400\nCloses #3422", rows: { 3400: UNBLOCKED, 3422: EDGES_3422 } });
  assert.equal(several.merged, false);
  assert.match(several.said, /closing row #3422 is blocked by open #3509/);
  const none = driveArm({ body: "Closes: none — docs only", rows: {} });
  assert.equal(none.merged, true, none.said);
});

test("#3544 (6) arm-pr: the refusal is COMMENTED on the PR once -- the marker is found on the next tick, a changed blocker set is said afresh", () => {
  const first = driveArm({ rows: { 3422: EDGES_3422 } });
  assert.equal(first.commented.length, 1, first.said);
  const text = first.commented[0];
  assert.match(text, /arm-refused: open-blocker 3509/);
  assert.match(text, /closing row #3422 is blocked by open #3509/);
  assert.match(text, /arms on the tick after that blocker closes/);

  const marker = text.split("\n")[0];
  const again = driveArm({ rows: { 3422: EDGES_3422 }, comments: ["unrelated", `${marker}\nNot armed`] });
  assert.equal(again.commented.length, 0, "ONE comment, not one per tick");
  assert.equal(again.merged, false);

  const changed = driveArm({ rows: { 3422: EDGES_3422 }, comments: ["<!-- arm-refused: open-blocker 3999 -->"] });
  assert.equal(changed.commented.length, 1, "a comment about a different blocker does not stand in for this one");
});

test("#3544 (6) arm-pr: a comment that cannot be read or posted is SAID and changes neither the refusal nor the exit code", () => {
  for (const refuse of ["commentOnPull", "readPullComments"] as const) {
    const out = driveArm({ rows: { 3422: EDGES_3422 }, refuse });
    assert.equal(out.merged, false, out.said);
    assert.equal(out.code, EXIT.DONE);
    assert.match(out.said, /could not tell #3507 why it is not armed/);
  }
});

// --- door two: the sweep's decider (the sweep as a real process is the plugin's end-to-end test) ---

test("#3544 sweep: `refusalBeforeArming` -- blocked is refused, a closed blocker is clear, an unreadable list is `cannot-ask`", () => {
  const ask = (spec: RowSpec, prBody: string | null = BODY) => {
    const { world } = worldOf({ 3422: spec });
    fakePull(world, 3507, { author: "worker-1" });
    return refusalBeforeArming({ number: "3507", repo: REPO, author: "worker-1", prBody });
  };
  const blocked = ask(EDGES_3422);
  assert.equal(blocked.kind, "open-blocker");
  assert.match(why(blocked), /closing row #3422 is blocked by open #3509/);
  assert.equal(ask(CLEARED_3422).kind, "clear");
  assert.equal(ask("unread").kind, "cannot-ask");
  assert.equal(ask(CLEARED_3422, null).kind, "cannot-ask", "a body the sweep could not read");
});
