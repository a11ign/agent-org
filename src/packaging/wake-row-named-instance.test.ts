// no-token: gh -- every `gh` and `herdr` here is an injected `run` seam and the registry lives in a temp dir; nothing imported spawns the real one
/**
 * #2469: an engineer spawned for row N is `worker-N` (`ceo`'s ruling on #2407, section 2). The allocator used to
 * hand out the LOWEST free counter, and a counter name was reused across unrelated rows (`worker-4` held six), so
 * nobody reading the ledger or a herdr list could tell which row a name meant. A spare holds ONE row (#2407), so
 * the row is the name.
 *
 * Its own file, and not a block in `wake-spare-family.test.ts`, so the row's Acceptance is one command that names
 * exactly this. Every fact read here -- herdr, GitHub, the cycle ledger, the registry -- is injected or a temp file.
 *
 * WHERE THE POSITIVE CONTROLS ARE, because "refused" and "not renamed" are absences that pass against a function
 * that does nothing: the taken-address cases each run beside the SAME call with the address free (which spawns),
 * and the counter-named case runs beside a spawn in the same tick that does start a row-named instance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver, spawnableRole, spareLabelForRow, withSpareInstances, engineerRoles, spareInstances,
  endFinishedSpares, readSpareCycles, consecutiveClean, registerSpawn, sparePathsFrom, rowOfOrder, isSpareRole }
  from "../wake.ts";
import { isLiveSession, familyNumber, unknownSessionLabels } from "../arm-pr.ts";
import { laneReason, runnerReason } from "../row-claim/runner-rule.mjs";
import { labelAfterCreate } from "../pr-open.ts";
import { startedPanes } from "./started-pane.ts";

const agents = (spec: Record<string, string>) =>
  Object.entries(spec).map(([label, status]) => ({ label, status }));
const STANDING = ["worker-capture", "worker-judge", "worker-tooling"];
const REAL_ROSTER = engineerRoles();
const orderFor = (row: number) => ({
  session: "engineers",
  cause: "ready-row-unclaimed",
  causeKey: `engineers/ready-row-unclaimed/${row}`,
  prompt: `Ready row #${row} is unclaimed. Claim it with \`--session=<you>\`.`,
});
/** The standing three working and nothing else: the real roster lists no spare, so any spawn is a family spawn. */
const STANDING_BUSY = agents(Object.fromEntries(STANDING.map((r) => [r, "working"])));

/** A `herdr` that records every call and answers `workspace create` as the live org did on 2026-09-23. */
function recordingHerdr() {
  const calls: string[][] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    calls.push(args);
    const answered = pane(args);
    if (answered !== null) return answered;
    if (args.join(" ").includes("workspace create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  return { run, said: (verb: string) => calls.map((c) => c.join(" ")).filter((s) => s.includes(verb)) };
}

// --- Done-when 1: the name is the row's ------------------------------------------------------------------------

test("#2469 ACCEPTANCE (1): spawning for two different rows names two instances worker-<row>, and the names differ", () => {
  const names = [2469, 2470].map((row) => {
    const h = recordingHerdr();
    const got = deliver([orderFor(row)], STANDING_BUSY, REAL_ROSTER, { run: h.run });
    assert.deepEqual(got.refused, [], `row #${row} was not refused`);
    assert.equal(h.said("workspace create").length, 1, `row #${row} started one workspace`);
    const label = /--label (\S+) /.exec(h.said("workspace create")[0])?.[1];
    assert.equal(got.sent[0].split(" ")[0], label, "and the order is delivered to the instance that was started");
    return label;
  });
  assert.deepEqual(names, ["worker-2469", "worker-2470"]);
  assert.notEqual(names[0], names[1]);
});

test("#2469 (1): the name does not depend on WHICH counter numbers are busy -- it is the row's on a bare tick and a crowded one", () => {
  const crowded = agents({ ...Object.fromEntries(STANDING.map((r) => [r, "working"])),
    ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`worker-${i + 4}`, "working"])) });
  for (const tick of [STANDING_BUSY, crowded]) {
    assert.deepEqual(spawnableRole(orderFor(2469), tick, REAL_ROSTER), { role: "worker-2469" });
  }
});

