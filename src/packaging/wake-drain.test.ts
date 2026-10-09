// no-token: gh -- every `gh` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * #2324: the standing engineers are DRAINED, and a spawn is only made for a row that would pass the claim
 * (`ceo`, #1950 rulings b and d). Its own file, and not a block in `wake.test.ts`, for #2280's reason (and as
 * #2323's `wake-spare-teardown.test.ts` did): that file reaches `route`, which reaches `gh`, so the token-less
 * acceptance job refused it and verified nothing. Every fact read here -- herdr, GitHub, the two ledgers -- is
 * injected or stubbed on PATH, so the row's Acceptance is a command the job can RUN.
 */
import { TSX_IMPORT } from "../tsx-import.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync, readdirSync, cpSync } from "node:fs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { startedPanes } from "./started-pane.ts";

// --- (#3233) THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE, NOT A11IGN'S CHECKOUT ---
//
// Every reader below resolves the project it serves from `$AGENT_ORG_HOST` AT IMPORT (`HOME_CHECKOUT`), and without it the layout answers a11ign's live
// checkout: its `sessions.json`, its declaration, its `package.json`. A verdict that moves when a11ign merges is not a verdict about this tool (agent-org #77
// and #79). So the host file is set FIRST and the tool is imported AFTER it, dynamically, and the project is `fixtures/wake-drain/project`, copied into a
// temp directory so no `git` the tool asks resolves to the repository this file sits in. The children it spawns inherit the variable.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "wake-drain-roster-"));
after(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));
const PROJECT = join(FIXTURE_DIR, "project");
cpSync(fileURLToPath(new URL("./fixtures/wake-drain/project", import.meta.url)), PROJECT, { recursive: true });
// The project is a REPOSITORY tracking `packages/`, because `trackedTopLevelDirs` asks git in the PROJECT's checkout (#3366): a Region path such as
// `packages/agent-org/src/wake.ts` below is read as a path only when its first directory is tracked THERE, and a directory that is no repository
// answers nothing, so the claim's Region lookup failed open and every "refused" test below spawned.
mkdirSync(join(PROJECT, "packages/agent-org/src"), { recursive: true });
writeFileSync(join(PROJECT, "packages/agent-org/src/wake.ts"), "");
for (const args of [["init", "--quiet"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "fixture"]]) {
  execFileSync("git", args, { cwd: PROJECT, env: sandboxGitEnv(), stdio: "pipe" });
}
const HOST_FILE = join(FIXTURE_DIR, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: FIXTURE_DIR, binDir: join(FIXTURE_DIR, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(FIXTURE_DIR, "workers"), leads: join(FIXTURE_DIR, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { homeProjectDeclaration } = await import("../project-config.ts");
const { copyToolAndProject, importClosure, toolFile } = await import("./copied-tool-fixture.ts");
const { deliver: settlingDeliver, route, withSpareInstances, engineerRoles, engineerEligibility, spawnableRole, EXIT,
  activeDrain, drainedRoles, drainInForce, cyclesReport, spawnClaimability, rowOfOrder, DRAINED_SEEN,
  CLEAN_CYCLES_TARGET, readSpareCycles, sparePathsFrom, spareRoles } = await import("../wake.ts");
const { drainReason } = await import("../row-claim/runner-rule.ts");
const { claimRow } = await import("../row-claim.ts");
/** #2546: a test that is not ABOUT the clear's five-second settle does not wait it; `wake-clear-settle.test.ts` pins the delay. */
const noSettle = () => {};
const deliver: typeof settlingDeliver = (orders, agents, roster, deps) => settlingDeliver(orders, agents, roster, { ...deps, sleep: noSettle });


const agents = (spec: Record<string, string>) =>
  Object.entries(spec).map(([label, status]) => ({ label, status }));
const STANDING = ["worker-capture", "worker-judge", "worker-tooling"];
const WAKE_ENTRY = fileURLToPath(new URL("../wake.ts", import.meta.url));
const ALL_IDLE = agents(Object.fromEntries(STANDING.map((r) => [r, "idle"])));

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

// --- #2324: DRAIN THE THREE STANDING ENGINEERS, AND SPAWN ONLY FOR A ROW THAT WOULD PASS THE CLAIM ---
//
// Driven through `deliver`, the production entry, with `sessions.json` itself as the source of the drain: a test
// that handed `deliver` a literal list would pass with the field deleted from the file. The controls are the same
// fixture with ONE thing changed each -- the field, the ledger line, the edge -- so the thing that flipped the
// outcome is named by the test and not inferred from it.

const SESSIONS_JSON = ".agent-org/roles/sessions.json";

/**
 * THE ROSTER AS IT WAS BEFORE #2505, AS A FIXTURE. The drain mechanism outlived its only user: #2505 retired the three
 * standing engineers, so a11ign's real file marks NO role `drain` and every test below that needs a drained role would have
 * nothing to drain. The fixture project's roster is that file as it stood at `90b65b787` -- the three standing engineers
 * `role: "engineer"`, `drain: true`, in file order, before the spare family -- so `engineerRoles`, `drainedRoles`,
 * `activeDrain` and the row-claim CLI are each driven through the READER of a file that marks them, not through a
 * literal list. That a11ign's own file marks none is a11ign's invariant (#3233), not this suite's.
 */
const DRAINED_SESSIONS = join(PROJECT, SESSIONS_JSON);
const DRAINED_SESSIONS_TEXT = readFileSync(DRAINED_SESSIONS, "utf8");
/** What `engineerRoles` reads from the fixture: the standing three, as `wake` offered work to them. */
const DRAINED_ROSTER = engineerRoles(DRAINED_SESSIONS);
// #2407: a line carries `rows`, and only a clean line with exactly ONE row counts -- a fixture without it is legacy.
const CLEAN_CYCLE = JSON.stringify({ role: "worker-4", row: 2131, at: 1, rows: [2131], clean: true, why: "fixture" });
const FAILED = JSON.stringify({ role: "worker-4", row: 2131, at: 2, rows: [2131], clean: false, why: "fixture" });

/** A ledger file's text as `activeDrain`'s `read` -- cast once here, since a `readFileSync` overload set is not a lambda. */
const reading = (text: string) => (() => text) as unknown as typeof readFileSync;

/** The tick's own wiring for the drain: what `main` builds from the two files and hands `deliver`. */
function drainDeps(drained: string[]) {
  return { drained, ineligibleReason: engineerEligibility({ drained, lookup: () => [] }) };
}

/** The fixture roster, except the `drain` field is gone -- the control for "the field is what changed". */
function withoutDrainField(dir: string): string {
  const file = JSON.parse(DRAINED_SESSIONS_TEXT) as { live: { drain?: boolean }[] };
  for (const s of file.live) delete s.drain;
  const path = join(dir, "sessions-undrained.json");
  writeFileSync(path, JSON.stringify(file));
  return path;
}

test("#2505: the drain reader finds the mark in a roster that has one, and finds none in the same roster without it", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-drain-reader-"));
  try {
    assert.deepEqual(drainedRoles(DRAINED_SESSIONS), STANDING, "the fixture marks exactly the three standing engineers");
    // The positive control for the emptiness below: the very reader that found three finds none once the field is gone.
    assert.deepEqual(drainedRoles(withoutDrainField(dir)), []);
    assert.deepEqual(DRAINED_ROSTER, STANDING, "and lists them, in file order, ahead of the family");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2324: a spare is never marked drained", () => {
  const spares = (JSON.parse(DRAINED_SESSIONS_TEXT) as { live: { name: string, spare?: boolean }[] }).live.filter((e) => e.spare === true).map((e) => e.name);
  assert.ok(spares.length > 0, "POSITIVE CONTROL: the roster has a spare, or the emptiness below is two empty lists agreeing");
  assert.deepEqual(spares.filter((r) => drainedRoles(DRAINED_SESSIONS).includes(r)), [], "a spare is disposable and is ended by the teardown; draining one would leave no role to spawn into");
  assert.deepEqual(spareRoles(DRAINED_SESSIONS).filter((r) => drainedRoles(DRAINED_SESSIONS).includes(r)), []);
});

test("#2324 (1) ACCEPTANCE: all three standing engineers IDLE and drained -> `deliver` starts a spare, prompting no standing one", () => {
  const h = recordingHerdr();
  const drained = activeDrain({ cycles: "x", read: reading(""), sessions: DRAINED_SESSIONS });
  const got = deliver([ROW_ORDER], ALL_IDLE, DRAINED_ROSTER, { run: h.run, ...drainDeps(drained) });

  assert.deepEqual(got.sent, ["worker-2131 <- engineers/ready-row-unclaimed/2131 (STARTED sonnet/high)"]);
  assert.deepEqual(got.refused, []);
  assert.equal(h.said("agent prompt").length, 1);
  assert.ok(h.said("agent prompt")[0].includes("agent prompt worker-2131 "), "the one prompt went to the spare");
  assert.deepEqual(h.said("/clear"), [], "no standing engineer was cleared, let alone prompted");
});

test("#2324 (1) POSITIVE CONTROL: the same fixture with the `drain` field REMOVED prompts the idle standing engineer", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-drain-"));
  try {
    const h = recordingHerdr();
    const drained = activeDrain({ cycles: "x", read: reading(""), sessions: withoutDrainField(dir) });
    assert.deepEqual(drained, [], "nothing else changed: the field is the only difference");
    const got = deliver([ROW_ORDER], ALL_IDLE, DRAINED_ROSTER, { run: h.run, ...drainDeps(drained) });

    assert.deepEqual(got.sent, ["worker-capture <- engineers/ready-row-unclaimed/2131"],
      "the first idle standing engineer takes it, exactly as before this row");
    assert.deepEqual(h.said("workspace create"), [], "and nothing was spawned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2324: with every spare taken, the drained three are STILL not offered the row, and the refusal names the drain", () => {
  const h = recordingHerdr();
  // #2403: the spares are a FAMILY, so the five that hold a process are named here, not read off the roster.
  const spares = ["worker-4", "worker-5", "worker-6", "worker-7", "worker-8"];
  const everyone = agents(Object.fromEntries([...DRAINED_ROSTER, ...spares].map((r) => [r, STANDING.includes(r) ? "idle" : "working"])));
  // The refusal `route` reports is what names the drain, and #2403 means `deliver` no longer STOPS at it: the pool
  // has no ceiling, so the row goes to a fresh `worker-2131` (named for the row, #2469) and the drained three are still never prompted.
  const routed = route("engineers", everyone, withSpareInstances(DRAINED_ROSTER, everyone), engineerEligibility({ drained: drainedRoles(DRAINED_SESSIONS) }));
  assert.match(String((routed as { refusal: string }).refusal), /no engineer is idle and allowed to claim \(worker-capture=drained \(#2324\), worker-judge=drained \(#2324\), worker-tooling=drained \(#2324\), worker-4=working/);
  assert.ok(String((routed as { refusal: string }).refusal).includes(DRAINED_SEEN));

  const got = deliver([ROW_ORDER], everyone, DRAINED_ROSTER, { run: h.run, ...drainDeps(drainedRoles(DRAINED_SESSIONS)) });
  assert.deepEqual(got.sent, ["worker-2131 <- engineers/ready-row-unclaimed/2131 (STARTED sonnet/high)"]);
  assert.ok(h.said("agent prompt").every((line) => line.includes("worker-2131")),
    "the row falls to the new instance, never to a drained engineer");
});

test("#2324: a drained role is never SPAWNED INTO either, even when its own process is absent", () => {
  // `spawnableRole` starts into the first ABSENT role. A drained standing role that died is absent, and an
  // instance started under its address would be refused at the claim and sit holding it.
  const got = spawnableRole(ROW_ORDER, NOBODY, DRAINED_ROSTER, STANDING);
  assert.deepEqual(got, { role: "worker-2131" });
  assert.deepEqual(spawnableRole(ROW_ORDER, NOBODY, DRAINED_ROSTER), { role: "worker-capture" },
    "control: without the drain the first absent role is the standing one, as it always was");
});

test("#2324 (2): a drained role holding a row still receives the orders about THAT row; only a new-row order skips it", () => {
  const h = recordingHerdr();
  const aboutItsRow = { session: "worker-judge", cause: "review-verdict", causeKey: "worker-judge/review-verdict/2100",
    prompt: "PR #2100 has CHANGES_REQUESTED." };
  const got = deliver([aboutItsRow, ROW_ORDER], ALL_IDLE, DRAINED_ROSTER, { run: h.run, ...drainDeps(drainedRoles(DRAINED_SESSIONS)) });

  assert.deepEqual(got.sent, [
    "worker-judge <- worker-judge/review-verdict/2100",
    "worker-2131 <- engineers/ready-row-unclaimed/2131 (STARTED sonnet/high)",
  ], "the named order reached the drained engineer; the pool order went to a spare");
  assert.deepEqual(got.refused, []);
});

test("#2324: drainInForce -- in force until the NEWEST line fails, and an empty ledger is in force", () => {
  assert.equal(drainInForce([]), true, "nothing has failed, and nothing else would ever start the count");
  assert.equal(drainInForce([{ clean: true }, { clean: true }]), true);
  assert.equal(drainInForce([{ clean: true }, { clean: false }]), false);
  assert.equal(drainInForce([{ clean: false }, { clean: true }]), true, "the MOST RECENT line decides, not the worst");
});

test("#2324 (4) ACCEPTANCE: with the last ledger line `clean: false` the same fixture prompts the standing engineer", () => {
  const h = recordingHerdr();
  const lifted = activeDrain({ cycles: "x", read: reading(`${CLEAN_CYCLE}\n${FAILED}\n`), sessions: DRAINED_SESSIONS });
  assert.deepEqual(lifted, [], "the drain lifted itself: nobody edited sessions.json");
  const got = deliver([ROW_ORDER], ALL_IDLE, DRAINED_ROSTER, { run: h.run, ...drainDeps(lifted) });

  assert.deepEqual(got.sent, ["worker-capture <- engineers/ready-row-unclaimed/2131"]);
  assert.deepEqual(h.said("workspace create"), []);
  // ...and it is the LEDGER that decided, not the roster: the same file with a clean last line drains again.
  assert.deepEqual(activeDrain({ cycles: "x", read: reading(`${FAILED}\n${CLEAN_CYCLE}\n`), sessions: DRAINED_SESSIONS }), STANDING);
});

test("#2324: an unreadable ledger line is a FAILED cycle, so it lifts the drain instead of hiding behind the last clean one", () => {
  assert.deepEqual(activeDrain({ cycles: "x", read: reading(`${CLEAN_CYCLE}\nnot json\n`), sessions: DRAINED_SESSIONS }), []);
});

// --- the precheck: no instance is created to be refused and sit idle ---

/** A `gh` that answers the claim's three reads for row 2131: its blockedBy edge, its Region, and the open PRs. */
function claimGh({ edge = "OPEN", prFiles = ["packages/agent-org/src/wake.ts"] as string[] | null,
  region = "packages/agent-org/src/wake.ts" } = {}) {
  const calls: string[] = [];
  const run = (args: string[]): string => {
    calls.push(args.slice(0, 2).join(" "));
    const fields = args[args.indexOf("--json") + 1];
    if (args[0] === "issue" && fields === "blockedBy") {
      return JSON.stringify({ blockedBy: { nodes: edge === "NONE" ? [] : [{ number: 2323, state: edge }] } });
    }
    if (args[0] === "issue" && fields === "body") return JSON.stringify({ body: `## Region\n\n\`\`\`\n${region}\n\`\`\`\n` });
    if (args[0] === "pr" && args[1] === "list") {
      if (prFiles === null) throw new Error("gh: pr list failed");
      return JSON.stringify([{ number: 2300, changedFiles: prFiles.length, files: prFiles.map((path) => ({ path })),
        body: "Closes #2299" }]);
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { run, calls };
}

const SPAWNING = (claimable: (o: { causeKey: string }) => string | null) => {
  const h = recordingHerdr();
  const got = deliver([ROW_ORDER], NOBODY, ["worker-4"], { run: h.run, claimable });
  return { h, got };
};

test("#2324: rowOfOrder reads the row from the pool order's causeKey, and only from that shape", () => {
  assert.equal(rowOfOrder(ROW_ORDER), 2131);
  assert.equal(rowOfOrder({ causeKey: "engineers/draft-awaiting-verdict/2131x" }), null);
});

test("#2324 (5) ACCEPTANCE: an open blockedBy edge starts NO spawn, and the refusal names the #1886 check", () => {
  const gh = claimGh({ edge: "OPEN" });
  const { h, got } = SPAWNING(spawnClaimability({ run: gh.run }));

  assert.deepEqual(h.said("workspace create"), [], "no pane was opened for a row the claim would refuse");
  assert.deepEqual(got.sent, []);
  assert.match(got.refused[0], /no spawn: #2131 would be refused at the claim by the `blockedBy` check \(#1886\): blocked by still-open #2323/);
});

test("#2324 (5) POSITIVE CONTROL: the same row with the edge CLOSED spawns", () => {
  const gh = claimGh({ edge: "CLOSED", prFiles: [] });
  const { h, got } = SPAWNING(spawnClaimability({ run: gh.run }));
  assert.deepEqual(got.sent, ["worker-4 <- engineers/ready-row-unclaimed/2131 (STARTED sonnet/high)"]);
  assert.equal(h.said("workspace create").length, 1);
});

test("#2324 (5): a Region that overlaps an open PR's files starts NO spawn, and the refusal names the B4 check", () => {
  const gh = claimGh({ edge: "NONE" });
  const { h, got } = SPAWNING(spawnClaimability({ run: gh.run }));

  assert.deepEqual(h.said("workspace create"), []);
  assert.match(got.refused[0], /no spawn: #2131 would be refused at the claim by the file-overlap check \(B4\): overlaps #2300, which already touches: packages\/agent-org\/src\/wake\.ts/);
});

test("#2324 (5) POSITIVE CONTROL: the same row against a PR touching OTHER files spawns", () => {
  const gh = claimGh({ edge: "NONE", prFiles: ["docs/elsewhere.md"] });
  const { got } = SPAWNING(spawnClaimability({ run: gh.run }));
  assert.deepEqual(got.sent, ["worker-4 <- engineers/ready-row-unclaimed/2131 (STARTED sonnet/high)"]);
});

test("#2324: the open-PR list is read ONCE per tick however many rows are asked, and never for a row with no Region", () => {
  const gh = claimGh({ edge: "NONE", prFiles: ["docs/elsewhere.md"] });
  const check = spawnClaimability({ run: gh.run });
  assert.equal(check({ causeKey: "engineers/ready-row-unclaimed/2131" }), null);
  assert.equal(check({ causeKey: "engineers/ready-row-unclaimed/2132" }), null);
  // ONE READ PER DECLARED CODE REPOSITORY, and still not one per row: two rows asked, so a per-row read would make four (#2969 declared a second).
  const repositories = homeProjectDeclaration().code.length;
  assert.ok(repositories >= 2, "POSITIVE CONTROL: with one repository this assertion could not tell a per-row read from a per-tick one");
  assert.equal(gh.calls.filter((c) => c === "pr list").length, repositories);
  const none = claimGh({ edge: "NONE", region: "" });
  assert.equal(spawnClaimability({ run: none.run })({ causeKey: "engineers/ready-row-unclaimed/2131" }), null);
  assert.equal(none.calls.filter((c) => c === "pr list").length, 0, "no Region to compare, so the expensive read is skipped");
});

// --- #3566, slice 9b: THE WAKE'S OPEN-PR READ GOES OUT TOGETHER, AND ONLY WHEN IT IS THE REAL `gh` ---
//
// `spawnClaimability`'s default `run` is the wake's own `gh`, and only that one is handed the gate's batch: a test's fake `run` stands for `gh` and
// must see its calls one at a time (every test above). So the overlap can only be SEEN through a real `gh` on PATH, which here is a stub that
// stamps when each `pr list` started and ended.
//
// THE STUB MAKES THE OVERLAP A CONDITION, NOT A MARGIN (#3861). It used to pause 100 ms or 400 ms and the test asserted that every read had STARTED
// before any ENDED, which held only while the slowest `node` start-up fell inside the fast read's 100 ms: at host load 24 to 33 it did not, and the
// test went red on correct code (4 of 6 runs). Now no read answers until every declared repository's read has stamped its start, and the first
// repository's read (which must finish LAST, so a merge in finishing order would differ from the repositories' own order) also waits for every other
// read's end. A reader that reads one by one can never satisfy that wait, so it runs out the give-up and the stamps show it; a reader that reads
// together satisfies it however slowly the scheduler starts the processes. The give-up is long so a loaded host cannot trip it, and it is spent
// only by the failure the test exists to catch.
const STUB_GIVE_UP_MS = 15_000;
const STUB_POLL_MS = 5;
const STUB_GH = `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const json = args[args.indexOf("--json") + 1];
const send = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "issue" && json === "blockedBy") send({ blockedBy: { nodes: [] } });
else if (args[0] === "issue" && json === "body") send({ body: "## Region\\n\\n\`\`\`\\npackages/agent-org/src/wake.ts\\n\`\`\`\\n" });
else if (args[0] === "pr" && args[1] === "list") {
  const repo = args[args.indexOf("--repo") + 1];
  const giveUp = Date.now() + ${STUB_GIVE_UP_MS};
  const stamp = (what) => appendFileSync(process.env.STUB_LOG, what + " " + repo + " " + Date.now() + "\\n");
  const stamped = (what) => readFileSync(process.env.STUB_LOG, "utf8").split("\\n").filter((line) => line.startsWith(what + " ")).length;
  const until = (what, count, then) => (stamped(what) >= count || Date.now() > giveUp ? then() : setTimeout(until, ${STUB_POLL_MS}, what, count, then));
  const others = Number(process.env.STUB_EXPECT) - 1;
  const slow = repo === process.env.STUB_SLOW;
  const answer = () => {
    stamp("end");
    if (repo === process.env.STUB_REFUSE) { process.stderr.write("gh: HTTP 502\\n"); process.exit(1); }
    send([{ number: slow ? 2300 : 2301, changedFiles: 1, files: [{ path: "packages/agent-org/src/wake.ts" }], body: "" }]);
  };
  stamp("start");
  until("start", others + 1, () => (slow ? until("end", others, answer) : answer()));
} else { process.stderr.write("unexpected gh call: " + args.join(" ")); process.exit(2); }
`;

/** Runs `spawnClaimability()` with its DEFAULT `run` against the stub; returns the verdict, what was said, and the stamped starts and ends. */
function readThroughStubGh(refuse: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "wake-open-prs-"));
  const saved = { PATH: process.env.PATH, STUB_LOG: process.env.STUB_LOG, STUB_EXPECT: process.env.STUB_EXPECT, STUB_SLOW: process.env.STUB_SLOW, STUB_REFUSE: process.env.STUB_REFUSE };
  try {
    writeFileSync(join(dir, "gh"), STUB_GH);
    chmodSync(join(dir, "gh"), 0o755);
    const repos = homeProjectDeclaration().code.map(({ repo }) => repo);
    Object.assign(process.env, { PATH: `${dir}:${saved.PATH ?? ""}`, STUB_LOG: join(dir, "stamps"), STUB_EXPECT: String(repos.length), STUB_SLOW: repos[0], STUB_REFUSE: refuse ?? "" });
    const said: string[] = [];
    const verdict = spawnClaimability({ warn: (line) => said.push(line) })({ causeKey: "engineers/ready-row-unclaimed/2131" });
    const stamps = readFileSync(join(dir, "stamps"), "utf8").trim().split("\n").map((l) => l.split(" "))
      .map(([what, repo, at]) => ({ what, repo, at: Number(at) }));
    return { verdict, said, stamps, repos };
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#3566 (9b): the wake's open-pull-request reads of every declared repository are IN FLIGHT TOGETHER, and the answer is the one read one by one gave", () => {
  const { verdict, stamps, repos } = readThroughStubGh(null);
  assert.ok(repos.length >= 2, "POSITIVE CONTROL: with one repository there is nothing to overlap");
  const starts = stamps.filter((s) => s.what === "start").map((s) => s.at);
  const ends = stamps.filter((s) => s.what === "end").map((s) => s.at);
  assert.equal(starts.length, repos.length, "every declared repository was read, once");
  // `<=`, not `<`: the barrier lets a read end the moment the last one has started, and the stamps are whole milliseconds, so they may tie. A read
  // that waited for another to FINISH before it began is a give-up (15 s) later, which no tie can hide.
  assert.ok(Math.max(...starts) <= Math.min(...ends), `every read started before any finished (starts ${starts}, ends ${ends})`);
  // The first repository's read finishes LAST, so a merge in the order the reads finish would name #2301; the repositories' own order names #2300.
  assert.match(String(verdict), /overlaps #2300, which already touches: packages\/agent-org\/src\/wake\.ts/);
});

test("#3566 (9b): one refused repository still leaves the read INCONCLUSIVE with its own line, and the row is offered a spawn", () => {
  const { verdict, said, repos } = readThroughStubGh("a11ign/agent-org");
  assert.equal(verdict, null, "fail OPEN, as before");
  assert.ok(said.some((line) => line.startsWith(`row-claim: could not read ${repos[1]}'s open pull requests`)), `the refused repository is named: ${said.join(" | ")}`);
  assert.ok(said.some((line) => /^wake: could not read the open pull requests -- offering #2131 a spawn anyway \(B4 fails open\)\.$/.test(line)));
});

test("#2324: a lookup that CANNOT ASK offers the row and SAYS SO, as the claim's own checks do", () => {
  const gh = claimGh({ edge: "NONE", prFiles: null });
  const said: string[] = [];
  const check = spawnClaimability({ run: gh.run, warn: (line) => said.push(line) });
  assert.equal(check({ causeKey: "engineers/ready-row-unclaimed/2131" }), null, "fail OPEN: an outage must not stop spawning");
  assert.match(said.join("\n"), /could not read the open pull requests -- offering #2131 a spawn anyway \(B4 fails open\)/);
});

test("#2324: an order whose row cannot be read is refused rather than spawned for, and says why", () => {
  const check = spawnClaimability({ run: () => { throw new Error("must not be called"); } });
  assert.match(String(check({ causeKey: "engineers/ready-row-unclaimed/none" })), /cannot tell which row/);
});

test("#2324: an order the standing path takes is never prechecked -- the precheck is the SPAWN's, not `route`'s", () => {
  const h = recordingHerdr();
  let asked = 0;
  const got = deliver([ROW_ORDER], ALL_IDLE, DRAINED_ROSTER, { run: h.run, claimable: () => { asked += 1; return "no"; } });
  assert.deepEqual(got.sent, ["worker-capture <- engineers/ready-row-unclaimed/2131"]);
  assert.equal(asked, 0, "no lookup was paid for an order a standing engineer took");
});

// --- `npm run spawn:cycles` ---

test("#2324 (6): an EMPTY ledger is not printed as 0 -- it exits non-zero and says nothing was counted", () => {
  const got = cyclesReport([], STANDING);
  assert.notEqual(got.exit, 0);
  assert.equal(got.stdout, "");
  assert.match(got.stderr, /ledger is EMPTY/);
  assert.match(got.stderr, new RegExp(`NOT 0 of ${CLEAN_CYCLES_TARGET}`));
});

test("#2324 (6): a non-empty ledger prints the run length, the last line and the drain's state", () => {
  const ledger = [JSON.parse(FAILED), JSON.parse(CLEAN_CYCLE), JSON.parse(CLEAN_CYCLE)];
  const got = cyclesReport(ledger, STANDING);
  assert.equal(got.exit, 0);
  assert.match(got.stdout, /clean cycles in the current run: 2 of 20\n/);
  assert.ok(got.stdout.includes(`last ledger line: ${JSON.stringify(ledger[2])}`));
  assert.match(got.stdout, /drain: IN FORCE on worker-capture, worker-judge, worker-tooling/);
  const broken = cyclesReport([...ledger, JSON.parse(FAILED)], STANDING);
  assert.match(broken.stdout, /clean cycles in the current run: 0 of 20/, "a failure resets the run to a REAL zero");
  assert.match(broken.stdout, /drain: LIFTED/);
});

const spawnCycles = (dir: string) => spawnSync(process.execPath, [...TSX_IMPORT, WAKE_ENTRY, "--cycles", `--ledger=${join(dir, "wake-ledger")}`],
  { encoding: "utf8", env: { ...process.env, HOME: dir } });

test("#2324 (6): THE COMMAND -- `wake.ts --cycles` on an empty ledger exits non-zero, and reads the ledger the teardown writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-cycles-"));
  try {
    const empty = spawnCycles(dir);
    assert.equal(empty.status, EXIT.ATTENTION);
    assert.match(empty.stderr, /ledger is EMPTY/);
    assert.equal(empty.stdout, "", "no `0` was printed");

    writeFileSync(sparePathsFrom(join(dir, "wake-ledger")).cycles, `${CLEAN_CYCLE}\n${CLEAN_CYCLE}\n${CLEAN_CYCLE}\n`);
    const counted = spawnCycles(dir);
    assert.equal(counted.status, 0);
    assert.match(counted.stdout, /clean cycles in the current run: 3 of 20/);
    assert.deepEqual(readSpareCycles(sparePathsFrom(join(dir, "wake-ledger")).cycles).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #2324: A DRAINED ROLE IS REFUSED A NEW ROW, WITH A REASON THAT NAMES THE DRAIN ---
//
// `wake.ts` stops OFFERING the standing three new rows; this is the other half, because an engineer that finishes
// a row and claims the next one itself keeps the history the design exists to drop. The fact arrives as `drained`
// (what `activeDrain` returns), so the rule cannot disagree with the router about whether the drain is in force.

test("#2324 (3): a drained role is refused with a reason that NAMES the drain, and says what still reaches it", () => {
  const reason = drainReason("worker-judge", STANDING);
  assert.ok(reason);
  assert.match(reason as string, /worker-judge is DRAINED/);
  assert.match(reason as string, /"drain": true/);
  assert.match(reason as string, /sessions\.json/);
  assert.match(reason as string, /rework and review orders on a row you hold still reach you/);
});

test("#2324 (3) POSITIVE CONTROLS: a spare and an undrained role are not refused, and neither is anyone once the drain lifted", () => {
  assert.equal(drainReason("worker-4", STANDING), null, "a spare is not marked drain");
  assert.equal(drainReason("orchestrator", STANDING), null);
  assert.equal(drainReason("worker-judge", []), null, "the drain lifts itself: `activeDrain` returns none after a failed cycle");
});

/** A `gh` for one row that is `ready`, and (once written to) carries the claiming session's labels. */
function claimStub(session: string, { alreadyMine = false } = {}) {
  let labelReads = 0;
  return (_cmd: string, args: string[]): string => {
    if (args[1] === "view" && args.includes("number,title,labels,state")) {
      labelReads += 1;
      const mine = [`session:${session}`, "in-progress"];
      const labels = labelReads === 1 ? ["ready", ...(alreadyMine ? mine : [])] : [...mine, "started", "was-ready"];
      return JSON.stringify({ number: 2324, title: "A row", state: "OPEN", labels: labels.map((name) => ({ name })) });
    }
    // Body and `blockedBy` reads fail: those lookups return null and the claim's checks fail OPEN, which is what
    // lets this fixture reach the one check under test without a canned answer for each.
    if (args[1] === "view") throw new Error("simulated: this fixture answers no body and no blockedBy");
    return "[]";
  };
}
const claimAs = (session: string, drained: string[], alreadyMine = false) =>
  claimRow(2324, session, { run: claimStub(session, { alreadyMine }), moveStatus: () => ({ moved: true }), drained });

test("#2324 (3) ACCEPTANCE: `claimRow` by a drained role is refused, naming the drain, and NOTHING is written", () => {
  const writes: string[][] = [];
  const stub = claimStub("worker-judge");
  const run = (cmd: string, args: string[]) => { if (args[1] === "edit" || args[1] === "comment") writes.push(args); return stub(cmd, args); };
  const got = claimRow(2324, "worker-judge", { run, moveStatus: () => ({ moved: true }), drained: STANDING });
  assert.equal(got.claimed, false);
  assert.match((got as { reason: string }).reason, /worker-judge is DRAINED/);
  assert.deepEqual(writes, [], "a refused claim leaves the row exactly as it found it");
});

test("#2324 (3) POSITIVE CONTROLS through `claimRow`: a spare claims, an empty drain claims, and a drained role RESUMING its own row claims", () => {
  assert.equal(claimAs("worker-4", STANDING).claimed, true, "a spare is not drained");
  assert.equal(claimAs("worker-judge", []).claimed, true, "the same drained role once the drain lifted");
  assert.equal(claimAs("worker-judge", STANDING, true).claimed, true,
    "a row the role already holds is not a NEW row: resuming dispatched -> started must keep working");
});

// THE WIRING, AS A PROCESS. `claimRow` takes `drained` from its caller, and the caller that matters is the CLI: an
// injected seam is exactly what a deleted call goes around, so this drives `row-claim.ts claim` itself with a `gh`
// on PATH and a HOME with no ledger (an empty one keeps the drain in force). CI's plain clone is refused by the
// launch gate, so the printed override is set -- its first users are exactly these tests.
//
// IN A COPY OF ITS OWN CLOSURE, NOT THE CHECKOUT (#2394's first red): the CLI refuses first of all when it CANNOT
// ASK whether its rule is current (`origin/main` unresolvable) and when the rule IS behind, and the acceptance job's
// clone has no `origin/main` at the moment it runs the test, so the real checkout answered `COULD NOT DETERMINE`
// there. It would have gone red locally the day `main` moved a rule file, too. The copy is of the WORKING TREE
// (so a mutation made there is the one under test), is its own one-commit repo, and its `origin/main` is that
// commit -- a truthful "up to date", made in a directory nothing else reads.
const ROW_CLAIM_ENTRY = fileURLToPath(new URL("../row-claim.ts", import.meta.url));
const GH_READY_ROW = `#!/bin/sh
case "$*" in
  *number,title,labels,state*) printf '%s' '{"number":2324,"title":"A row","state":"OPEN","labels":[{"name":"ready"}]}' ;;
  *) exit 1 ;;
esac
`;

// #2606: `git commit` in the fixture forks a DETACHED `git maintenance run --auto --detach` once the repo holds 100
// loose objects (observed with GIT_TRACE2_EVENT on git 2.53: a `child_start` of exactly that argv). That child is the
// probable writer of the ENOTEMPTY on `.git` (CI run 36219190351, attempts 1-3, held #2605 red): its spawn was observed,
// its writing during a teardown was not, and CI's loose-object count was not read. Two independent defences, each pinned below:
// the fixture repo never auto-maintains, and the removal is retried WHOLE while something is still writing.
// `rmSync`'s own `maxRetries` is NOT the second defence: measured on Node 22.22.1, it re-runs the `rmdir` without
// emptying the directory again, so a file the writer created after the scan keeps it failing ENOTEMPTY for every retry
// (10 retries, 5.5s, then the same error). Only running the whole removal again sees the new entry.
const TEARDOWN_ATTEMPTS = 20;
const TEARDOWN_PAUSE_MS = 100;
function removeFixture(dir: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === TEARDOWN_ATTEMPTS) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TEARDOWN_PAUSE_MS);
    }
  }
}

/** Copies the entry's import closure, the rule directory and `sessions.json` into `copyRoot`, as an up-to-date repo. */
function copyClosureAsRepo(copyRoot: string): { entry: string; env: Record<string, string> } {
  // The rule directory is reached by a string `localImports` cannot read (see `copied-tool-fixture.ts` for the project's side).
  const rules = readdirSync(toolFile("src/row-claim")).map((name) => toolFile(`src/row-claim/${name}`));
  const copy = copyToolAndProject(ROW_CLAIM_ENTRY, importClosure(ROW_CLAIM_ENTRY, rules), copyRoot);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd: copyRoot, env: sandboxGitEnv(), stdio: "pipe" });
  // The COPY's roster is the fixture, so the CLI reads a file that marks the standing three drained (see the top).
  mkdirSync(join(copyRoot, dirname(SESSIONS_JSON)), { recursive: true });
  writeFileSync(join(copyRoot, SESSIONS_JSON), DRAINED_SESSIONS_TEXT);
  git("init", "--quiet");
  git("config", "maintenance.auto", "false");
  git("config", "gc.auto", "0");
  git("add", "-A");
  git("commit", "--quiet", "-m", "copy");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return copy;
}

function claimProcess(session: string, ledger: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "row-claim-drain-"));
  try {
    writeFileSync(join(dir, "gh"), GH_READY_ROW);
    chmodSync(join(dir, "gh"), 0o755);
    if (ledger !== null) {
      const path = sparePathsFrom(join(dir, ".cache/a11ign/wake-ledger")).cycles;
      mkdirSync(join(dir, ".cache/a11ign"), { recursive: true });
      writeFileSync(path, ledger);
    }
    const { entry, env } = copyClosureAsRepo(join(dir, "checkout"));
    return spawnSync(process.execPath, [...TSX_IMPORT, entry, "claim", "2324", `--session=${session}`], {
      encoding: "utf8",
      env: { ...sandboxGitEnv(), ...env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}`, A11Y_POLICY_LAUNCH_REASON: "#2324 drives the CLI" },
    });
  } finally {
    removeFixture(dir);
  }
}

// The writer is a separate process that keeps creating files under the fixture's `.git` for a while, which is the shape
// of the detached maintenance child without depending on git's threshold. WITHOUT the whole-removal retry the bare `rmSync` throws ENOTEMPTY.
// (#3233) The sub-directory is made WITHOUT `recursive`, which would re-create `objects`, `.git`, `checkout` and the fixture itself after
// the removal under test had finished, so the control failed "the fixture is gone" about one run in six when forty tests ran beside it.
const GIT_WRITER = `
  const { writeFileSync, mkdirSync } = require("node:fs");
  const dir = process.argv[1];
  const until = Date.now() + 600;
  for (let i = 0; Date.now() < until; i++) {
    try {
      try { mkdirSync(dir + "/d" + (i % 7)); } catch (error) { if (error.code !== "EEXIST") throw error; }
      writeFileSync(dir + "/d" + (i % 7) + "/w" + i, "x");
    } catch (error) { process.exit(0); }
  }
`;

test("#2606 POSITIVE CONTROL: teardown completes while a writer is still creating files inside the fixture's `.git`", () => {
  const dir = mkdtempSync(join(tmpdir(), "row-claim-drain-"));
  const objects = join(dir, "checkout/.git/objects");
  mkdirSync(objects, { recursive: true });
  const writer = spawn(process.execPath, [...TSX_IMPORT, "-e", GIT_WRITER, objects], { stdio: "ignore" });
  try {
    for (const deadline = Date.now() + 5000; readdirSync(objects).length === 0; ) {
      assert.ok(Date.now() < deadline, "the writer never started, so this control would prove nothing");
    }
    removeFixture(dir);
    assert.equal(existsSync(dir), false, "the fixture is gone although a writer was inside it when removal began");
  } finally {
    writer.kill();
    removeFixture(dir);
  }
});

test("#2606: the fixture repo is created with auto-maintenance OFF, so no detached git child outlives its commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "row-claim-drain-"));
  try {
    const { entry } = copyClosureAsRepo(join(dir, "checkout"));
    const config = (key: string) => execFileSync("git", ["config", "--get", key], { cwd: join(dir, "checkout"), env: sandboxGitEnv(), encoding: "utf8" }).trim();
    assert.ok(entry.startsWith(dir), "the copy is the one this test built");
    assert.equal(config("maintenance.auto"), "false");
    assert.equal(config("gc.auto"), "0");
  } finally {
    removeFixture(dir);
  }
});

test("#2324 (3): THE COMMAND -- `row-claim claim` by a drained role refuses naming the drain; a failed cycle lifts it", () => {
  assert.deepEqual(drainedRoles(DRAINED_SESSIONS), STANDING, "the roster the CLI's copy carries is what marks them");
  const drained = claimProcess("worker-judge", null);
  assert.match(drained.stdout, /NOT CLAIMED: worker-judge is DRAINED/, `got stdout ${drained.stdout} stderr ${drained.stderr}`);
  assert.equal(drained.status, 1);

  const failed = `${JSON.stringify({ role: "worker-4", row: 1, at: 1, rows: [1], clean: false, why: "fixture" })}\n`;
  const lifted = claimProcess("worker-judge", failed);
  assert.ok(!/DRAINED/.test(lifted.stdout), `the ledger's failed line lifts the drain in the CLI too; got ${lifted.stdout}`);

  const spare = claimProcess("worker-4", null);
  assert.ok(!/DRAINED/.test(spare.stdout), `a spare is not drained; got ${spare.stdout}`);
});
