// no-token: gh -- every `gh`, `herdr`, `git` and `row-claim` call here is an injected seam (the claim's `exec`, the pane's `run`); nothing imported reaches the real one
/**
 * #2405: A SPAWNED ENGINEER STARTS IN ITS ROW'S WORKTREE, BECAUSE THE SPAWNER CLAIMED THE ROW BEFORE ANY PANE EXISTED.
 *
 * Measured by the chairman watching `worker-6` on 2026-09-24: the pane opened in the primary checkout, which
 * `launchGate` refuses, and its order named `role-worker-6`, which did not exist. Driven through `deliver`, the
 * production entry, with the REAL `spawnClaimer` over a fake host (`exec` for git and row-claim, `exists` for the
 * filesystem) and a recording herdr, so the command lines the claim runs are pinned as well as its outcomes.
 *
 * THE SUCCESS CASE IS THE POSITIVE CONTROL for the refusal and failure cases below it: each of those is the same
 * fixture with ONE thing changed, and each asserts the row is UNCLAIMED again against the fake board -- which the
 * success case shows is not simply always true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver, spawnClaimer, spawnedPrompt, slugOf, registerSpawn, sparePathsFrom, readSpareCycles,
  spawnableRole, spareLabelForRow, withSpareInstances, spawnClaimability, rowRefOfOrder, isSpareRole, spareInstances, endFinishedSpares,
  WORKERS_GH_CONFIG_DIR, HOST_REPOS, PRIMARY_CHECKOUT } from "./wake.ts";
import { familyMember, isLiveSession } from "./arm-pr.ts";
import { claimNames } from "./row-claim.ts";
import { homeProjectDeclaration } from "./project-config.ts";
import { startedPanes } from "./packaging/started-pane.ts";

const ROW = 2405;
const ORDER = {
  session: "engineers",
  cause: "ready-row-unclaimed",
  causeKey: `engineers/ready-row-unclaimed/${ROW}`,
  title: "Spawned engineers begin in their row worktree",
  prompt: `Ready row #${ROW} is unclaimed. Claim it with \`--session=<you>\`. The claim creates that worktree for you. <launch-directory>`,
};
const ROLE = "worker-4";
const ROLE_DIR = `${HOST_REPOS}/role-${ROLE}`;
const ROW_DIR = `${HOST_REPOS}/wt-${ROW}`;
const NOBODY: { label: string; status: string }[] = [];

type Call = { command: string; args: string[]; cwd: string; env: Record<string, string> };

/**
 * A host with a board and a filesystem, in memory. `claim` lands the row unless `claimExit` says otherwise;
 * `decline` gives it back. Everything the claimer does goes through `exec`, so a change of command line is red here.
 */
function fakeHost(over: { claimExit?: number; claimOutput?: string; existing?: string[]; declineExit?: number;
  gitFails?: string; branchOf?: Record<string, boolean>; dirty?: boolean; makeRowDir?: boolean; rowDir?: string } = {}) {
  const rowDir = over.rowDir ?? ROW_DIR;
  const events: string[] = [];
  const calls: Call[] = [];
  const fs = new Set<string>(over.existing ?? []);
  const board = { held: false };
  const git = (args: string[], cwd: string) => {
    const first = args[0] ?? "";
    if (over.gitFails === first) return { status: 1, output: `fatal: ${first} failed` };
    if (first === "worktree") fs.add(args[3]);
    if (first === "symbolic-ref") return { status: over.branchOf?.[cwd] ? 0 : 1, output: "" };
    if (first === "status") return { status: 0, output: over.dirty ? " M x\n" : "" };
    return { status: 0, output: "" };
  };
  const claim = () => {
    const exit = over.claimExit ?? 0;
    const held = exit === 0 || exit === 3;
    if (held || exit === 4) board.held = true;
    if (held && over.makeRowDir !== false) fs.add(rowDir);
    const refused = `board-snapshot: wrote x\nNOT CLAIMED: #${ROW} is held by worker-5\n`;
    return { status: exit, output: over.claimOutput ?? (exit === 0 ? `STARTED -- #${ROW} is now in-progress\n` : refused) };
  };
  const decline = () => {
    if (over.declineExit) return { status: over.declineExit, output: "NOT DECLINED: the row is dirty\n" };
    board.held = false;
    fs.delete(rowDir);
    return { status: 0, output: `DECLINED -- #${ROW} is unclaimed again\n` };
  };
  const exec = (command: string, rawArgs: string[], { cwd, env }: { cwd: string; env: Record<string, string> }) => {
    const args = rawArgs;
    calls.push({ command, args, cwd, env });
    if (command === "git") {
      events.push(`git ${args.join(" ")}`);
      return git(args, cwd);
    }
    events.push(`row-claim ${args[1]} ${args.slice(2).join(" ")}`);
    return args[1] === "claim" ? claim() : decline();
  };
  return { exec, calls, events, fs, board, exists: (path: string) => fs.has(path) };
}

