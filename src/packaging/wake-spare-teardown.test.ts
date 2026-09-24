// no-token: gh -- every `gh` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * `packages/agent-org/src/wake.mjs`, #2323: a SPAWNED engineer is ended when its row closes, and it acts as the
 * workers account. Its own file, and not a block in `wake.test.ts`, for #2280's reason: that file spawns `route`,
 * which reaches `gh`, so the token-less acceptance job refused it and verified nothing. Every fact the teardown
 * reads -- herdr, GitHub, git -- is injected or stubbed on PATH here, so the row's declared Acceptance is a
 * command the job can RUN.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxGitEnv } from "../../../guards/src/git-env.mjs";
import { deliver, engineerRoles }
  from "../wake.mjs";
import { spareRoles, spareDecision, cycleVerdict, consecutiveClean, endFinishedSpares, spawnEnvironment,
  readSpareCycles, sparePathsFrom, registerSpawn, spareWorktrees, SPARE_CLAIM_BOUND_MS, WORKERS_GH_CONFIG_DIR }
  from "../wake.mjs";

const agents = (spec: Record<string, string>) =>
  Object.entries(spec).map(([label, status]) => ({ label, status }));
const ROSTER = ["worker-capture", "worker-judge", "worker-tooling"];
const SPARES = ["worker-4", "worker-5", "worker-6", "worker-7", "worker-8"];
const WAKE_ENTRY = fileURLToPath(new URL("../wake.mjs", import.meta.url));
const STUB_MODE = 0o755; // the tick invokes `herdr` and `gh` as commands, so the stubs have to be runnable