test("#2469 (1): the pure naming -- row in, address out, and none where the family could not recognise it", () => {
  assert.equal(spareLabelForRow({ row: 2469 }), "worker-2469");
  assert.equal(spareLabelForRow({ row: 4 }), "worker-4", "the family's own `from` is a valid row");
  assert.equal(spareLabelForRow({ row: 3 }), null, "worker-3 is below the family, so no reader would route to it");
  assert.equal(spareLabelForRow({ row: null }), null, "no row, no name");
  assert.equal(spareLabelForRow({ row: 2469, families: [] }), null, "no declared family, no name");
  // The name it makes is a member of the family for every reader, at four digits.
  assert.equal(familyNumber("worker-2469"), 2469);
  assert.ok(isLiveSession("worker-2469"));
});

test("#2469 (1): an order that names no row gets a refusal that says so, and starts nothing", () => {
  const unrowed = { ...orderFor(1), causeKey: "engineers/ready-row-unclaimed/none" };
  assert.equal(rowOfOrder(unrowed), null, "the fixture really is unparseable");
  const got = spawnableRole(unrowed, STANDING_BUSY, REAL_ROSTER);
  assert.match((got as { refusal: string }).refusal, /names no row a spare could be named for/);
  const h = recordingHerdr();
  deliver([unrowed], STANDING_BUSY, REAL_ROSTER, { run: h.run });
  assert.deepEqual(h.said("workspace create"), []);
});

// --- Done-when 5(b): no reader of a `session:` name assumes a small family --------------------------------------

test("#2469 ACCEPTANCE (5b): every reader of a family name gives the same answer at 2407 as at 9, and refuses what is outside", () => {
  const big = "worker-2407";
  assert.equal(familyNumber(big), 2407, "familyNumber: any canonical integer from `from`");
  assert.equal(isLiveSession(big), true, "isLiveSession: arm-pr's live check, unknownSessionLabels, laneReason, pr-open's owner");
  assert.deepEqual(unknownSessionLabels([`session:${big}`]), [], "unknownSessionLabels does not report it");
  assert.ok(String(laneReason(["ready", `lane:${big}`], "worker-5")).includes(`${big}'s lane`), "laneReason reserves the row for it");
  assert.equal(runnerReason(["ready", `runner:${big}`], big), null, "runnerReason compares strings and reads no roster");
  assert.deepEqual(labelAfterCreate("create", ["--head", "agent/x-2407"], big),
    [["pr", "edit", "agent/x-2407", "--add-label", `session:${big}`]], "pr-open labels a PR from its tree");
  assert.equal(isSpareRole(big), true, "isSpareRole: the router's pool and row-claim's second-row refusal");
  assert.deepEqual(withSpareInstances([], agents({ "worker-9": "idle", [big]: "idle", "worker-10": "idle" })),
    ["worker-9", "worker-10", big], "withSpareInstances orders NUMERICALLY, so a four-digit name sorts last, not first");
  // The POSITIVE CONTROLS: the same readers refuse names outside the family, so the acceptances above are not a
  // reader that accepts everything.
  for (const outside of ["worker-3", "worker-02407", "worker-2407x", "worker-capture-2407"]) {
    assert.equal(isLiveSession(outside), false, outside);
    assert.equal(isSpareRole(outside), false, outside);
    assert.equal(familyNumber(outside), null, outside);
  }
});

// --- Done-when 2: a counter-named instance is never renamed and still routes ---------------------------------------

