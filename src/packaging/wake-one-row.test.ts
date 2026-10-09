// no-token: gh -- every `gh` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * #2407: ONE INSTANCE, ONE ROW -- the router's half and the ledger's (`ceo`, on the chairman's direction of 2026-09-24).
 * Its own file for #2280's reason (`wake.test.ts` reaches `gh`, so the token-less acceptance job refused it): the
 * roster, the registry, `herdr` and every `gh` call are injected or stubbed on PATH. `row-claim`'s half is
 * `row-claim-one-row.test.ts`.
 *
 * Driven through `route`/`deliver` and the `wake.ts` entry, with `sessions.json` ITSELF as the source of "spare": a
 * test that handed the router a literal list would pass with the mark deleted from the file. Every refusal has the
 * same fixture with ONE thing changed as its control, so what flipped the outcome is named by the test.
 */
import { TSX_IMPORT, afterTsx } from "../tsx-import.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route, deliver, withSpareInstances, engineerRoles, engineerEligibility, spawnClaimer, spentSeen, isSpareRole,
  cycleVerdict, consecutiveClean, cyclesReport, endFinishedSpares, readSpareCycles, sparePathsFrom, registerSpawn,
  settleAbsentInstance, drainInForce, spareInstances } from "../wake.ts";
import { startedPanes, STUB_STARTED_PANE } from "./started-pane.ts";

const T0 = Date.UTC(2026, 8, 25, 0, 0, 0);
const STUB_MODE = 0o755;
const WAKE_ENTRY = fileURLToPath(new URL("../wake.ts", import.meta.url));
const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));
const STANDING = ["worker-capture", "worker-judge", "worker-tooling"];
const POOL = "engineers";
const ROW_ORDER = {
  session: POOL, cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2407",
  prompt: "Ready row #2407 is unclaimed. Claim it with `--session=<you>`.",
};

/** A pool router built the way `main` builds it, over an idle `worker-4` and the standing three drained. */
function poolRouter(over: { instances?: Record<string, { spawnedAt: number; rows: number[] }>;
  lookup?: (label: string) => unknown; warn?: (line: string) => void; label?: string } = {}) {
  const label = over.label ?? "worker-4";
  const live = agents({ [label]: "idle" });
  const asked: string[] = [];
  const ineligibleReason = engineerEligibility({
    drained: STANDING, spare: (name) => isSpareRole(name), instances: over.instances ?? {},
    lookup: ((name: string) => { asked.push(name); return over.lookup ? over.lookup(name) : []; }) as never,
    warn: over.warn ?? (() => undefined),
  });
  return { asked, routed: route(POOL, live, withSpareInstances(engineerRoles(), live), ineligibleReason) };
}

// --- THE ROUTER: A SPARE THAT HOLDS OR HAS HELD A ROW IS NOT IN THE POOL ---