/** A `herdr` that records every call and answers `workspace create` as the live org did on 2026-09-23. */
function recordingHerdr() {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args.join(" ").includes("workspace create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  return { calls, run, said: (verb: string) => calls.map((c) => c.join(" ")).filter((s) => s.includes(verb)) };
}

const ROW_ORDER = {
  session: "engineers",
  cause: "ready-row-unclaimed",
  causeKey: "engineers/ready-row-unclaimed/2131",
  prompt: "Ready row #2131 is unclaimed. Claim it with `--session=<you>`.",
};
/** Nobody is running: every engineer role is absent from herdr's workspace list. */
const NOBODY = agents({ ceo: "working", "product-manager": "working" });

test("#2323: the engineer roster still offers the standing three before any spare", () => {
  assert.deepEqual(engineerRoles(), [...ROSTER, ...SPARES]);
});

// --- #2323: A SPAWNED ENGINEER IS ENDED WHEN ITS ROW CLOSES, AND ACTS AS THE WORKERS ACCOUNT ---
//
// The teardown is driven through `endFinishedSpares` -- the step the tick calls -- with `herdr`, GitHub and git
// injected, and the wiring (`work-tick` calls it on a QUIET gate; `wake` registers every spawn) is driven as a
// PROCESS at the foot, because an injected seam is what a deleted call goes around.

const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
const HOUR = 3_600_000;

/** herdr for the teardown: lists one workspace per entry of `workspaces` and records every call. */
function teardownHerdr(workspaces: { label: string; workspace_id: string; agent_status: string }[],
  refuseClose = false) {
  const calls: string[] = [];
  const run = (args: string[]) => {
    const said = args.join(" ");
    calls.push(said);
    if (said.endsWith("workspace list")) return JSON.stringify({ result: { workspaces } });
    if (refuseClose && said.includes("workspace close")) throw new Error("herdr: refused\nstack");
    return "{}";
  };
  return { run, closed: () => calls.filter((c) => c.includes("workspace close")) };
}

/** One spare (`worker-4`) that finished #2323: registered as holding it, holding nothing now. Override a fact per test. */
function finishedSpare(over: Record<string, unknown> = {}) {
  const status = String(over.status ?? "idle");
  const herdr = teardownHerdr([{ label: "worker-4", workspace_id: "wD", agent_status: status },
    { label: "worker-tooling", workspace_id: "w9", agent_status: "idle" }], over.refuseClose === true);
  const cycles: unknown[] = [];
  const warned: string[] = [];
  const deps = {
    spares: spareRoles(), registry: { "worker-4": { spawnedAt: T0 - 5 * HOUR, rows: [2323] } },
    now: T0, run: herdr.run, heldRows: () => [] as number[] | null, rowState: () => "CLOSED" as string | null,
    worktrees: () => [] as { path: string; clean: boolean | "unknown"; merge: "merged" | "not-merged" | "unknown" }[],
    record: (c: unknown) => cycles.push(c), warn: (l: string) => warned.push(l), ...over,
  };
  const listed = agents({ "worker-4": status, "worker-tooling": "idle" });
  return { got: endFinishedSpares(listed, deps as never), herdr, cycles, warned };
}

test("#2323 (1): the marks are READ from sessions.json -- worker-4 to worker-8 are spare, the standing three are not", () => {
  assert.deepEqual(spareRoles(), SPARES);
  assert.ok(!spareRoles().includes("worker-tooling"), "a standing engineer is never a candidate for ending");
  const dir = mkdtempSync(join(tmpdir(), "wake-spare-"));
  try {
    const path = join(dir, "sessions.json");
    writeFileSync(path, JSON.stringify({ live: [
      { name: "zed", role: "engineer", spare: true }, { name: "worker-4", role: "engineer" },
      { name: "boss", role: "ceo", spare: true }, { name: "alpha", role: "engineer", spare: true },
    ] }));
    assert.deepEqual(spareRoles(path), ["zed", "alpha"],
      "the file's mark decides, not the name -- and a decision-holder carrying the mark is still not ended");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2323 (1) ACCEPTANCE: an idle spare whose only row is closed has its workspace CLOSED and one line written", () => {
  const { got, herdr, cycles } = finishedSpare();
  assert.deepEqual(herdr.closed(), ["--session org workspace close wD"]);
  assert.deepEqual(cycles, [{ role: "worker-4", row: 2323, at: T0, clean: true,
    why: "#2323 closed; no open row carries session:worker-4; no worktree left" }]);
  assert.deepEqual(got.ended, cycles);
  assert.equal(got.registry["worker-4"], undefined, "the instance is forgotten, so the next spawn starts a fresh one");
});

test("#2323 (1) `done` ends too -- it is a finished turn nobody has looked at, the other state WAKEABLE names", () => {
  assert.equal(finishedSpare({ status: "done" }).herdr.closed().length, 1);
});

test("#2323 (1) POSITIVE CONTROLS: the same fixture is NOT ended while the row is open, the spare is working, or the role is standing", () => {
  assert.equal(finishedSpare({ heldRows: () => [2323] }).herdr.closed().length, 0, "the row is still held");
  for (const status of ["working", "blocked", "unknown"]) {
    const { herdr, cycles } = finishedSpare({ status });
    assert.deepEqual([herdr.closed(), cycles], [[], []], `${status} is not between turns`);
  }
  // A STANDING engineer, idle, with a registry entry that says it held a row: not in `spares`, so never touched.
  const herdr = teardownHerdr([{ label: "worker-tooling", workspace_id: "w9", agent_status: "idle" }]);
  const got = endFinishedSpares(agents({ "worker-tooling": "idle" }), { spares: spareRoles(),
    registry: { "worker-tooling": { spawnedAt: T0 - HOUR, rows: [1] } }, now: T0, run: herdr.run,
    heldRows: () => [], rowState: () => "CLOSED", worktrees: () => [], record: () => {}, warn: () => {} });
  assert.deepEqual([herdr.closed(), got.ended], [[], []]);
  // And the fixture it is a control FOR really does end, or the four assertions above pass on a fixture that never could.
  assert.equal(finishedSpare().herdr.closed().length, 1);
});

test("#2323 (2): an instance that has NEVER held a row is not ended, and is ADOPTED with its clock starting now", () => {
  const { got, herdr, cycles } = finishedSpare({ registry: {} });
  assert.deepEqual([herdr.closed(), cycles], [[], []]);
  assert.deepEqual(got.registry["worker-4"], { spawnedAt: T0, rows: [] });
  const young = finishedSpare({ registry: { "worker-4": { spawnedAt: T0 - 60_000, rows: [] } } });
  assert.deepEqual([young.herdr.closed(), young.cycles], [[], []], "idle in its first turn is not a defect");
});

test("#2323 (2): one that never claims within its bound is recorded `clean: false` with a why -- and ended, not left", () => {
  const { herdr, cycles } = finishedSpare({
    registry: { "worker-4": { spawnedAt: T0 - SPARE_CLAIM_BOUND_MS - 1, rows: [] } } });
  assert.equal(herdr.closed().length, 1);
  assert.deepEqual(cycles, [{ role: "worker-4", row: null, at: T0, clean: false,
    why: "never claimed a row in 30 minutes" }]);
});

test("#2323: a row seen while the instance holds it is REMEMBERED, because closing it removes the only label naming it", () => {
  const { got, herdr } = finishedSpare({ status: "working", registry: { "worker-4": { spawnedAt: T0, rows: [] } },
    heldRows: () => [2323] });
  assert.deepEqual(got.registry["worker-4"], { spawnedAt: T0, rows: [2323] });
  assert.equal(herdr.closed().length, 0);
});

test("#2323: a lookup that cannot ask ends NOTHING, a close that fails is not recorded, and an ambiguous label is not guessed", () => {
  const blind = finishedSpare({ heldRows: () => null });
  assert.deepEqual([blind.herdr.closed(), blind.cycles], [[], []]);
  assert.match(blind.warned[0], /could not read the rows "worker-4" holds -- leaving it running/);

  const stuck = finishedSpare({ refuseClose: true });
  assert.deepEqual(stuck.cycles, [], "no line for an ending that did not happen");
  assert.ok(stuck.got.registry["worker-4"], "so the next tick retries it");
  assert.match(stuck.warned[0], /could not be closed \(herdr: refused\)/);
  assert.ok(!stuck.warned[0].includes("stack"), "the excerpt is the first line only");

  const twice = teardownHerdr([{ label: "worker-4", workspace_id: "wD", agent_status: "idle" },
    { label: "worker-4", workspace_id: "wG", agent_status: "idle" }]);
  const got = endFinishedSpares(agents({ "worker-4": "idle" }), { spares: spareRoles(),
    registry: { "worker-4": { spawnedAt: T0, rows: [2323] } }, now: T0, run: twice.run, heldRows: () => [],
    rowState: () => "CLOSED", worktrees: () => [], record: () => {}, warn: () => {} });
  assert.deepEqual([twice.closed(), got.ended], [[], []]);
});

test("#2323 (3): `clean` is decided by cycleVerdict -- closed rows, nothing labelled, worktree clean AND merged", () => {
  const tree = { path: "/r/wt-2323", clean: true as boolean | "unknown", merge: "merged" as "merged" | "not-merged" | "unknown" };
  const base = { role: "worker-4", rows: [{ number: 2323, state: "CLOSED" }], held: [] as number[], worktrees: [tree] };
  assert.deepEqual(cycleVerdict(base), { clean: true,
    why: "#2323 closed; no open row carries session:worker-4; worktree clean and merged" });
  const why = (over: object) => cycleVerdict({ ...base, ...over }).why;
  assert.equal(cycleVerdict({ ...base, rows: [{ number: 2323, state: "OPEN" }] }).clean, false,
    "an open row that lost its label was RELEASED, which left work behind");
  assert.match(why({ rows: [{ number: 2323, state: "OPEN" }] }), /#2323 is open, not closed/);
  assert.match(why({ held: [2400] }), /session:worker-4 still labels #2400/);
  assert.match(why({ worktrees: [{ ...tree, clean: false }] }), /\/r\/wt-2323 has uncommitted changes/);
  assert.match(why({ worktrees: [{ ...tree, merge: "not-merged" }] }), /not merged into origin\/main/);
  assert.match(why({ worktrees: [{ ...tree, clean: "unknown" }] }), /could not be read/, "unknown is never rounded up to clean");
  assert.match(why({ rows: [{ number: 2323, state: "UNREADABLE" }] }), /#2323 is unreadable, not closed/);
});

test("#2323 (3): spareDecision needs all of `has held a row`, `holds none now` and `between turns`", () => {
  const instance = { spawnedAt: T0 - 5 * HOUR, rows: [2323] };
  assert.deepEqual(spareDecision({ status: "idle", instance, held: [], now: T0 }), { end: true });
  assert.equal(spareDecision({ status: "idle", instance, held: [2323], now: T0 }).end, false);
  assert.equal(spareDecision({ status: "working", instance, held: [], now: T0 }).end, false);
  assert.equal(spareDecision({ status: "idle", instance: { spawnedAt: T0 - 60_000, rows: [] }, held: [], now: T0 }).end, false,
    "the first-turn instance holds no row either, and that alone must not end it");
});

test("#2323 (3): consecutiveClean -- empty says EMPTY, 20 clean is 20, and a failure resets the run", () => {
  const clean = (n: number) => Array.from({ length: n }, () => ({ clean: true }));
  assert.deepEqual(consecutiveClean([]), { run: 0, empty: true },
    "no line is not `0 of 20 clean`: nothing has been measured");
  assert.deepEqual(consecutiveClean([{ clean: false }]), { run: 0, empty: false }, "one failure IS a measurement");
  assert.deepEqual(consecutiveClean(clean(20)), { run: 20, empty: false });
  assert.deepEqual(consecutiveClean([...clean(19), { clean: false }, ...clean(3)]), { run: 3, empty: false });
  assert.equal(consecutiveClean([...clean(20), { clean: false }]).run, 0, "a failure LAST leaves nothing");
});

test("#2323: an unreadable ledger line is a FAILED cycle, so a corrupt line cannot bridge a run of clean ones", () => {
  const raw = `${JSON.stringify({ role: "worker-4", row: 1, at: 1, clean: true, why: "x" })}\nnot json\n`
    + `${JSON.stringify({ role: "worker-4", row: 2, at: 2, clean: true, why: "x" })}\n`;
  const read = readSpareCycles("x", (() => raw) as never);
  assert.equal(read.length, 3);
  assert.equal(consecutiveClean(read).run, 1);
  assert.deepEqual(readSpareCycles("x", (() => { throw Object.assign(new Error("no"), { code: "ENOENT" }); }) as never), []);
});

test("#2323 (4): the spawn's workspace carries GH_CONFIG_DIR=/home/agent/workers/gh, and an explicit override wins", () => {
  assert.equal(WORKERS_GH_CONFIG_DIR, "/home/agent/workers/gh");
  assert.deepEqual(spawnEnvironment(), { GH_CONFIG_DIR: "/home/agent/workers/gh" });
  assert.deepEqual(spawnEnvironment({ GH_CONFIG_DIR: "/home/agent/leads/gh" }), { GH_CONFIG_DIR: "/home/agent/leads/gh" });

  const h = recordingHerdr();
  deliver([ROW_ORDER], NOBODY, ROSTER, { run: h.run });
  assert.deepEqual(h.said("workspace create"),
    ["--session org workspace create --label worker-capture --no-focus --env GH_CONFIG_DIR=/home/agent/workers/gh"],
    "through the production entry: the env is on the call that creates the shell the agent starts in");
  const over = recordingHerdr();
  deliver([ROW_ORDER], NOBODY, ROSTER, { run: over.run, env: spawnEnvironment({ GH_CONFIG_DIR: "/elsewhere" }) });
  assert.match(over.said("workspace create")[0], / --env GH_CONFIG_DIR=\/elsewhere$/);
  assert.ok(!over.said("workspace create")[0].includes("workers/gh"));
});

test("#2323: deliver tells `registerSpawn` about a process it STARTED, and about no other", () => {
  const told: string[] = [];
  deliver([ROW_ORDER], NOBODY, ROSTER, { run: recordingHerdr().run, registerSpawn: (r) => told.push(r) });
  assert.deepEqual(told, ["worker-capture"]);
  const standing: string[] = [];
  deliver([ROW_ORDER], agents({ "worker-judge": "idle" }), ROSTER,
    { run: recordingHerdr().run, registerSpawn: (r) => standing.push(r) });
  assert.deepEqual(standing, [], "a prompt to a standing session starts nothing");
});

test("#2323: registering a spawn over a live entry writes the FAILED cycle the missing teardown left", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-register-"));
  try {
    const paths = sparePathsFrom(join(dir, "wake-ledger"));
    registerSpawn(paths, "worker-4", T0);
    assert.deepEqual(readSpareCycles(paths.cycles), [], "a first spawn leaves nothing behind it");
    registerSpawn(paths, "worker-4", T0 + HOUR);
    const [line] = readSpareCycles(paths.cycles);
    assert.equal(line.clean, false);
    assert.match(line.why, /left without the teardown/);
    assert.deepEqual(JSON.parse(readFileSync(paths.registry, "utf8")), { "worker-4": { spawnedAt: T0 + HOUR, rows: [] } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// THE WIRING, AS PROCESSES. `work-tick` must call the teardown on a QUIET gate (`wake` is never run on one), and
// `wake` must register what it spawns -- neither is reachable by a test that injects the seam.
const TICK_ENTRY = fileURLToPath(new URL("../work-tick.mjs", import.meta.url));

test("#2323 THE TICK: a QUIET gate still ends a finished spare -- work-tick calls the teardown, not just wake", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-tick-spare-"));
  try {
    const ledger = join(dir, "wake-ledger");
    const log = join(dir, "herdr-calls");
    writeFileSync(join(dir, "herdr"), "#!/bin/sh\necho \"$*\" >> " + log + "\ncase \"$*\" in\n  *'workspace list') printf '%s' "
      + `'{"result":{"workspaces":[{"label":"worker-4","workspace_id":"wD","agent_status":"idle"}]}}'`
      + " ;;\n  *) : ;;\nesac\n");
    writeFileSync(join(dir, "gh"), "#!/bin/sh\ncase \"$*\" in\n  \"issue list\"*) printf '%s' '[]' ;;\n"
      + "  \"issue view\"*) printf '%s' '{\"state\":\"CLOSED\"}' ;;\n  *) exit 1 ;;\nesac\n");
    chmodSync(join(dir, "herdr"), STUB_MODE);
    chmodSync(join(dir, "gh"), STUB_MODE);
    writeFileSync(sparePathsFrom(ledger).registry, JSON.stringify({ "worker-4": { spawnedAt: T0, rows: [4242424] } }));
    const ran = spawnSync(process.execPath, [TICK_ENTRY, `--ledger=${ledger}`], { encoding: "utf8",
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });

    assert.match(readFileSync(log, "utf8"), /workspace close wD/, `the tick closed the finished spare; got ${ran.stderr}`);
    assert.match(ran.stderr, /ENDED worker-4 \(#4242424, clean\)/);
    const [line] = readSpareCycles(sparePathsFrom(ledger).cycles);
    assert.deepEqual([line.role, line.row, line.clean], ["worker-4", 4242424, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2323 THE WAKE ENTRY: a spawn is REGISTERED, so the teardown can tell a first turn from a finished one", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-spawn-reg-"));
  try {
    const ledger = join(dir, "wake-ledger");
    mkdirSync(join(dir, "repos"));
    const herdrLog = join(dir, "herdr-calls");
    writeFileSync(join(dir, "herdr"), "#!/bin/sh\necho \"$*\" >> " + herdrLog + "\ncase \"$*\" in\n  *'workspace list') printf '%s' '{\"result\":{\"workspaces\":[]}}' ;;\n"
      + "  *'workspace create'*) printf '%s' '{\"result\":{\"root_pane\":{\"pane_id\":\"wB:p1\"},\"workspace\":{\"workspace_id\":\"wB\"}}}' ;;\n"
      + "  *) : ;;\nesac\n");
    chmodSync(join(dir, "herdr"), STUB_MODE);
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nprintf '%s' '[]'\n");
    chmodSync(join(dir, "gh"), STUB_MODE);
    // #2405: A SPAWN CLAIMS BEFORE IT OPENS A PANE, so the claim's two programs are stubbed too -- `git` makes the
    // role's launch worktree and `node` (which is `row-claim`) makes the row's -- both under `--worktrees-dir`, so the
    // run cannot create `role-worker-4` beside the real checkout.
    writeFileSync(join(dir, "git"), "#!/bin/sh\ncase \"$1\" in\n  worktree) mkdir -p \"$4\" ;;\n  *) : ;;\nesac\n");
    writeFileSync(join(dir, "node"), "#!/bin/sh\nmkdir -p ../wt-2131\necho 'STARTED -- #2131 fixture'\n");
    chmodSync(join(dir, "git"), STUB_MODE);
    chmodSync(join(dir, "node"), STUB_MODE);
    const ran = spawnSync(process.execPath, [WAKE_ENTRY, `--ledger=${ledger}`, "--roster=worker-4",
      `--worktrees-dir=${join(dir, "repos")}`], {
      input: `${JSON.stringify(ROW_ORDER)}\n`, encoding: "utf8",
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });
    assert.match(ran.stdout, /WOKE worker-4 <- engineers\/ready-row-unclaimed\/2131 \(STARTED sonnet\/high\)/, ran.stderr);
    // #2405: THE WIRING -- `main` hands `deliver` the claimer, so the pane opens in the worktree the claim made.
    assert.match(readFileSync(herdrLog, "utf8"), new RegExp(`workspace create .*--cwd ${join(dir, "repos", "wt-2131")}( |$)`, "m"));
    const registry = JSON.parse(readFileSync(sparePathsFrom(ledger).registry, "utf8"));
    assert.deepEqual(Object.keys(registry), ["worker-4"]);
    assert.deepEqual(registry["worker-4"].rows, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2323: spareWorktrees reads the tree the ROLE made for the ROW from git -- stamped, named, merged and clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-trees-"));
  const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv() });
  try {
    const repo = join(dir, "repo");
    git(dir, "init", "-q", repo);
    writeFileSync(join(repo, ".gitignore"), ".a11y-owner\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const make = (row: number, owner: string) => {
      const path = join(dir, `wt-${row}`);
      git(repo, "worktree", "add", "-q", "-b", `agent/thing-${row}`, path);
      writeFileSync(join(path, ".a11y-owner"), `${owner}\n`);
      return path;
    };
    const mine = make(7001, "worker-4");
    make(7002, "worker-5"); // a different role's tree for a different row
    make(7003, "worker-4"); // this role's tree for a row this instance never held

    const found = spareWorktrees({ role: "worker-4", rows: [7001], repoRoot: repo });
    assert.deepEqual(found.map((t) => [t.path.replace(/^\/private/, ""), t.clean, t.merge]),
      [[mine.replace(/^\/private/, ""), true, "merged"]], "only this role's tree for this row, and never the primary");

    writeFileSync(join(mine, "scratch.txt"), "uncommitted\n");
    assert.equal(spareWorktrees({ role: "worker-4", rows: [7001], repoRoot: repo })[0].clean, false);
    git(mine, "add", "scratch.txt");
    git(mine, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ahead");
    assert.equal(spareWorktrees({ role: "worker-4", rows: [7001], repoRoot: repo })[0].merge, "not-merged",
      "a commit origin/main lacks is work left behind, not a clean cycle");
    assert.deepEqual(spareWorktrees({ role: "worker-4", rows: [9999], repoRoot: repo }), [],
      "no row of this instance's names a tree: nothing was left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