test("#2469 ACCEPTANCE (2): an instance running as worker-4 is not renamed, and an order naming it is still delivered", () => {
  const running = agents({ ...Object.fromEntries(STANDING.map((r) => [r, "working"])), "worker-4": "idle" });
  // It stays in the roster `route` offers work from, under its own name.
  assert.deepEqual(withSpareInstances(REAL_ROSTER, running), [...REAL_ROSTER, "worker-4"]);
  // An order NAMING it reaches it: no workspace is created, nothing is relabelled.
  const named = { ...orderFor(2469), session: "worker-4", causeKey: "worker-4/review-answer/2469" };
  const h = recordingHerdr();
  const got = deliver([named], running, REAL_ROSTER, { run: h.run });
  assert.deepEqual(got.sent, ["worker-4 <- worker-4/review-answer/2469 (no clear)"]);
  assert.deepEqual(got.refused, []);
  assert.deepEqual(h.said("workspace create"), [], "delivered to the running instance, not to a new one");
  assert.deepEqual(h.said("rename"), []);
  // The instance is still a spare for the teardown's reader, by its counter name.
  assert.deepEqual(spareInstances(running), ["worker-4"]);
  // CONTROL: the same tick with the counter-named instance BUSY and an engineer order starts a row-named one, so the
  // absence of a workspace above is the routing's and not a spawn path that never runs.
  const busy = agents({ ...Object.fromEntries(STANDING.map((r) => [r, "working"])), "worker-4": "working" });
  const control = recordingHerdr();
  assert.deepEqual(deliver([orderFor(2469)], busy, REAL_ROSTER, { run: control.run }).sent,
    ["worker-2469 <- engineers/ready-row-unclaimed/2469 (STARTED sonnet/high)"]);
});

// --- Done-when 3: the ledger's role is the row-named address, and the count is by lines ---------------------------

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const HOUR = 3_600_000;

/** One instance that finished its row, ended as `wake-spare-family.test.ts` ends one. */
function endedCycle(label: string, row: number, ledger: string) {
  const listed = agents({ [label]: "idle", "worker-tooling": "idle" });
  const run = (args: string[]) => {
    if (args.join(" ").endsWith("workspace list")) {
      return JSON.stringify({ result: { workspaces: listed.map((a, i) => ({ label: a.label,
        workspace_id: `w${i}`, agent_status: a.status })) } });
    }
    return "{}";
  };
  return endFinishedSpares(listed, {
    spares: spareInstances(listed), registry: { [label]: { spawnedAt: T0 - 5 * HOUR, rows: [row] } }, now: T0, run,
    heldRows: () => [], rowState: () => "CLOSED", worktrees: () => [],
    record: (c: unknown) => writeFileSync(ledger, `${JSON.stringify(c)}\n`, { flag: "a" }), warn: () => {},
  } as never);
}

