// no-token: gh -- `deliver` is handed a recording `run` for herdr, a fake claimer and a `readRow` seam; nothing here reaches `gh` or `herdr`
/**
 * a11ign/agent-org#832 (Phase 1b of a11ign/a11ign#4505): A `lane:orchestrator` ROW IS RUN BY A ONE-SHOT SEAT THAT CARRIES THE ORCHESTRATOR BRIEF,
 * BEHIND `workers.orchestratorOneShot`, WHICH IS OFF.
 *
 * WHAT IS PINNED, as named cases: flag OFF is the order at origin/main (a literal, asserted long) and what `deliver` does with it; flag ON addresses
 * `engineers` with the sibling cause and `briefRole: "orchestrator"`, and the prompt names `orchestrator.md` and not `engineer.md`; a fleet-or-lab row is
 * held while one run is live and spawned when none is; `SPAWN_CAUSES` is still exactly one cause; the spawn path writes a record of the spawn BEFORE the claim and
 * the REAL `laneReason` honours the very record it wrote (a standing non-orchestrator session is still refused); with the flag off nothing is written; and
 * `ROUTED_TO`, `FLEET_LAB_PATTERNS` and `fleetOrLabAcceptance` are the text they were.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver, spawnableRole, SPAWN_CAUSES, type ClaimedRow, type SpawnClaimer } from "./wake.ts";
import { fleetOrLabAcceptance } from "./acceptance-commands.ts";
import { RESOURCES } from "./project-vocabulary.ts";
import { laneReason } from "./row-claim/runner-rule.ts";
import { readStandIns, writeStandIn } from "./row-claim/lane-stand-in.ts";
import { ONE_SHOT_SPAWN_CAUSES, createOrchestratorOneShot, orchestratorOneShotEnabled, withOrchestratorOneShot } from "./orchestrator-one-shot.ts";
import { startedPanes } from "./packaging/started-pane.ts";
import { workGateSource } from "./lib/work-gate-source.ts";
import { trackedTopLevelDirs } from "./region-paths.ts";

const STANDING = ["worker-capture", "worker-judge", "worker-tooling"];
const held = STANDING.map((label) => ({ label, status: "working" }));
const KEY = "orchestrator/ready-row-unclaimed/agent-org#832";
/** The order `work-gate` writes for a ready `lane:orchestrator` row of the agent-org tracker, as a literal (the shape at origin/main 6b22fe5a). */
const GATE_ORDER = {
  session: "orchestrator", cause: "ready-row-unclaimed", causeKey: KEY, subject: "row-agent-org-832", title: "A lane:orchestrator row runs as a one-shot session",
  discriminator: "agent-org#832", prompt: "Ready row agent-org#832 is unclaimed: A lane:orchestrator row runs as a one-shot session. Claim it as `<you>`.\n",
};
const GATE_ORDER_LITERAL = '{"session":"orchestrator","cause":"ready-row-unclaimed","causeKey":"orchestrator/ready-row-unclaimed/agent-org#832",'
  + '"subject":"row-agent-org-832","title":"A lane:orchestrator row runs as a one-shot session","discriminator":"agent-org#832",'
  + '"prompt":"Ready row agent-org#832 is unclaimed: A lane:orchestrator row runs as a one-shot session. Claim it as `<you>`.\\n"}';