/** A recording herdr that answers `workspace create` as the live org does, and can be made to fail one verb. */
function fakeHerdr(events: string[], failing?: string) {
  const calls: string[][] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    calls.push(args);
    const line = args.join(" ");
    events.push(`herdr ${line}`);
    if (failing && line.includes(failing)) throw new Error(`herdr: ${failing} refused`);
    const answered = pane(args);
    if (answered !== null) return answered;
    if (line.includes("workspace create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  return { calls, run, said: (verb: string) => calls.map((c) => c.join(" ")).filter((s) => s.includes(verb)) };
}

function spawn(host: ReturnType<typeof fakeHost>, herdr: ReturnType<typeof fakeHerdr>,
  extra: { registered?: string[]; recorded?: string[] } = {}) {
  return deliver([ORDER], NOBODY, [ROLE], {
    run: herdr.run,
    claimer: spawnClaimer({ exec: host.exec, exists: host.exists }),
    registerSpawn: (role: string) => { extra.registered?.push(role); },
    record: (key: string) => { extra.recorded?.push(key); },
  });
}

test("#2405 SUCCESS: the claim is run BEFORE the pane opens, as the role, from the role's own worktree, and the pane starts in the row's", () => {
  const host = fakeHost();
  const herdr = fakeHerdr(host.events);
  const registered: string[] = [];
  const got = spawn(host, herdr, { registered });

  assert.deepEqual(got.sent, [`${ROLE} <- ${ORDER.causeKey} (STARTED sonnet/high)`], JSON.stringify(got));
  const claimAt = host.events.findIndex((e) => e.startsWith("row-claim claim"));
  const createAt = host.events.findIndex((e) => e.startsWith("herdr --session org workspace create"));
  assert.ok(claimAt >= 0 && createAt > claimAt, `the claim must precede the pane: ${host.events.join(" | ")}`);
  const claim = host.calls.find((c) => c.command === "node" && c.args[1] === "claim");
  assert.ok(claim !== undefined);
  assert.deepEqual(claim.args.slice(1), ["claim", String(ROW), `--session=${ROLE}`,
    `--branch=agent/spawned-engineers-begin-in-${ROW}`, `--worktree=../wt-${ROW}`]);
  assert.equal(claim.cwd, ROLE_DIR, "launched from the role's own linked worktree, which launchGate accepts");
  assert.equal(claim.env.GH_CONFIG_DIR, WORKERS_GH_CONFIG_DIR, "attributed to the account the agent acts as");
  const [create] = herdr.said("workspace create");
  assert.match(create, new RegExp(`--cwd ${ROW_DIR}( |$)`), "the pane's cwd is the worktree the claim created");
  assert.equal(host.board.held, true, "THE POSITIVE CONTROL: the row IS held after a successful spawn");
  assert.deepEqual(registered, [ROLE]);
});

test("#2405 SUCCESS: the role's launch worktree is created DETACHED at origin/main when it does not exist", () => {
  const host = fakeHost();
  spawn(host, fakeHerdr(host.events));
  assert.ok(host.events.includes("git fetch --quiet origin"));
  assert.ok(host.events.includes(`git worktree add --detach ${ROLE_DIR} origin/main`), host.events.join(" | "));
  const add = host.calls.find((c) => c.args[0] === "worktree");
  assert.equal(add?.cwd, PRIMARY_CHECKOUT, "git is run from the checkout that owns the repository, not from a tree that may not exist yet");
});

test("#2405 the prompt delivered to a spawn: in the worktree, claimed already, no claim command, no other path", () => {
  const host = fakeHost();
  const herdr = fakeHerdr(host.events);
  spawn(host, herdr);
  const sentPrompt = herdr.calls.find((c) => c[2] === "agent" && c[3] === "prompt")?.at(-1) ?? "";
  assert.match(sentPrompt, new RegExp(`has been claimed for you, and you are in its worktree \`${ROW_DIR}\``));
  assert.doesNotMatch(sentPrompt, /row-claim|--worktree=|--branch=|\bclaim it\b/i, "no command to run the claim");
  assert.doesNotMatch(sentPrompt, /If you cannot claim the row/, "a spawn has nothing left to claim");
  assert.doesNotMatch(sentPrompt, /linked worktree|primary checkout|role-/, "no other directory is named");
  const paths = new Set(sentPrompt.match(/\/home\/agent\/repos\/[^\s`),;]+/g));
  assert.deepEqual([...paths], [ROW_DIR]);
  assert.equal(spawnedPrompt({ title: "t" }, { row: 1, branch: "b", worktree: "/w", launchDir: "/l" }).includes("/l"), false);
});

test("#2405 REFUSED CLAIM: an answer, not a failure -- no pane, nothing registered, no spare-cycles line", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-refused-claim-"));
  try {
    const host = fakeHost({ claimExit: 1 });
    const herdr = fakeHerdr(host.events);
    const paths = sparePathsFrom(join(dir, "wake-ledger"));
    const recorded: string[] = [];
    const got = deliver([ORDER], NOBODY, [ROLE], { run: herdr.run,
      claimer: spawnClaimer({ exec: host.exec, exists: host.exists }),
      registerSpawn: (role: string) => registerSpawn(paths, role), record: (k: string) => { recorded.push(k); } });

    assert.deepEqual(got.sent, []);
    assert.match(got.refused.join("\n"), /the claim of #2405 as worker-4 did not hold \(NOT CLAIMED: #2405 is held by worker-5\)/);
    assert.deepEqual(herdr.said("workspace create"), [], "no pane is opened for a row somebody else holds");
    assert.deepEqual(herdr.calls, []);
    assert.deepEqual(recorded, [], "nothing is recorded delivered, so the next tick offers the next row");
    assert.equal(existsSync(paths.registry), false, "no instance exists");
    assert.deepEqual(readSpareCycles(paths.cycles), [], "and no spare-cycles line is written");
    assert.equal(host.events.some((e) => e.startsWith("row-claim decline")), false,
      "a claim that never landed has nothing to release");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2405 WORKSPACE WILL NOT OPEN: the claim is released and the row is UNCLAIMED again", () => {
  const host = fakeHost();
  const herdr = fakeHerdr(host.events, "workspace create");
  const registered: string[] = [];
  const got = spawn(host, herdr, { registered });

  assert.deepEqual(got.sent, []);
  assert.match(got.refused.join("\n"), /herdr could not open a pane for "worker-4".*the claim on #2405 was released/s);
  const decline = host.calls.find((c) => c.command === "node" && c.args[1] === "decline");
  assert.deepEqual(decline?.args.slice(1), ["decline", String(ROW), `--session=${ROLE}`]);
  assert.equal(decline?.cwd, ROLE_DIR);
  assert.equal(host.board.held, false, "UNCLAIMED again");
  assert.deepEqual(registered, [], "a spawn that failed is not an instance");
});

test("#2405 AGENT WILL NOT START: the workspace is closed AND the claim is released", () => {
  const host = fakeHost();
  const herdr = fakeHerdr(host.events, "agent start");
  const got = spawn(host, herdr);

  assert.deepEqual(got.sent, []);
  assert.match(got.refused.join("\n"), /herdr refused to start "worker-4".*workspace it opened \(wB\) was closed.*the claim on #2405 was released/s);
  assert.deepEqual(herdr.said("workspace close"), ["--session org workspace close wB"]);
  assert.equal(host.board.held, false, "UNCLAIMED again");
});

test("#2405 A RELEASE THAT FAILS SAYS WHAT REMAINED and names the command to finish it", () => {
  const host = fakeHost({ declineExit: 1 });
  const got = spawn(host, fakeHerdr(host.events, "agent start"));
  assert.match(got.refused.join("\n"), /could NOT be released \(NOT DECLINED: the row is dirty\).*held by "worker-4" with no process.*decline 2405 --session=worker-4/s);
  assert.equal(host.board.held, true, "the fixture agrees: nothing released it");
});

test("#2405 A CLAIM THAT LANDED BUT LEFT NO WORKTREE is released, not used", () => {
  const host = fakeHost({ makeRowDir: false });
  const herdr = fakeHerdr(host.events);
  const got = spawn(host, herdr);
  assert.deepEqual(got.sent, []);
  assert.match(got.refused.join("\n"), new RegExp(`${ROW_DIR} was not created.*the claim on #2405 was released`, "s"));
  assert.deepEqual(herdr.calls, []);
  assert.equal(host.board.held, false);
});

test("#2405 A PARTIALLY WRITTEN CLAIM (exit 4) is released; a refusal (exit 1) and could-not-determine (exit 2) are not", () => {
  const partial = fakeHost({ claimExit: 4, claimOutput: "PARTIALLY WRITTEN (exit 4)\n" });
  const got = spawn(partial, fakeHerdr(partial.events));
  assert.match(got.refused.join("\n"), /PARTIALLY WRITTEN.*the claim on #2405 was released/s);
  assert.equal(partial.board.held, false);

  for (const claimExit of [1, 2]) {
    const clean = fakeHost({ claimExit, claimOutput: "row-claim: REFUSED -- launched from x\n" });
    spawn(clean, fakeHerdr(clean.events));
    assert.equal(clean.events.some((e) => e.startsWith("row-claim decline")), false, `exit ${claimExit} landed nothing`);
  }
});

test("#2405 a STATUS-NOT-MOVED claim (exit 3) still holds the row, so it is used", () => {
  const host = fakeHost({ claimExit: 3, claimOutput: `STARTED -- #${ROW}, BUT the Project Status could not be moved\n` });
  const got = spawn(host, fakeHerdr(host.events));
  assert.deepEqual(got.sent, [`${ROLE} <- ${ORDER.causeKey} (STARTED sonnet/high)`]);
});

test("#2405 a failed fetch or worktree creation is a refusal that opens no pane and claims nothing", () => {
  for (const gitFails of ["fetch", "worktree"]) {
    const host = fakeHost({ gitFails });
    const herdr = fakeHerdr(host.events);
    const got = spawn(host, herdr);
    assert.deepEqual(got.sent, []);
    assert.match(got.refused.join("\n"), /git fetch origin failed|could not create/);
    assert.deepEqual(herdr.calls, []);
    assert.equal(host.events.some((e) => e.startsWith("row-claim")), false);
  }
});

test("#2405 an EXISTING role worktree is reused, and brought to origin/main only when detached and clean", () => {
  const cases: [string, Parameters<typeof fakeHost>[0], boolean][] = [
    ["detached and clean", {}, true],
    ["on a branch", { branchOf: { [ROLE_DIR]: true } }, false],
    ["dirty", { dirty: true }, false],
  ];
  for (const [name, over, moved] of cases) {
    const host = fakeHost({ existing: [ROLE_DIR], ...over });
    spawn(host, fakeHerdr(host.events));
    assert.equal(host.events.some((e) => e.startsWith("git worktree add")), false, `${name}: not created again`);
    assert.equal(host.events.includes("git checkout --quiet --detach origin/main"), moved, name);
    assert.ok(host.calls.find((c) => c.args[1] === "claim")?.cwd === ROLE_DIR, `${name}: the claim launches from it`);
  }
});

test("#2405 with no claimer a spawn is the pre-#2405 one: nothing claimed, no --cwd -- the seam is what turns it on", () => {
  const herdr = fakeHerdr([]);
  const got = deliver([ORDER], NOBODY, [ROLE], { run: herdr.run });
  assert.deepEqual(got.sent, [`${ROLE} <- ${ORDER.causeKey} (STARTED sonnet/high)`]);
  assert.doesNotMatch(herdr.said("workspace create")[0], /--cwd/);
});

test("#2405 an order whose row cannot be read opens no pane", () => {
  const host = fakeHost();
  const herdr = fakeHerdr(host.events);
  const got = deliver([{ ...ORDER, causeKey: "engineers/ready-row-unclaimed/none" }], NOBODY, [ROLE],
    { run: herdr.run, claimer: spawnClaimer({ exec: host.exec, exists: host.exists }) });
  assert.match(got.refused.join("\n"), /cannot tell which row/);
  assert.deepEqual(herdr.calls, []);
});

test("#2405 slugOf: a few words of the title, and `row` for a title with none", () => {
  assert.equal(slugOf("A spawned engineer starts in the primary checkout"), "a-spawned-engineer-starts");
  assert.equal(slugOf("Fix `wake.ts`: it's (broken)!"), "fix-wake-ts-it");
  assert.equal(slugOf("!!!"), "row");
  assert.equal(slugOf(undefined), "row");
  assert.ok(slugOf("x".repeat(200)).length <= 40);
});

// --- #4685: A ROW OF ANOTHER TRACKER GETS ITS OWN SPARE, NAMED FOR (KEY, ROW) --------------------------------------------------------
//
// agent-org#515's mirror. The pool order for an `a11ign/agent-org` row is `engineers/ready-row-unclaimed/agent-org#481`; `rowOfOrder` read
// only a bare number, so the order "named no row" and no engineer was ever started for the tracker the machinery's own rows are in.

const KEYED = { session: "engineers", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/agent-org#481",
  title: "A row of the machinery tracker", prompt: "Ready row agent-org#481 is unclaimed." };
const PRIMARY_ORDER = { ...KEYED, causeKey: "engineers/ready-row-unclaimed/4568", title: "A row of the first tracker" };
const STANDING = ["worker-capture", "worker-judge", "worker-tooling"];
const heldBy = (labels: string[]) => labels.map((label) => ({ label, status: "working" }));
const AGENT_ORG_REPO = homeProjectDeclaration().tracker.find((t) => t.key === "agent-org")?.repo ?? "";
const KEYED_DIR = `${HOST_REPOS}/wt-agent-org-481`;
const KEYED_ROLE = "worker-agent-org-481";
const CLONE = "/clones/agent-org";

test("#4685 (a) ACCEPTANCE: with every roster address held, an agent-org#481 order is given a spare named for the KEYED row", () => {
  const got = spawnableRole(KEYED, heldBy(STANDING), STANDING);
  assert.deepEqual(got, { role: KEYED_ROLE });
  assert.equal(AGENT_ORG_REPO, "a11ign/agent-org", "the fixture reads the declaration it claims to: the key IS declared");
  assert.deepEqual(rowRefOfOrder(KEYED), { key: "agent-org", number: 481 });
});

test("#4685 (b) the first tracker's order still yields the same spare name it always did", () => {
  assert.deepEqual(spawnableRole(PRIMARY_ORDER, heldBy(STANDING), STANDING), { role: "worker-4568" });
  assert.equal(spareLabelForRow({ row: 4568 }), "worker-4568");
  assert.deepEqual(rowRefOfOrder(PRIMARY_ORDER), { key: "", number: 4568 });
});

test("#4685 (c) NEGATIVE CONTROL: agent-org#481 and the first tracker's #481 are two names, and the name is a pure function of (key, row)", () => {
  const keyed = spareLabelForRow({ row: 481, key: "agent-org" });
  const primary = spareLabelForRow({ row: 481 });
  assert.equal(primary, "worker-481", "POSITIVE CONTROL: the first tracker's row 481 is named, so the inequality below compares two real names");
  assert.notEqual(keyed, primary);
  assert.equal(keyed, spareLabelForRow({ row: 481, key: "agent-org" }), "pure: the same input names the same address");
  assert.equal(keyed, claimNames({ key: "agent-org", number: 481 }).session, "and it is the name `row-claim` gives the same claim, so the session label agrees");
  // A key the project does not declare names nothing, and so cannot be read back as a seat.
  assert.equal(spareLabelForRow({ row: 481, key: "capture" }), null);
});

test("#4685 (d) ACCEPTANCE: a keyed row is checked against ITS tracker's blockedBy edge, and the refusal names that repository", () => {
  const edges: Record<string, string> = {};
  const calls: string[] = [];
  const run = (args: string[]): string => {
    const repo = args[args.indexOf("--repo") + 1];
    calls.push(`${args[0]} ${args[1]} ${args[2]} ${repo}`);
    if (args[0] === "issue" && args[args.indexOf("--json") + 1] === "blockedBy") {
      const edge = edges[`${repo}#${args[2]}`];
      return JSON.stringify({ blockedBy: { nodes: edge === undefined ? [] : [{ number: 600, state: edge }] } });
    }
    if (args[0] === "issue") return JSON.stringify({ body: "no region here\n" });
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const check = spawnClaimability({ run, warn: () => {} });
  const FIRST = homeProjectDeclaration().tracker.find((t) => t.key === "")?.repo ?? "";
  assert.notEqual(FIRST, AGENT_ORG_REPO, "POSITIVE CONTROL: the two trackers are two repositories, or the cases below could not tell them apart");

  edges[`${AGENT_ORG_REPO}#481`] = "OPEN";
  const refused = check({ causeKey: KEYED.causeKey });
  assert.match(String(refused), /agent-org#481 in a11ign\/agent-org would be refused at the claim by the `blockedBy` check \(#1886\): blocked by still-open #600/);
  assert.ok(calls.includes(`issue view 481 ${AGENT_ORG_REPO}`), calls.join(" | "));
  assert.equal(calls.includes(`issue view 481 ${FIRST}`), false, "the first tracker's row 481 was never read for the keyed order");

  // The first tracker's row 481 has an open edge and agent-org's has none: the keyed order is NOT refused for it.
  delete edges[`${AGENT_ORG_REPO}#481`];
  edges[`${FIRST}#481`] = "OPEN";
  assert.equal(check({ causeKey: KEYED.causeKey }), null);
  assert.match(String(check({ causeKey: PRIMARY_ORDER.causeKey.replace("4568", "481") })), /#481 would be refused at the claim by the `blockedBy` check/,
    "and the same twin DOES refuse the first tracker's own order, so the reading above was not a check that never fires");
});

test("#4685 an order naming a key the project does not declare is refused by name, never read as the first tracker's row", () => {
  const read: string[] = [];
  const check = spawnClaimability({ run: (args) => { read.push(args.join(" ")); return "{}"; }, warn: () => {} });
  const why = check({ causeKey: "engineers/ready-row-unclaimed/nowhere#481" });
  assert.match(String(why), /declares no tracker with that key/);
  assert.deepEqual(read, [], "nothing was asked of any repository");
  const named = spawnableRole({ ...KEYED, causeKey: "engineers/ready-row-unclaimed/nowhere#481" }, heldBy(STANDING), STANDING);
  assert.match((named as { refusal: string }).refusal, /names no row a spare could be named for/);
});

test("#4685 (e) ACCEPTANCE: withSpareInstances offers a RUNNING keyed spare, after the roster and the first tracker's spares", () => {
  const agents = [...heldBy(STANDING), { label: KEYED_ROLE, status: "idle" }, { label: "worker-9", status: "idle" },
    { label: "worker-capture-481", status: "idle" }];
  assert.deepEqual(withSpareInstances(STANDING, agents), [...STANDING, "worker-9", KEYED_ROLE]);
  // The readers a spare's life depends on agree that it is one, and refuse the undeclared key's look-alike.
  assert.deepEqual(familyMember(KEYED_ROLE), { key: "agent-org", number: 481 });
  assert.equal(isSpareRole(KEYED_ROLE), true);
  assert.equal(isLiveSession(KEYED_ROLE), true);
  assert.equal(familyMember("worker-capture-481"), null);
  assert.equal(isLiveSession("worker-capture-481"), false);
});

test("#4685 SPAWN: a keyed row is claimed from ITS clone with --tracker, in a keyed worktree, and the engineer is told which repository it is in", () => {
  const host = fakeHost({ rowDir: KEYED_DIR });
  const herdr = fakeHerdr(host.events);
  const registered: string[] = [];
  const got = deliver([KEYED], heldBy([ROLE]), [ROLE], { run: herdr.run,
    claimer: spawnClaimer({ exec: host.exec, exists: host.exists, cloneOf: (key) => (key === "agent-org" ? { clone: CLONE } : { refusal: `no clone for ${key}` }) }),
    registerSpawn: (role: string) => { registered.push(role); }, record: () => {} });

  assert.deepEqual(got.sent, [`${KEYED_ROLE} <- ${KEYED.causeKey} (STARTED sonnet/high)`], JSON.stringify(got));
  const claim = host.calls.find((c) => c.command === "node" && c.args[1] === "claim");
  assert.ok(claim !== undefined);
  const names = claimNames({ key: "agent-org", number: 481 });
  assert.deepEqual(claim.args.slice(1), ["claim", "481", "--tracker=agent-org", `--session=${names.session}`,
    `--branch=agent/${slugOf(KEYED.title)}-agent-org-481`, `--worktree=../${names.worktree}`]);
  assert.equal(claim.cwd, `${HOST_REPOS}/role-${KEYED_ROLE}`);
  const add = host.calls.find((c) => c.args[0] === "worktree");
  assert.equal(add?.cwd, CLONE, "the launch tree is made from the KEYED repository's clone, not the first tracker's checkout");
  const [create] = herdr.said("workspace create");
  assert.match(create, new RegExp(`--cwd ${KEYED_DIR}( |$)`));
  const prompt = herdr.calls.find((c) => c[2] === "agent" && c[3] === "prompt")?.at(-1) ?? "";
  assert.ok(prompt.includes(`row of the \`agent-org\` tracker (\`${AGENT_ORG_REPO}\`)`), prompt);
  assert.ok(prompt.includes(`gh issue view 481 --repo ${AGENT_ORG_REPO}`), prompt);
  assert.match(prompt, /agent-org#481/);
  assert.deepEqual(registered, [KEYED_ROLE]);
  assert.equal(host.board.held, true, "POSITIVE CONTROL: the keyed row IS held after the spawn");
});

test("#4685 SPAWN: a keyed row with no clone on the host is refused by name, before any claim is made", () => {
  const host = fakeHost({ rowDir: KEYED_DIR });
  const herdr = fakeHerdr(host.events);
  const got = deliver([KEYED], heldBy([ROLE]), [ROLE], { run: herdr.run,
    claimer: spawnClaimer({ exec: host.exec, exists: host.exists, cloneOf: () => ({ refusal: "host.json names no clone for agent-org" }) }),
    registerSpawn: () => {}, record: () => {} });
  assert.deepEqual(got.sent, []);
  assert.match(got.refused.join("\n"), /cannot claim agent-org#481: host.json names no clone for agent-org/);
  assert.equal(host.calls.some((c) => c.command === "node"), false, "no row-claim ran");
  assert.deepEqual(herdr.calls, []);
});

test("#4685 TEARDOWN: a keyed spare is a spare, and it is ended when its row closes in ITS tracker -- the state is asked of that tracker, by role", () => {
  const listed = [{ label: "worker-tooling", status: "idle" }, { label: KEYED_ROLE, status: "idle" }, { label: "worker-capture-481", status: "idle" }];
  assert.deepEqual(spareInstances(listed), [KEYED_ROLE], "the keyed spare is a candidate; the undeclared key's look-alike is not");
  const asked: string[] = [];
  const closed: string[] = [];
  const run = (args: string[]) => {
    const said = args.join(" ");
    if (said.endsWith("workspace list")) return JSON.stringify({ result: { workspaces: [{ label: KEYED_ROLE, workspace_id: "wK", agent_status: "idle" }] } });
    if (said.includes("workspace close")) closed.push(said);
    return "{}";
  };
  const got = endFinishedSpares(listed, { spares: spareInstances(listed), registry: { [KEYED_ROLE]: { spawnedAt: 0, rows: [481] } }, now: 5 * 3_600_000,
    run, heldRows: () => [], rowState: (row, role) => { asked.push(`${role}:${row}`); return "CLOSED"; }, worktrees: () => [],
    record: () => {}, warn: () => {} });
  assert.deepEqual(closed, ["--session org workspace close wK"]);
  assert.deepEqual(asked, [`${KEYED_ROLE}:481`], "the role travels with the number, so the reader can ask agent-org's #481 and not the first tracker's");
  assert.deepEqual(got.ended.map((c) => c.role), [KEYED_ROLE]);
  assert.equal(got.registry[KEYED_ROLE], undefined);
});
