// no-token: gh -- every `gh`, `herdr`, `git` and `row-claim` call here is an injected seam (the claim's `exec`, the pane's `run`); nothing imported reaches them
/**
 * a11ign/agent-org#869 (`ceo`'s addition 2 on #850): A SPAWN WHOSE ENGINEER BRIEF IS NOT AT ITS ABSOLUTE PATH IS REFUSED, NAMING THE PATH, BEFORE THE CLAIM.
 *
 * #867 sends a spawned pane to read `<home project>/.agent-org/roles/engineer.md`. A pane started when that file is absent is told to read a path that is
 * not there and sits idle on it, so `spawnWorker` says `no spawn: the engineer brief is not at <path>` after the memory and claim prechecks and before
 * the claim: no row is claimed and no pane is opened. WHAT IS PINNED: the refusal through `deliver` (the production entry), with the same spawn and the
 * file present as the POSITIVE CONTROL in the same process; the `isFile` seam of `whyNoBrief` (a directory at the path is no brief); and, read from a copy of `wake.ts`'s text, that the check
 * sits before the claim and that a copy without it is named.
 *
 * The project is the overlap rule's recorded one with NO `engineer.md`, which `wake-spawn-worktree.test.ts` adds for its own spawns.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moduleSource } from "./lib/module-source.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "wake-spawn-brief-absent-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { deliver, HOST_REPOS } = await import("./wake/clear-settle-ms.ts");
const { spawnClaimer } = await import("./wake/is-release-line.ts");
const { whyNoBrief } = await import("./wake/is-pull-request-spawn-order.ts");
const { roleBriefPath } = await import("./project-roles.ts");
const { startedPanes } = await import("./packaging/started-pane.ts");
/** The row the tier check reads: an ordinary one, so the claim never reaches the real `gh` for its labels (`readRowForTier`'s default). */
const ORDINARY_ROW = () => ({ labels: [], body: "", title: "" });

const BRIEF = roleBriefPath("engineer.md").absolute;
const ROW = 869;
const ROLE = "worker-4";
const ROW_DIR = `${HOST_REPOS}/wt-${ROW}`;
const ORDER = {
  session: "engineers",
  cause: "ready-row-unclaimed",
  causeKey: `engineers/ready-row-unclaimed/${ROW}`,
  title: "A spawn whose engineer brief is absent is refused",
  prompt: `Ready row #${ROW} is unclaimed. Claim it with \`--session=<you>\`. <launch-directory>`,
};

/** A recording host: `row-claim claim` lands the row, `git` answers, and `fs` holds what exists (the row's worktree after a claim). */
function fakeHost() {
  const events: string[] = [];
  const fs = new Set<string>();
  const exec = (command: string, args: string[]) => {
    if (command === "git") {
      events.push(`git ${args.join(" ")}`);
      if (args[0] === "worktree") fs.add(args[3]);
      return { status: args[0] === "symbolic-ref" ? 1 : 0, output: "" };
    }
    events.push(`row-claim ${args[1]} ${args.slice(2).join(" ")}`);
    if (args[1] === "claim") fs.add(ROW_DIR);
    return { status: 0, output: args[1] === "claim" ? `STARTED -- #${ROW} is now in-progress\n` : `DECLINED -- #${ROW} is unclaimed again\n` };
  };
  return { events, exec, exists: (path: string) => fs.has(path) };
}