const SEAT = "worker-agent-org-832";
/** A PATH row: its Region declares a file the tree has at its root, so there is something to commit. */
const PLAIN_BODY = "## Region\n\nREADME.md\n\n## Acceptance\n\n```bash\nnpx rstest run src/x.test.ts\n```\n";
const FLEET_BODY = "## Region\n\nREADME.md\n\n## Acceptance\n\n```bash\npnpm run lab:status\n```\n";
/** A PATH-LESS row, in the shape of agent-org#1646: its Region names no file, and its Acceptance is a plain `grep` of a log. */
const PATHLESS_BODY = "## Region\n\nNone in a repository: it needs host access (orchestrator); a worktree session cannot do it.\n\n## Acceptance\n\n```bash\ngrep -q SHADOW host.log\n```\n";
/** A decision row: its Region says the deliverable is not a commit, so there is no path to follow. */
const DECISION_BODY = "## Region\n\nIts deliverable is not a commit: the orchestrator decides.\n\n## Acceptance\n\n```bash\nnpx rstest run src/x.test.ts\n```\n";
/** A row whose body has no Region section at all. */
const NO_REGION_BODY = "## Acceptance\n\n```bash\nnpx rstest run src/x.test.ts\n```\n";
/** The tree's root files, as `isPathRow` takes them: a parameter, so no test reads `origin/main`. */
const ROOT_FILES = new Set(["README.md"]);
/** The row the order's `causeKey` names, as `wake.ts`'s `rowRefOfOrder` reads it. */
const ROW_OF = () => ({ key: "agent-org", number: 832 });
/** The lane's reader for a row of the given body and labels, with the flag ON. */
const LANE = (body: string, labels: string[] = []) => ({ enabled: () => true, rowOf: ROW_OF, rootFiles: ROOT_FILES, readRow: () => ({ body, labels }) });

/** A scratch directory and its record file; removed by the caller's `finally`. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-one-shot-"));
  return { dir, path: join(dir, "lane-stand-ins.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A recording herdr that answers workspace creation and reports a started pane ready. */
function herdr() {
  const calls: string[][] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    calls.push(args);
    const answered = pane(args);
    if (answered !== null) return answered;
    return args.join(" ").includes("workspace create")
      ? JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } }) : "{}";
  };
  return { run, calls, prompt: (label: string) => calls.find((a) => a[3] === "prompt" && a[4] === label && a[5] !== "/clear")?.[5] };
}

/** One tick's delivery of `orders` through the real `deliver`, with a claimer that notes what the record file held when the claim was made. */
function drive(orders: readonly object[], { path, body = PLAIN_BODY, live = [], enabled = true, write, refuseClaim = false }:
  { path: string; body?: string; live?: { label: string; status: string }[]; enabled?: boolean; write?: typeof writeStandIn; refuseClaim?: boolean }) {
  const h = herdr();
  const heldAtClaim: ReturnType<typeof readStandIns>[] = [];
  const claimed: ClaimedRow = { row: 832, key: "agent-org", branch: "agent/a-lane-orchestrator-row-agent-org-832", worktree: "/tmp/wt-agent-org-832", launchDir: "/tmp" };
  const claimer: SpawnClaimer = {
    claim: () => { heldAtClaim.push(readStandIns(path)); return refuseClaim ? { refusal: "the claim was refused" } : claimed; },
    release: () => "", tier: () => null,
  };
  const oneShot = createOrchestratorOneShot({ readRow: () => ({ body }), path, write });
  const ready = withOrchestratorOneShot(orders as { session: string; cause?: string }[], { enabled: () => enabled, rowOf: ROW_OF, rootFiles: ROOT_FILES, readRow: () => ({ body }) });
  const got = deliver(ready as never, [...held, ...live], STANDING, { sleep: () => {}, run: h.run, claimer, oneShot, claimable: () => null });
  return { ...h, got, ready, heldAtClaim };
}

/** #1650: these subtests drive a spawn for agent-org#832 or read the vocabulary the fixture declares empty. The fixture has ONE tracker (key ""), so `worker-agent-org-832` names no spare (arm-pr.ts `familyMember`) and the spawn is refused; its `vocabulary.resources` is `[]`, so FLEET_LAB_PATTERNS is empty and `fleetOrLabAcceptance` matches nothing. a11ign's declarations carry both, and the subtests run there. */
const SKIP_FIXTURE = trackedTopLevelDirs().includes("packages") ? false
  : "the fixture declares ONE tracker (key \"\"), so worker-agent-org-832 names no spare family member and the spawn is refused; its vocabulary.resources is [], so FLEET_LAB_PATTERNS is empty and fleetOrLabAcceptance matches no command";