test("#2407 (2) ACCEPTANCE: an idle spare that has held a row is skipped by the pool, and the refusal names why", () => {
  const skipped = poolRouter({ instances: { "worker-4": { spawnedAt: T0, rows: [2378] } } });
  assert.ok("refusal" in skipped.routed, "the only idle engineer is spent, so nobody takes the order");
  const said = (skipped.routed as { refusal: string }).refusal;
  assert.ok(said.includes(`worker-4=${spentSeen([2378])}`), `the seen list says WHY, not "idle"; got ${said}`);
  assert.match(said, /one instance, one row \(#2407\)/);
  assert.match(said, /allowed to claim/);
  assert.deepEqual(skipped.asked, [], "the registry answers it, so no GitHub call is paid for a spent instance");
});

test("#2407 (2) CONTROL: the same idle spare with nothing recorded and nothing held IS offered the row", () => {
  const offered = poolRouter({ instances: { "worker-4": { spawnedAt: T0, rows: [] } } });
  assert.deepEqual(offered.routed, { label: "worker-4" }, "a fresh spare is offered the row it was spawned for");
  assert.deepEqual(poolRouter().routed, { label: "worker-4" }, "and so is one the registry has never heard of");
});

test("#2407 (2): a row the registry has not recorded yet still counts when the LABELS say the instance holds it", () => {
  const held = poolRouter({ lookup: () => [{ number: 2402 }] });
  assert.ok("refusal" in held.routed);
  assert.match((held.routed as { refusal: string }).refusal, /worker-4=has held #2402: one instance, one row/);
  // The control: the lookup that finds nothing is the one that offers.
  assert.deepEqual(poolRouter({ lookup: () => [] }).routed, { label: "worker-4" });
});

test("#2407 (2): a lookup that CANNOT ask offers the row and says so -- an outage must not stop every delivery", () => {
  const said: string[] = [];
  const blind = poolRouter({ lookup: () => null, warn: (line) => said.push(line) });
  assert.deepEqual(blind.routed, { label: "worker-4" });
  assert.match(said[0], /could not read the rows "worker-4" holds/);
});

test("#2407 (6): a STANDING engineer is not judged by this rule, whatever a registry says about its name", () => {
  assert.equal(isSpareRole("worker-4"), true, "sessions.json marks the family spare");
  assert.equal(isSpareRole("worker-11"), true);
  for (const standing of STANDING) assert.equal(isSpareRole(standing), false, `${standing} claims by hand until it retires`);
  const eligible = engineerEligibility({ spare: (name) => isSpareRole(name), lookup: () => [],
    instances: { "worker-tooling": { spawnedAt: T0, rows: [2378, 2293] } } });
  assert.equal(eligible("worker-tooling"), null, "a registry line under a standing name changes nothing");
  const spent = engineerEligibility({ spare: (name) => isSpareRole(name), lookup: () => [],
    instances: { "worker-4": { spawnedAt: T0, rows: [2378] } } });
  assert.equal(spent("worker-4"), spentSeen([2378]), "and the identical line under a spare's name refuses");
});

test("#2407 (2) an order that NAMES the spent spare is still delivered; the pool order is not, and starts a new instance", () => {
  const live = agents({ "worker-4": "idle" });
  const roster = withSpareInstances(engineerRoles(), live);
  const instances = { "worker-4": { spawnedAt: T0, rows: [2378] } };
  const ineligibleReason = engineerEligibility({ drained: STANDING, spare: (name) => isSpareRole(name), instances, lookup: () => [] });
  const named = { session: "worker-4", cause: "changes-requested", causeKey: "worker-4/changes-requested/pr-2380/abc",
    prompt: "Your PR has a refusal to answer." };
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
  const got = deliver([named], live, roster, { run, ineligibleReason, drained: STANDING });
  assert.deepEqual(got.sent, ["worker-4 <- worker-4/changes-requested/pr-2380/abc (no clear)"],
    "the same idle spare that is skipped for a pool order is woken for an order about its own row");

  const pool = deliver([ROW_ORDER], agents({ "worker-4": "idle" }), roster, { run, ineligibleReason, drained: STANDING });
  assert.equal(pool.sent.length, 1);
  assert.match(pool.sent[0], /^worker-2407 <- engineers\/ready-row-unclaimed\/2407 \(STARTED/,
    "the spent instance is skipped and the ROW's own address is started (#2469): a new row always gets a new instance");
  assert.ok(!pool.sent.some((line) => line.startsWith("worker-4")));
});

// --- THE LEDGER: `rows`, THE COUNT, AND A VIOLATION AS A FAILED CYCLE ---

const tree = { path: "/x/wt-1", clean: true as const, merge: "merged" as const };
const closed = (...numbers: number[]) => numbers.map((number) => ({ number, state: "CLOSED" }));

test("#2407 (4) ACCEPTANCE: an instance that ended with two rows is `clean: false`, naming both; one row is clean", () => {
  const two = cycleVerdict({ role: "worker-4", rows: closed(2378, 2293), held: [], worktrees: [tree] });
  assert.equal(two.clean, false, "every row closed and the worktree merged -- and it is still a failed cycle");
  assert.match(two.why, /held 2 rows \(#2378, #2293\): one instance, one row \(#2407\)/);
  const one = cycleVerdict({ role: "worker-4", rows: closed(2378), held: [], worktrees: [tree] });
  assert.equal(one.clean, true, "the control: the same fixture with one row");
});

test("#2407 (4): the teardown writes the line with `rows` on it, oldest first, and the leak is a line that resets the run", () => {
  const written: unknown[] = [];
  const listed = agents({ "worker-4": "idle" });
  const closes: string[] = [];
  const run = (args: string[]) => {
    closes.push(args.join(" "));
    return args.includes("list")
      ? JSON.stringify({ result: { workspaces: [{ label: "worker-4", workspace_id: "wD", agent_status: "idle" }] } }) : "{}";
  };
  const finish = (rows: number[]) => {
    written.length = 0;
    endFinishedSpares(listed, { spares: spareInstances(listed), registry: { "worker-4": { spawnedAt: T0, rows } }, now: T0 + 1,
      run, heldRows: () => [], rowState: () => "CLOSED", worktrees: () => [], record: (c: unknown) => written.push(c),
      warn: () => undefined } as never);
    return written[0] as { rows: number[]; clean: boolean; why: string; row: number };
  };
  const single = finish([2407]);
  assert.deepEqual([single.rows, single.clean, single.row], [[2407], true, 2407]);
  const leaked = finish([2378, 2293, 2301, 2188]);
  assert.deepEqual(leaked.rows, [2378, 2293, 2301, 2188], "every row the instance held, oldest first");
  assert.equal(leaked.clean, false);
  assert.match(leaked.why, /#2378, #2293, #2301, #2188/, "the rows are in the why, so the leak is visible");
  assert.ok(closes.some((c) => c.includes("workspace close wD")), "the instance is still ended: the line records, it does not keep it alive");
  assert.deepEqual(consecutiveClean([single, leaked, single] as never), { run: 1, empty: false },
    "a leak resets the run, as any failure does");
  assert.equal(drainInForce([single, leaked] as never), false, "and, as the newest line failing, lifts the drain (#2324's own release)");
});

test("#2407 (3) ACCEPTANCE: a legacy line adds nothing and resets nothing; a single-row clean line adds one", () => {
  const single = { role: "worker-4", row: 1, at: 1, rows: [1], clean: true, why: "x" };
  const legacyClean = { role: "worker-5", row: 2302, at: 1, clean: true, why: "#2365, #2386, #2302 closed" };
  const legacyFailed = { role: "worker-5", row: 2302, at: 1, clean: false, why: "old failure" };
  assert.deepEqual(consecutiveClean([legacyClean, legacyClean]), { run: 0, empty: false },
    "the two lines on the ledger when this landed were 2 of 20 and are now 0: the count restarted");
  assert.equal(consecutiveClean([legacyClean, single]).run, 1, "a legacy line adds nothing");
  assert.equal(consecutiveClean([single, single, legacyClean, single]).run, 3, "and a legacy CLEAN one in the middle is not evidence");
  assert.equal(consecutiveClean([single, single, legacyFailed, single]).run, 3, "nor is a legacy FAILED one a reset: never argued from");
  assert.equal(consecutiveClean([single, { ...single, clean: false }]).run, 0, "a failure that HAS rows resets");
  assert.equal(consecutiveClean([single, { ...single, rows: [1, 2] }]).run, 0,
    "a line claiming clean over two rows is not a single-row clean line: it counts for nothing and breaks the run");
  assert.equal(consecutiveClean([single, { ...single, rows: [] }]).run, 0, "a clean line over NO row is not a cycle either");
  assert.equal(consecutiveClean([]).empty, true, "empty still says empty");
});

test("#2407 (3): an unreadable ledger line is a failed cycle WITH rows, so it is a reset and not a legacy line to skip", () => {
  const single = JSON.stringify({ role: "worker-4", row: 1, at: 1, rows: [1], clean: true, why: "x" });
  const read = readSpareCycles("x", (() => `${single}\n${single}\n{corrupt\n${single}\n`) as never);
  assert.equal(read.length, 4);
  assert.deepEqual(read[2].rows, [], "the placeholder has an account -- an empty, failed one");
  assert.equal(consecutiveClean(read).run, 1, "the corrupt line cannot be bridged by the clean ones either side of it");
});

test("#2407 (4): `spawn:cycles` says how many legacy lines were counted for nothing, so 0 is not a silent number", () => {
  const legacy = { role: "worker-6", row: 2385, at: 1, clean: true, why: "legacy" };
  const single = { role: "worker-4", row: 1, at: 2, rows: [1], clean: true, why: "x" };
  const got = cyclesReport([legacy, legacy, single], STANDING);
  assert.match(got.stdout, /clean cycles in the current run: 1 of 20\n/);
  assert.match(got.stdout, /legacy lines counted for nothing \(no rows field, #2407\): 2\n/);
  assert.match(cyclesReport([legacy, legacy], STANDING).stdout, /clean cycles in the current run: 0 of 20\n/);
});

// --- A LEFTOVER REGISTRY ENTRY MUST NOT BLOCK THE NEXT SPAWN ---
//
// `row-claim` refuses a spare a second row on the strength of the registry, and a spawn's claim runs BEFORE the pane
// exists -- so an entry left by an instance that crashed would refuse the first claim of the next instance to take that
// address. The lowest free address is chosen every tick, so nothing would ever spawn again.

test("#2407: settling an absent instance writes ONE failed line carrying its rows, drops the entry, and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-settle-"));
  try {
    const paths = sparePathsFrom(join(dir, "wake-ledger"));
    writeFileSync(paths.registry, `${JSON.stringify({ "worker-4": { spawnedAt: T0, rows: [2378] }, "worker-5": { spawnedAt: T0, rows: [] } })}\n`);
    const left = settleAbsentInstance(paths, "worker-4", T0 + 1);
    assert.deepEqual(Object.keys(left), ["worker-5"], "only the settled role's entry goes");
    const [line, ...rest] = readSpareCycles(paths.cycles);
    assert.deepEqual(rest, []);
    assert.deepEqual([line.role, line.rows, line.clean], ["worker-4", [2378], false]);
    settleAbsentInstance(paths, "worker-4", T0 + 2);
    assert.equal(readSpareCycles(paths.cycles).length, 1, "the second call finds nothing, so no second failure is written");
    registerSpawn(paths, "worker-4", T0 + 3);
    assert.equal(readSpareCycles(paths.cycles).length, 1, "and the registration after the claim adds none either");
    assert.deepEqual(JSON.parse(readFileSync(paths.registry, "utf8"))["worker-4"], { spawnedAt: T0 + 3, rows: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2407: the spawner settles the role BEFORE its claim runs, and a claimer with no settle claims as before", () => {
  const events: string[] = [];
  const exec = (command: string, rawArgs: string[]) => {
    const args = afterTsx(rawArgs);
    events.push(`${command} ${args.filter((a) => !a.startsWith("--")).slice(0, 2).join(" ")}`);
    return { status: 0, output: args[1] === "claim" ? "STARTED -- #2407\n" : "" };
  };
  const order = { ...ROW_ORDER, title: "One instance, one row" };
  const claimer = spawnClaimer({ exec, exists: () => true, settle: (role) => events.push(`settle ${role}`) });
  const got = claimer.claim(order, "worker-4", {});
  assert.ok(!("refusal" in got), JSON.stringify(got));
  const settled = events.indexOf("settle worker-4");
  const claimed = events.findIndex((e) => e.includes("row-claim") || e.includes(" claim"));
  assert.ok(settled >= 0 && claimed > settled, `settle precedes the claim; got ${events.join(" | ")}`);
  assert.ok(!("refusal" in spawnClaimer({ exec, exists: () => true }).claim(order, "worker-4", {})), "the seam defaults to none");
});

// THE WIRING, AS A PROCESS: `main` builds the router's registry and the spawner's settle, and an injected seam is
// exactly what a deleted call goes around. Stubs on PATH answer herdr, gh, git and the claim (as #2323/#2405's do).
function tickWith(registry: Record<string, unknown> | null, listed: string) {
  const dir = mkdtempSync(join(tmpdir(), "wake-one-row-"));
  try {
    const ledger = join(dir, "wake-ledger");
    mkdirSync(join(dir, "repos", "a11y-witness"), { recursive: true });
    const seen = join(dir, "registry-at-claim");
    writeFileSync(join(dir, "herdr"), `#!/bin/sh\ncase "$*" in\n  *'workspace list') printf '%s' '{"result":{"workspaces":[${listed}]}}' ;;\n`
      + "  *'workspace create'*) printf '%s' '{\"result\":{\"root_pane\":{\"pane_id\":\"wB:p1\"},\"workspace\":{\"workspace_id\":\"wB\"}}}' ;;\n"
      + STUB_STARTED_PANE
      + "  *) : ;;\nesac\n");
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nprintf '%s' '[]'\n");
    writeFileSync(join(dir, "git"), "#!/bin/sh\ncase \"$1\" in\n  worktree) mkdir -p \"$4\" ;;\n  *) : ;;\nesac\n");
    // The claim stub records the registry AS THE CLAIM SEES IT: that is the moment a leftover entry would refuse it.
    writeFileSync(join(dir, "node"), `#!/bin/sh\ncat '${sparePathsFrom(ledger).registry}' >> '${seen}' 2>/dev/null\nmkdir -p ../wt-2407\necho 'STARTED -- #2407 fixture'\n`);
    for (const name of ["herdr", "gh", "git", "node"]) chmodSync(join(dir, name), STUB_MODE);
    if (registry !== null) writeFileSync(sparePathsFrom(ledger).registry, `${JSON.stringify(registry)}\n`);
    const ran = spawnSync(process.execPath, [...TSX_IMPORT, WAKE_ENTRY, `--ledger=${ledger}`, `--worktrees-dir=${join(dir, "repos")}`], {
      input: `${JSON.stringify(ROW_ORDER)}\n`, encoding: "utf8",
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}`, A11Y_HOST_LOAD: "0" } });
    const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
    return { ran, atClaim: read(seen), cycles: readSpareCycles(sparePathsFrom(ledger).cycles),
      registry: JSON.parse(read(sparePathsFrom(ledger).registry) || "{}") as Record<string, { rows: number[] }> };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const IDLE_WORKER_4 = '{"label":"worker-4","workspace_id":"wD","agent_status":"idle"}';

test("#2407 THE WAKE ENTRY (router): an idle spare with a recorded row is skipped and the row's own address is started", () => {
  const spent = tickWith({ "worker-4": { spawnedAt: 1, rows: [2378] } }, IDLE_WORKER_4);
  assert.match(spent.ran.stdout, /WOKE worker-2407 <- engineers\/ready-row-unclaimed\/2407 \(STARTED/, spent.ran.stderr);
  assert.ok(!/WOKE worker-4/.test(spent.ran.stdout), "the spent instance is not woken for a new row");
  const control = tickWith({ "worker-4": { spawnedAt: 1, rows: [] } }, IDLE_WORKER_4);
  assert.match(control.ran.stdout, /WOKE worker-4 <- engineers\/ready-row-unclaimed\/2407 \(no clear\)\n/,
    `the control: nothing recorded and nothing held, so the idle spare takes the row; got ${control.ran.stderr}`);
});

test("#2407 THE WAKE ENTRY (settle): a leftover entry is gone before the next instance's claim, and its failure is recorded", () => {
  // #2469: the address the tick starts is the ROW's, so the leftover entry is the one under that name.
  const stale = tickWith({ "worker-2407": { spawnedAt: 1, rows: [2378] } }, "");
  assert.match(stale.ran.stdout, /WOKE worker-2407 <- engineers\/ready-row-unclaimed\/2407 \(STARTED/, stale.ran.stderr);
  assert.ok(!stale.atClaim.includes("2378"), `the claim saw a registry still naming the dead instance's row: ${stale.atClaim}`);
  const [line] = stale.cycles;
  assert.deepEqual([line?.role, line?.rows, line?.clean], ["worker-2407", [2378], false]);
  assert.equal(stale.cycles.length, 1, "one failed line for the one missing teardown, not two");
  assert.deepEqual(stale.registry["worker-2407"].rows, [], "and the new instance is registered fresh");
});
