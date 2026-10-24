// no-token: none -- every row is the fake code host's, seeded in memory; nothing spawns `gh`
/**
 * a11ign/agent-org#1216: A TREE'S ROW IS READ IN THE REPOSITORY THE TREE BELONGS TO, NEVER IN THE PRIMARY'S.
 *
 * The incident: `wt-agent-org-1159` was refused removal on `a11ign/a11ign#1159`, a MERGED row of another repository that happened to
 * carry a `session:` label. The primary's number was read for a tree whose row is in agent-org, so a dead claim was never released.
 *
 * A11-160 (step 9): the rows are the fake code host's -- the primary's in the world's own rows, agent-org's among its foreign rows, keyed
 * `repo#row` -- and the world records which `repo#row` was asked about (`world.calls`). The `gh` seam of `claimRefusal` / `rowsClosed` is the
 * executor handed to the code host, which the fake ignores. What `defaultGh` makes of a runner that fails is held at the end.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { claimRefusal, defaultGh, rowsClosed, treeRepo, type Gh } from "./worktree-removal.ts";
import type { Tracker } from "./project-config.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

const PRIMARY = "a11ign/a11ign";
const TRACKERS: Tracker[] = [
  { key: "", repo: PRIMARY, board: { owner: "a11ign", number: 1 } },
  { key: "agent-org", repo: "a11ign/agent-org", board: { owner: "a11ign", number: 2 } },
];

/** The executor the removers hand the code host: the fake acts on its own state, so a call that reaches it is a bug. */
const gh: Gh = () => {
  throw new Error("the fake acts on its own state: no run is made");
};

/** The fake code host, installed, holding `rows` keyed `repo#row` (the primary's are the world's own, any other repository's are foreign). Answers the world, and which `repo#row` was asked about. */
function seeded(rows: Record<string, { state: string, labels?: string[] }>) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = PRIMARY;
  for (const [key, { state, labels = [] }] of Object.entries(rows)) {
    const [repo, number] = key.split("#");
    const row = fakeRow(world, Number(number), { state: state as "OPEN" | "CLOSED", labels });
    if (repo === PRIMARY) world.rows.set(row.number, row);
    else world.foreignRows.set(key, row);
  }
  substituteCodeHost(host);
  const asked = (): string[] => world.calls.filter((call) => call.startsWith("rowStateAndLabelsOf ")).map((call) => call.slice("rowStateAndLabelsOf ".length));
  return { world, asked };
}

const AGENT_ORG_TREE = { path: "/home/agent/repos/wt-agent-org-1159", branch: "agent/some-slug-1159" };

test("a row with the same number in the primary is not read for an agent-org tree", () => {
  // The primary's #1159 is open and claimed by another session; agent-org's #1159 is open and unclaimed. Only agent-org's answers.
  const { asked } = seeded({
    [`${PRIMARY}#1159`]: { state: "OPEN", labels: ["session:worker-judge"] },
    "a11ign/agent-org#1159": { state: "OPEN", labels: [] },
  });
  assert.deepEqual(claimRefusal(AGENT_ORG_TREE, { gh, trackers: TRACKERS }), { refused: false });
  assert.deepEqual(asked(), ["a11ign/agent-org#1159"]);
});