test("flag OFF: the order is byte-identical to the order at origin/main, and so is what deliver does with it", () => {
  assert.ok(Buffer.byteLength(GATE_ORDER_LITERAL) > 100, "the pinned literal is not empty, so an empty order cannot pass");
  assert.equal(JSON.stringify(GATE_ORDER), GATE_ORDER_LITERAL, "the fixture IS the literal");
  const off = withOrchestratorOneShot([GATE_ORDER], { enabled: () => false });
  assert.equal(JSON.stringify(off[0]), GATE_ORDER_LITERAL);
  const orders = [GATE_ORDER];
  assert.equal(withOrchestratorOneShot(orders, { enabled: () => false }), orders, "the very array comes back");
  const s = scratch();
  try {
    const before = deliver([GATE_ORDER] as never, held, STANDING, { sleep: () => {}, run: herdr().run });
    const after = drive([GATE_ORDER], { path: s.path, enabled: false });
    assert.deepEqual(after.got, before, "the outcome is what it was before this change");
    assert.equal(after.calls.filter((a) => a.join(" ").includes("workspace create")).length, 0, "nothing was started");
  } finally {
    s.done();
  }
});

test("flag ON: the order is addressed to engineers with the sibling cause and briefRole orchestrator, and the prompt names orchestrator.md and not engineer.md", { skip: SKIP_FIXTURE }, () => {
  const on = withOrchestratorOneShot([GATE_ORDER], LANE(PLAIN_BODY))[0] as typeof GATE_ORDER & { briefRole: string };
  assert.equal(on.session, "engineers");
  assert.equal(on.cause, ONE_SHOT_SPAWN_CAUSES[0]);
  assert.equal(on.briefRole, "orchestrator");
  assert.equal(on.causeKey, KEY, "the ledger's identity and the row the claim reads are the standing order's own");
  assert.equal(on.prompt, GATE_ORDER.prompt);
  const s = scratch();
  try {
    const run = drive([GATE_ORDER], { path: s.path });
    assert.deepEqual(run.got.sent, [`${SEAT} <- ${KEY} (STARTED sonnet/high)`], JSON.stringify(run.got));
    const prompt = String(run.prompt(SEAT));
    assert.match(prompt, /roles\/orchestrator\.md/);
    assert.doesNotMatch(prompt, /engineer\.md/);
    // THE NEGATIVE CONTROL: the ordinary engineer order, same path, same seat shape, names engineer.md.
    const engineer = drive([{ ...GATE_ORDER, session: "engineers" }], { path: s.path });
    const control = String(engineer.prompt(SEAT));
    assert.match(control, /roles\/engineer\.md/);
    assert.doesNotMatch(control, /orchestrator\.md/);
  } finally {
    s.done();
  }
});

test("flag ON, a fleet-or-lab row is never converted, with a run live or not: its order keeps the standing orchestrator and no pane is opened", { skip: SKIP_FIXTURE }, () => {
  assert.notEqual(fleetOrLabAcceptance(FLEET_BODY), null, "premise: the fixture's Acceptance names a FLEET_LAB_PATTERNS command");
  assert.equal(fleetOrLabAcceptance(PLAIN_BODY), null, "premise: and the plain one does not");
  const s = scratch();
  try {
    writeStandIn({ seat: "worker-agent-org-831", row: 831, owner: "orchestrator" }, { path: s.path });
    const live = [{ label: "worker-agent-org-831", status: "working" }];
    for (const seatsLive of [live, []]) {
      const fleet = drive([GATE_ORDER], { path: s.path, body: FLEET_BODY, live: seatsLive });
      assert.equal(fleet.ready[0].session, "orchestrator", "the gate's own order, not an engineers one");
      assert.deepEqual(fleet.got.sent, []);
      assert.equal(fleet.calls.filter((a) => a.join(" ").includes("workspace create")).length, 0, "no pane was opened");
      assert.deepEqual(readStandIns(s.path).map((r) => r.seat), ["worker-agent-org-831"], "and no record was written for the row");
    }
    // THE CONTROL: the same live run with a row that does not reach the hardware IS spawned for it.
    assert.deepEqual(drive([GATE_ORDER], { path: s.path, body: PLAIN_BODY, live }).got.sent, [`${SEAT} <- ${KEY} (STARTED sonnet/high)`]);
  } finally {
    s.done();
  }
});