test("#2469 ACCEPTANCE (3): the ledger line's role is worker-<row>, and consecutiveClean counts lines, not names", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-rownamed-"));
  try {
    const ledger = join(dir, "spare-cycles");
    const got = endedCycle("worker-2469", 2469, ledger);
    assert.deepEqual(got.ended.map((c) => c.role), ["worker-2469"]);
    const [line] = readSpareCycles(ledger);
    assert.equal(line.role, "worker-2469");
    assert.deepEqual([line.row, line.rows, line.clean], [2469, [2469], true]);
    assert.match(line.why, /session:worker-2469/, "and the reason names the address too");
    assert.deepEqual(consecutiveClean(readSpareCycles(ledger)), { run: 1, empty: false });
    // A counter-named instance draining out is one more line of the same run: the count is by lines.
    endedCycle("worker-4", 2400, ledger);
    assert.deepEqual(readSpareCycles(ledger).map((c) => c.role), ["worker-2469", "worker-4"]);
    assert.deepEqual(consecutiveClean(readSpareCycles(ledger)), { run: 2, empty: false });
    // CONTROL: the count is not a constant -- a multi-row line resets it.
    writeFileSync(ledger, `${JSON.stringify({ role: "worker-9", row: 1, at: T0, clean: false, rows: [1, 2], why: "x" })}\n`,
      { flag: "a" });
    assert.deepEqual(consecutiveClean(readSpareCycles(ledger)), { run: 0, empty: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Done-when 4: an address that holds a process is never spawned into --------------------------------------------

test("#2469 ACCEPTANCE (4): a taken address is refused with the reason, for every status but the one route already offers", () => {
  for (const status of ["working", "blocked", "unknown"]) {
    const taken = agents({ ...Object.fromEntries(STANDING.map((r) => [r, "working"])), "worker-2469": status });
    const got = spawnableRole(orderFor(2469), taken, REAL_ROSTER) as { refusal?: string; role?: string };
    assert.equal(got.role, undefined, `a ${status} worker-2469 is not spawned into`);
    assert.match(String(got.refusal), /"worker-2469" is the address row #2469 would be named/);
    assert.ok(String(got.refusal).includes(`already holds a process (${status})`), "and it says which status holds it");
    assert.ok(String(got.refusal).includes("B2"), "and why one address is one process");
    const h = recordingHerdr();
    const sent = deliver([orderFor(2469)], taken, REAL_ROSTER, { run: h.run });
    assert.deepEqual(h.said("workspace create"), [], `no second workspace under one label (${status})`);
    assert.deepEqual(sent.sent, []);
    assert.match(sent.refused[0], /already holds a process/);
  }
  // A counter-named instance that is BUSY holds its own address and not the row's: the row is still spawned.
  const counterBusy = agents({ ...Object.fromEntries(STANDING.map((r) => [r, "working"])), "worker-4": "working" });
  assert.deepEqual(spawnableRole(orderFor(2469), counterBusy, REAL_ROSTER), { role: "worker-2469" });
  // CONTROL: the taken address is the ONLY thing that changed, so the refusal above is its.
  assert.deepEqual(spawnableRole(orderFor(2469), STANDING_BUSY, REAL_ROSTER), { role: "worker-2469" });
});

test("#2469 (4b): a drained address is not spawned into either, and an IDLE holder is offered the order instead", () => {
  const got = spawnableRole(orderFor(2469), STANDING_BUSY, REAL_ROSTER, ["worker-2469"]) as { refusal?: string };
  assert.match(String(got.refusal), /is drained/);
  // An idle worker-2469 is the instance the row is named for: `route` offers it the order, and nothing starts.
  const idle = agents({ ...Object.fromEntries(STANDING.map((r) => [r, "working"])), "worker-2469": "idle" });
  const h = recordingHerdr();
  const sent = deliver([orderFor(2469)], idle, REAL_ROSTER, { run: h.run });
  assert.deepEqual(sent.sent, ["worker-2469 <- engineers/ready-row-unclaimed/2469 (no clear)"]);
  assert.deepEqual(h.said("workspace create"), []);
});

// --- Done-when 7: a reopened row gets the same name ---------------------------------------------------------------

test("#2469 ACCEPTANCE (7): a row reopened after its instance ended is given worker-<row> again, with a fresh registry entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-rownamed-"));
  try {
    const paths = sparePathsFrom(join(dir, "ledger"));
    // First life: named for the row, registered, ended (its registry entry is deleted by the teardown).
    const first = spawnableRole(orderFor(2469), STANDING_BUSY, REAL_ROSTER) as { role: string };
    registerSpawn(paths, first.role, T0);
    assert.deepEqual(JSON.parse(readFileSync(paths.registry, "utf8"))["worker-2469"], { spawnedAt: T0, rows: [] });
    writeFileSync(paths.registry, "{}\n");
    // Second life: the row reopens, the address is free, the SAME name is given.
    const second = spawnableRole(orderFor(2469), STANDING_BUSY, REAL_ROSTER) as { role: string };
    assert.equal(second.role, first.role);
    registerSpawn(paths, second.role, T0 + HOUR);
    assert.deepEqual(JSON.parse(readFileSync(paths.registry, "utf8"))["worker-2469"], { spawnedAt: T0 + HOUR, rows: [] },
      "a clean start: no rows carried over from the first life");
    assert.ok(!existsSync(paths.cycles), "and a clean teardown left nothing on the ledger to settle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