test("a claim held in agent-org refuses the agent-org tree, and the primary's row is not read", () => {
  const { asked } = seeded({
    [`${PRIMARY}#1159`]: { state: "OPEN", labels: ["session:worker-judge"] },
    "a11ign/agent-org#1159": { state: "OPEN", labels: ["session:worker-agent-org-1159"] },
  });
  const verdict = claimRefusal(AGENT_ORG_TREE, { gh, trackers: TRACKERS });
  assert.equal(verdict.refused, true);
  assert.match((verdict as { reason: string }).reason, /row #1159, which still carries session:worker-agent-org-1159/);
  assert.deepEqual(asked(), ["a11ign/agent-org#1159"]);
});

test("a primary tree is read in the primary", () => {
  const { asked } = seeded({
    [`${PRIMARY}#1159`]: { state: "OPEN", labels: ["session:worker-judge"] },
    "a11ign/agent-org#1159": { state: "OPEN", labels: [] },
  });
  assert.equal(claimRefusal({ path: "/home/agent/repos/wt-1159", branch: "agent/some-slug-1159" }, { gh, trackers: TRACKERS }).refused, true);
  assert.deepEqual(asked(), [`${PRIMARY}#1159`]);
});

test("a tree naming a key no tracker declares is refused as undeterminable, and no row is read", () => {
  const { asked } = seeded({ [`${PRIMARY}#1159`]: { state: "OPEN", labels: [] } });
  const verdict = claimRefusal({ path: "/home/agent/repos/wt-nowhere-1159", branch: "agent/some-slug-1159" }, { gh, trackers: TRACKERS });
  assert.equal(verdict.refused, true);
  assert.match((verdict as { reason: string }).reason, /could not be determined/);
  assert.deepEqual(asked(), [], "a number read in the primary would answer for a different row");
  assert.deepEqual(treeRepo({ path: "/home/agent/repos/wt-nowhere-1159" }, TRACKERS), { undetermined: "/home/agent/repos/wt-nowhere-1159 names tracker `nowhere`, which no tracker declares, so its row's repository could not be determined" });
});

test("a closed primary row does not close an open agent-org row of the same number", () => {
  seeded({
    [`${PRIMARY}#1159`]: { state: "CLOSED" },
    "a11ign/agent-org#1159": { state: "OPEN" },
  });
  assert.deepEqual(rowsClosed(AGENT_ORG_TREE, { gh, trackers: TRACKERS }), { closed: false, reason: "row #1159 is open, so the stamp is not stale (#3850)" },
    "the primary's #1159 is closed: only agent-org's open one can have answered");
});

// --- `defaultGh`: the runner the removers use when they are handed none ------------------------------------------------------------------------

/** Installs a code host whose runner (the one `defaultGh` asks for) is `runner`, and records the policy it was asked for. */
function withRunner(runner: (args: string[]) => string) {
  const host = createFakeCodeHost();
  const asked: unknown[] = [];
  (host.rows as { runnerWith: unknown }).runnerWith = (request: unknown) => { asked.push(request); return runner; };
  substituteCodeHost(host);
  return asked;
}

const VIEW = ["issue", "view", "5", "--repo", "o/r", "--json", "state"];

test("defaultGh asks the code host for a runner that keeps what gh prints on stderr to the failure, and answers its text as it is", () => {
  const asked = withRunner((args) => (args === VIEW ? '{"state":"OPEN"}\n' : ""));
  assert.equal(defaultGh(VIEW), '{"state":"OPEN"}\n');
  assert.deepEqual(asked, [{ echo: false }], "stderr is not let through to this process's own: it was captured by the spawn this replaced");
});

test("defaultGh reads a command that failed as it always did here: its first three words, its status and what it said", () => {
  withRunner(() => { throw Object.assign(new Error("Command failed: gh issue view 5 ..."), { status: 4, stderr: "  HTTP 502: bad gateway\n" }); });
  assert.throws(() => defaultGh(VIEW), { message: "gh issue view 5 exited 4: HTTP 502: bad gateway" });
  withRunner(() => { throw Object.assign(new Error("spawnSync gh ENOENT"), { status: null, stderr: "" }); });
  assert.throws(() => defaultGh(VIEW), { message: "gh issue view 5 exited null: " }, "a gh that could not start has no status");
});

test("defaultGh rethrows what is not a command that failed as it is: a code host with no rows is told by name, not as an exit", () => {
  const refusal = new Error("row mode needs a code host that implements rows: x does not");
  withRunner(() => { throw refusal; });
  assert.throws(() => defaultGh(VIEW), (thrown) => thrown === refusal);
});