test("flag ON, a fleet-gated row, or one whose Acceptance reaches the fleet or lab, keeps the gate's order; a plain row is converted; an unreadable row and no reader keep it too", { skip: SKIP_FIXTURE }, () => {
  const sessionOf = (lane: object) => (withOrchestratorOneShot([GATE_ORDER], lane as never)[0] as { session: string }).session;
  assert.equal(sessionOf(LANE(PLAIN_BODY)), "engineers", "THE CONTROL: a plain row IS converted, so the lane still works");
  assert.equal(sessionOf(LANE(PLAIN_BODY, ["fleet-gated"])), "orchestrator", "a fleet-gated label keeps the gate's order");
  assert.equal(sessionOf(LANE(PLAIN_BODY, ["ready", "fleet-gated"])), "orchestrator", "...whatever else the row carries");
  assert.equal(sessionOf(LANE(FLEET_BODY)), "orchestrator", "an Acceptance naming a fleet command keeps it");
  assert.equal(sessionOf({ ...LANE(PLAIN_BODY), readRow: () => { throw new Error("gh: rate limited"); } }), "orchestrator", "an unreadable row keeps it");
  assert.equal(sessionOf({ enabled: () => true }), "orchestrator", "no reader handed: nothing is converted");
  assert.equal(sessionOf({ ...LANE(PLAIN_BODY), enabled: () => false }), "orchestrator", "the flag OFF: the gate's order, as before");
});