/** A recording herdr that answers `workspace create` as the live org does. */
function fakeHerdr(events: string[]) {
  const calls: string[][] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    calls.push(args);
    events.push(`herdr ${args.join(" ")}`);
    const answered = pane(args);
    if (answered !== null) return answered;
    if (args.join(" ").includes("workspace create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  return { calls, run };
}

function spawn() {
  const host = fakeHost();
  const herdr = fakeHerdr(host.events);
  const got = deliver([ORDER], [], [ROLE], { run: herdr.run, claimer: spawnClaimer({ exec: host.exec, exists: host.exists, readRow: ORDINARY_ROW }),
    registerSpawn: () => {}, record: () => {} });
  const said = (needle: string) => host.events.filter((e) => e.includes(needle));
  return { got, events: host.events, said };
}

test("the brief the pane is sent to is at its absolute path under the home project, and the fixture has none (the test's own premise)", () => {
  assert.equal(BRIEF, join(PROJECT, ".agent-org/roles/engineer.md"));
  assert.equal(whyNoBrief(), `the engineer brief is not at ${BRIEF}`);
});

test("an absent brief refuses the spawn naming the path, claims no row and opens no pane; the same spawn with the file present opens one (POSITIVE CONTROL)", () => {
  const refused = spawn();
  assert.deepEqual(refused.got.sent, [], JSON.stringify(refused.got));
  assert.match(refused.got.refused.join("\n"), new RegExp(`no spawn: the engineer brief is not at ${BRIEF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.deepEqual(refused.said("row-claim claim"), [], "refused BEFORE the claim: no row is claimed");
  assert.deepEqual(refused.said("workspace create"), [], "and no pane is opened");
  assert.deepEqual(refused.events, [], "nothing at all was run: no `git`, no `row-claim`, no `herdr`");

  writeFileSync(BRIEF, "# engineer brief (a fixture's one line)\n");
  try {
    const spawned = spawn();
    assert.deepEqual(spawned.got.sent, [`${ROLE} <- ${ORDER.causeKey} (STARTED sonnet/high)`], JSON.stringify(spawned.got));
    assert.equal(spawned.said("row-claim claim").length, 1, "the file present, the row is claimed");
    assert.equal(spawned.said("workspace create").length, 1, "and one pane is opened");
    assert.equal(whyNoBrief(), null);
  } finally {
    rmSync(BRIEF, { force: true });
  }
});

test("`whyNoBrief` asks the seam it is handed, naming the path it was asked about", () => {
  assert.equal(whyNoBrief(() => true), null, "POSITIVE CONTROL: a file that exists is no refusal");
  assert.equal(whyNoBrief((path) => path !== BRIEF), `the engineer brief is not at ${BRIEF}`);
  const asked: string[] = [];
  whyNoBrief((path) => { asked.push(path); return true; });
  assert.deepEqual(asked, [BRIEF], "one read, of the brief's absolute path and nothing relative to a worktree");
});

test("a DIRECTORY at the brief's path is no brief: the default seam asks for a file, as `whyNoHost` does", () => {
  mkdirSync(BRIEF);
  try {
    assert.equal(whyNoBrief(), `the engineer brief is not at ${BRIEF}`);
  } finally {
    rmSync(BRIEF, { recursive: true, force: true });
  }
  writeFileSync(BRIEF, "# a file\n");
  try {
    assert.equal(whyNoBrief(), null, "POSITIVE CONTROL: a file at the same path is a brief");
  } finally {
    rmSync(BRIEF, { force: true });
  }
});

/** What `wake.ts` must still do, read from a copy of its text; the problems found, none when it holds. */
function spawnProblems(source: string): string[] {
  const problems: string[] = [];
  const worker = source.slice(source.indexOf("function spawnWorker("));
  const check = worker.indexOf("whyNoBrief(isFile)");
  const claim = worker.indexOf("claimer?.claim(");
  const refusal = /whyNoBrief\(isFile\);\s*if \(unbriefed !== null\) return \{ refusal: `no spawn: \$\{unbriefed\}` \}/;
  if (check === -1 || !refusal.test(worker)) problems.push("spawnWorker no longer refuses a spawn whose engineer brief is absent");
  else if (claim === -1 || check > claim) problems.push("the brief check is no longer before the claim");
  if (!/the engineer brief is not at \$\{ENGINEER_BRIEF_ABSOLUTE\}/.test(source)) problems.push("the refusal no longer names the brief's absolute path");
  return problems;
}

test("MUTATION: a wake.ts that drops the check, or runs it after the claim, is named by its own problem", () => {
  const source = moduleSource("wake.ts");
  assert.deepEqual(spawnProblems(source), [], "the real text holds");
  const dropped = source.replace(/  const unbriefed = whyNoBrief\(isFile\);\n  if \(unbriefed !== null\) return \{ refusal: `no spawn: \$\{unbriefed\}` \};\n/, "");
  assert.ok(dropped !== source, "the mutation applied");
  assert.deepEqual(spawnProblems(dropped), ["spawnWorker no longer refuses a spawn whose engineer brief is absent"]);
  const late = source.replace(/(  const unbriefed = whyNoBrief\(isFile\);\n  if \(unbriefed !== null\) return \{ refusal: `no spawn: \$\{unbriefed\}` \};\n)(  const claimed = claimer\?\.claim\(order, role\.role, env\);\n)/, "$2$1");
  assert.ok(late !== source, "the mutation applied");
  assert.deepEqual(spawnProblems(late), ["the brief check is no longer before the claim"]);
});