test("a path-less lane:orchestrator row keeps the gate's order: a Region naming no file, a Region that says the deliverable is not a commit, or no Region at all", { skip: SKIP_FIXTURE }, () => {
  const sessionOf = (body: string) => (withOrchestratorOneShot([GATE_ORDER], LANE(body))[0] as { session: string }).session;
  assert.equal(fleetOrLabAcceptance(PATHLESS_BODY), null, "premise: its Acceptance names no fleet or lab command, so only its Region decides");
  assert.equal(sessionOf(PATHLESS_BODY), "orchestrator", "THE agent-org#1646 SHAPE: a Region naming no file keeps the gate's order");
  assert.equal(sessionOf(DECISION_BODY), "orchestrator", "a Region that says the deliverable is not a commit keeps it");
  assert.equal(sessionOf(NO_REGION_BODY), "orchestrator", "a body with no Region section keeps it");
  assert.equal(sessionOf(PLAIN_BODY), "engineers", "THE CONTROL: a row whose Region declares a file IS converted, as before");
  // The predicate is the ceo lane's, imported and not copied (agent-org#1714, done-when 2).
  const source = readFileSync(new URL("./orchestrator-one-shot.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ isPathRow, oneShotFactory, /);
  assert.doesNotMatch(source, /function isPathRow\(/);
});

test("flag ON: an IDLE standing engineer is never given the one-shot order; the row's own seat is started instead", { skip: SKIP_FIXTURE }, () => {
  const s = scratch();
  try {
    const idle = [{ label: "worker-capture", status: "idle" }];
    const h = herdr();
    const claimer: SpawnClaimer = { claim: () => ({ row: 832, key: "agent-org", branch: "agent/b", worktree: "/tmp/wt-agent-org-832", launchDir: "/tmp" }), release: () => "", tier: () => null };
    const oneShot = createOrchestratorOneShot({ readRow: () => ({ body: PLAIN_BODY }), path: s.path });
    const ready = withOrchestratorOneShot([GATE_ORDER], LANE(PLAIN_BODY));
    const got = deliver(ready as never, [{ label: "worker-capture", status: "idle" }, ...held.slice(1)], STANDING, { sleep: () => {}, run: h.run, claimer, oneShot, claimable: () => null });
    assert.deepEqual(got.sent, [`${SEAT} <- ${KEY} (STARTED sonnet/high)`], JSON.stringify(got));
    assert.equal(h.prompt("worker-capture"), undefined, "the idle standing seat was not typed into");
    // THE CONTROL: the plain engineer order for the same row IS offered to the idle standing seat.
    const plain = herdr();
    const control = deliver([{ ...GATE_ORDER, session: "engineers" }] as never, idle, STANDING, { sleep: () => {}, run: plain.run });
    assert.match(control.sent.join("\n"), /^worker-capture <- /);
  } finally {
    s.done();
  }
});

test("flag ON: a row under a future Fleet-hold-until is held; one whose hold has passed is not", { skip: SKIP_FIXTURE }, () => {
  const s = scratch();
  try {
    const future = `${PLAIN_BODY}\nFleet-hold-until: 2999-01-01T00:00:00Z\n`;
    const past = `${PLAIN_BODY}\nFleet-hold-until: 2001-01-01T00:00:00Z\n`;
    assert.match(drive([GATE_ORDER], { path: s.path, body: future }).got.refused.join("\n"), /Fleet-hold-until: 2999-01-01T00:00:00Z/);
    assert.equal(drive([GATE_ORDER], { path: s.path, body: past }).got.sent.length, 1);
  } finally {
    s.done();
  }
});

test("flag ON: a row that cannot be read is held, not guessed", () => {
  const h = createOrchestratorOneShot({ readRow: () => { throw new Error("gh: rate limited"); }, path: "/nonexistent/lane-stand-ins.json" });
  assert.match(String(h.hold({ key: "agent-org", number: 832 }, SEAT, [])), /could not be read \(gh: rate limited\).*held, not guessed/);
});

test("SPAWN_CAUSES is still exactly [\"ready-row-unclaimed\"], and a fixture copy that adds the new cause to it fails the check", { skip: SKIP_FIXTURE }, () => {
  const problems = (source: string) => (source.includes('export const SPAWN_CAUSES = Object.freeze(["ready-row-unclaimed"]);') ? [] : ["SPAWN_CAUSES is not exactly [\"ready-row-unclaimed\"]"]);
  assert.deepEqual([...SPAWN_CAUSES], ["ready-row-unclaimed"]);
  assert.ok(!SPAWN_CAUSES.some((cause) => ONE_SHOT_SPAWN_CAUSES.includes(cause)), "the two lists share no cause");
  const source = readFileSync(new URL("./wake.ts", import.meta.url), "utf8");
  assert.deepEqual(problems(source), []);
  const widened = source.replace('Object.freeze(["ready-row-unclaimed"])', `Object.freeze(["ready-row-unclaimed", "${ONE_SHOT_SPAWN_CAUSES[0]}"])`);
  assert.notEqual(widened, source, "the negative control's fixture really differs");
  assert.deepEqual(problems(widened), ["SPAWN_CAUSES is not exactly [\"ready-row-unclaimed\"]"]);
  // And the pilot still refuses an order addressed to `orchestrator`: the new cause is admitted for `engineers` alone.
  assert.match(String((spawnableRole({ ...GATE_ORDER, cause: ONE_SHOT_SPAWN_CAUSES[0], session: "orchestrator" }, [], STANDING) as { refusal: string }).refusal), /pilot covers the engineer pool/);
  const role = spawnableRole({ session: "engineers", causeKey: KEY, cause: ONE_SHOT_SPAWN_CAUSES[0] }, [], STANDING);
  assert.deepEqual(role, { role: SEAT }, "a one-shot run takes the spare named for its row even when a standing address is free");
  assert.notDeepEqual(spawnableRole({ session: "engineers", causeKey: KEY, cause: "ready-row-unclaimed" }, [], STANDING), { role: SEAT }, "the control: an engineer order takes the free standing address");
});

test("flag ON: the spawn path writes a record naming the seat, the row and orchestrator BEFORE the claim, and the REAL laneReason honours that record", { skip: SKIP_FIXTURE }, () => {
  const s = scratch();
  const live = ["ceo", "product-manager", "orchestrator", "liaison"];
  const labels = ["lane:orchestrator", "in-progress"];
  try {
    assert.equal(readStandIns(s.path).length, 0, "premise: no record yet");
    assert.match(String(laneReason(labels, SEAT, { liveSessions: live, standIns: readStandIns(s.path), row: 832 })), /orchestrator's lane/, "the positive control: with no record the seat is refused");
    const run = drive([GATE_ORDER], { path: s.path });
    assert.equal(run.got.sent.length, 1, JSON.stringify(run.got));
    assert.equal(run.heldAtClaim.length, 1);
    assert.deepEqual(run.heldAtClaim[0].map(({ seat, row, owner }) => ({ seat, row, owner })), [{ seat: SEAT, row: 832, owner: "orchestrator" }], "the claim found the record already written");
    const records = readStandIns(s.path);
    assert.equal(laneReason(labels, SEAT, { liveSessions: live, standIns: records, row: 832 }), null, "the seat's claim of the row is not refused");
    assert.match(String(laneReason(labels, "worker-capture", { liveSessions: live, standIns: records, row: 832 })), /orchestrator's lane/, "a standing non-orchestrator session is still refused");
    assert.match(String(laneReason(labels, SEAT, { liveSessions: live, standIns: records, row: 833 })), /orchestrator's lane/, "and the seat is refused another row");
  } finally {
    s.done();
  }
});

test("flag ON, the claim refused: the record is taken back, so none outlives a seat that never ran", { skip: SKIP_FIXTURE }, () => {
  const s = scratch();
  try {
    const run = drive([GATE_ORDER], { path: s.path, refuseClaim: true });
    assert.equal(run.got.sent.length, 0);
    assert.equal(run.heldAtClaim[0].length, 1, "premise: it was there at the claim");
    assert.deepEqual(readStandIns(s.path), []);
  } finally {
    s.done();
  }
});

test("flag OFF: no record is written (the writer is not called); the control that ignores the flag calls it", { skip: SKIP_FIXTURE }, () => {
  const s = scratch();
  try {
    const noRecordWhenOff = (enabledInTransform: boolean) => {
      const calls: object[] = [];
      const write = ((record: object) => { calls.push(record); }) as unknown as typeof writeStandIn;
      // A flag read as OFF by the order's gate (`enabled`), with the transform's own switch as the variable the control breaks.
      drive([GATE_ORDER], { path: s.path, enabled: enabledInTransform, write });
      assert.deepEqual(calls, [], "the writer was called with the flag off");
      return calls;
    };
    noRecordWhenOff(false);
    assert.throws(() => {
      // THE CONTROL: the same assertion over a spawn path that does not honour the flag fails, so the case above is not vacuous.
      noRecordWhenOff(true);
    }, /the writer was called with the flag off/);
    assert.deepEqual(readStandIns(s.path), [], "and the real writer was never reached either");
  } finally {
    s.done();
  }
});

test("the flag is exactly `true` in the host declaration: absent, false, a string and an unreadable file are off", () => {
  const said: string[] = [];
  const read = (json: string) => ({ path: "host.json", read: () => json, log: (line: string) => said.push(line) });
  assert.equal(orchestratorOneShotEnabled(read('{"workers":{"orchestratorOneShot":true}}')), true);
  assert.equal(orchestratorOneShotEnabled(read("{}")), false);
  assert.equal(orchestratorOneShotEnabled(read('{"workers":{"orchestratorOneShot":false}}')), false);
  assert.equal(orchestratorOneShotEnabled(read('{"workers":{"orchestratorOneShot":"yes"}}')), false);
  assert.equal(orchestratorOneShotEnabled(read("{not json")), false);
  assert.ok(said.some((line) => /not true or false/.test(line)) && said.some((line) => /could not be read/.test(line)), "a flag meant to be on and not read is said");
});

// --- the rules `ceo` kept out of this row's reach: their text is what it was ----------------------------------------------------------

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The text of `ROUTED_TO`, `fleetOrLabAcceptance` and `FLEET_LAB_PATTERNS`' derivation, as source text and as the values the patterns hold. */
function untouchedRules(workGate: string, acceptance: string): Record<string, string> {
  const routed = /^export const ROUTED_TO = .*;$/m.exec(workGate)?.[0] ?? "";
  const start = acceptance.indexOf("export function fleetOrLabAcceptance(");
  const fn = start === -1 ? "" : acceptance.slice(start, acceptance.indexOf("\n}\n", start) + 3);
  const binding = /^const \{ patterns: FLEET_LAB_PATTERNS.*$/m.exec(acceptance)?.[0] ?? "";
  const values = RESOURCES.map(({ pattern, reason, named }) => `${pattern.source}/${pattern.flags}\t${reason}\t${named}`).join("\n");
  return { ROUTED_TO: sha(routed), fleetOrLabAcceptance: sha(fn), "FLEET_LAB_PATTERNS binding": sha(binding), "FLEET_LAB_PATTERNS values": sha(values) };
}

const PINNED = {
  ROUTED_TO: "753541140a11e726955715640e10f9a0f987469424f4b5bd2b9ce5fbd60f5293",
  fleetOrLabAcceptance: "dde6be398445a21090a6bd2ac28e74f0beca8bb81aa62b89948d7fae5c6bf009",
  "FLEET_LAB_PATTERNS binding": "50eba6ee588b5350cdd4d1a80dd67f52328db6925e65efde22776f802c8c0ae3",
  "FLEET_LAB_PATTERNS values": "bc781e8411db5a05fd4fbbfa75affd684e56b4039081f28865859bd1be33c860",
};

test("ROUTED_TO, FLEET_LAB_PATTERNS and fleetOrLabAcceptance are byte-identical to origin/main; an edited fixture fails the check", { skip: SKIP_FIXTURE }, () => {
  const workGate = workGateSource();
  const acceptance = readFileSync(new URL("./acceptance-commands.ts", import.meta.url), "utf8");
  assert.deepEqual(untouchedRules(workGate, acceptance), PINNED);
  // THE NEGATIVE CONTROLS: an edit to each of the three source texts moves its own digest and no other.
  const edited = untouchedRules(workGate.replace('Object.freeze(["orchestrator"])', 'Object.freeze(["orchestrator", "worker-capture"])'), acceptance);
  assert.notEqual(edited.ROUTED_TO, PINNED.ROUTED_TO);
  assert.equal(edited.fleetOrLabAcceptance, PINNED.fleetOrLabAcceptance);
  const loosened = untouchedRules(workGate, acceptance.replace("const matched = section === null ? null : patternReason(section, patterns);", "const matched = null;"));
  assert.notEqual(loosened.fleetOrLabAcceptance, PINNED.fleetOrLabAcceptance);
  assert.equal(loosened.ROUTED_TO, PINNED.ROUTED_TO);
  const rebound = untouchedRules(workGate, acceptance.replace("resourcePatternsFrom(RESOURCES);", "resourcePatternsFrom([]);"));
  assert.notEqual(rebound["FLEET_LAB_PATTERNS binding"], PINNED["FLEET_LAB_PATTERNS binding"]);
});
