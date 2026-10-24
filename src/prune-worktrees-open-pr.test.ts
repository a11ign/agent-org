// no-token: none -- every open-PR listing here is the fake code host's (seeded in memory); nothing spawns `gh`. What GitHub's answer to the listing looks like, and the argument list that asks for it, are `plugins/github/rows/open-pull-heads.test.ts`.
/**
 * a11ign/agent-org#1167: AN OPEN PR OF A TREE'S BRANCH, OR OF ITS SESSION'S LABEL, HOLDS THE TREE -- BEHIND `prune.holdOpenPr`.
 *
 * A tree can be clean, merged and pushed while its PR is still open (a PR that a reviewer is still reading). The prune removed it anyway.
 * With the flag ON, a removable tree named by an open PR is kept and the report names the PR; a listing that cannot be read keeps every
 * tree and says why. With the flag OFF (the shipped default) the prune is exactly what it was, and GitHub is not asked anything.
 *
 * Every tree is a real git worktree under one disposable base made here and removed in `after`; none of them can reach this checkout.
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testEach } from "./lib/test-each.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakePull } from "./plugins/fakes/code-host-pulls.ts";
import { watchedRows } from "./plugins/fakes/watched-rows.test.support.ts";

const BASE = realpathSync(mkdtempSync(join(tmpdir(), "prune-open-pr-")));
after(() => { rmSync(BASE, { recursive: true, force: true }); });
afterEach(() => forgetActivation());

/** The smallest declaration the tool's modules read at import: a project of nobody's, so nothing here is a11ign's (`prune-worktrees-closed-row.test.ts`'s). */
const DECLARATION = {
  schema: 1,
  tracker: [{ key: "", repo: "acme/widgets", board: { owner: "acme", number: 1 } }],
  code: [{ key: "", repo: "acme/widgets" }],
  units: { prefix: "acme-", boardReportWorkflow: "board.yml", own: [] },
  vocabulary: {
    labels: { backlog: "backlog", needsChairman: "needs:chairman", outOfRelease: "out-of-release", blocked: "blocked" },
    prefixes: { lane: "lane:", session: "session:", answer: "answer:" },
    milestones: { roadToVersionOne: "Road to one", outOfRelease: "Out of release" },
    lanesFile: "lanes.json",
    templateFields: { acceptance: "Acceptance", closes: "Closes", fleet: "Fleet" },
    fleetQuestion: "Does it need the fleet?",
    resources: [],
  },
};

/** A host file naming that project, made here so no run of this file depends on the layout it sits in or on a variable the caller exported. */
const HOST = (() => {
  const project = join(BASE, "project");
  mkdirSync(join(project, ".agent-org"), { recursive: true });
  writeFileSync(join(project, ".agent-org", "project.json"), JSON.stringify(DECLARATION));
  const host = join(BASE, "host.json");
  writeFileSync(host, JSON.stringify({ schema: 1, primary: "p", projects: [{ id: "p", checkout: project }] }));
  return host;
})();
// The tool's modules resolve their project when IMPORTED, so the host is named BEFORE they are, and only when the caller named none.
if (!process.env.AGENT_ORG_HOST) process.env.AGENT_ORG_HOST = HOST;
const { pruneWorktrees, formatAppliedReport, listOpenPulls, openPrHoldOn, OPEN_PR_HOLD_FLAG, PULL_LIST_LIMIT, CLOSED_ROW_RELEASE_AGE_MS } =
  await import("./prune-worktrees.ts");
const { REPO } = await import("./project-identity.ts");
const { stampWorktree } = await import("./worktree-owner.ts");
const { REMOVAL_LOG_ENV } = await import("./worktree-removal.ts");
const { sandboxGitEnv } = await import("./lib/git-env.ts");

// #2782: every removal writes a line, and a fixture must not write the host's log.
process.env[REMOVAL_LOG_ENV] = join(BASE, "worktree-removals");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8" });
const NOBODY_CLAIMS = () => ({ refused: false as const });
type OpenPull = { number: number, headRefName: string, labels?: string[] };

/**
 * The fake code host, installed, whose repository has these open pull requests (the head branch and the label names each carries), or cannot list them (`unread` is the reason it gives). `listed()` is how many
 * times the prune asked it for the listing, and `asked` is what it was asked: the repository, and the cap on the listing.
 */
function openPullsOf(pulls: OpenPull[], unread: string | null = null) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  for (const { number, headRefName, labels = [] } of pulls) fakePull(world, number, { headRefName, labels });
  world.unreadOpenPulls = unread;
  const asked: { repo: string, limit: number }[] = [];
  const { rows } = host;
  const read = rows!.readOpenPullHeads;
  const watched = watchedRows({ ...host, rows: { ...rows!, readOpenPullHeads: (repo, run, limit) => { asked.push({ repo, limit }); return read(repo, run, limit); } } });
  substituteCodeHost(watched.host);
  return { asked, listed: () => watched.calls.filter((call) => call.op === "readOpenPullHeads").length };
}
/** Idle past the release age, standing in for time passing: a tree this new reads as active otherwise. */
const IDLE_PAST_AGE = () => Date.now() + CLOSED_ROW_RELEASE_AGE_MS + 60_000;

let counter = 0;
/** A primary with `origin/main` at its one commit; the `.gitignore` is the real one's, so a stamp does not make a tree read dirty. */
function buildPrimary() {
  counter += 1;
  const root = join(BASE, `primary-${counter}`);
  mkdirSync(root);
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, ".gitignore"), "node_modules\n.a11y-owner\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "base");
  const tip = git(root, "rev-parse", "HEAD").trim();
  git(root, "update-ref", "refs/remotes/origin/main", tip);
  return { root, tip };
}

/** A clean tree on its own branch at main's tip, pushed (the origin ref is made here), NOT stamped: the prune removes it today. */
function pushedTree(primary: { root: string, tip: string }, name: string) {
  const path = join(primary.root, name);
  const branch = `agent/${name}`;
  git(primary.root, "worktree", "add", "--quiet", "-b", branch, path, primary.tip);
  git(primary.root, "update-ref", `refs/remotes/origin/${branch}`, primary.tip);
  return { path, branch };
}

/** A STAMPED tree whose own commit is on main, so `heldByOwner` lets it go -- the case the session-label hold exists for. */
function deliveredStampedTree(primary: { root: string, tip: string }, name: string, session: string) {
  const path = join(primary.root, name);
  const branch = `agent/${name}`;
  git(primary.root, "worktree", "add", "--quiet", "-b", branch, path, primary.tip);
  writeFileSync(join(path, "work.txt"), `${name}\n`);
  git(path, "add", "work.txt");
  git(path, "commit", "-q", "-m", `work on ${name}`);
  const tip = git(path, "rev-parse", "HEAD").trim();
  git(primary.root, "merge", "--ff-only", "-q", branch);
  git(primary.root, "update-ref", "refs/remotes/origin/main", tip);
  git(primary.root, "update-ref", `refs/remotes/origin/${branch}`, tip);
  stampWorktree(path, session);
  return { path, branch };
}

/** A clean pushed tree called `name`, a code host whose open pull requests are `pulls` of its branch, and the prune run over the tree with `holdOpenPr` as given (omitted is the shipped default). */
function pruneOfPushedTree(name: string, pulls: (branch: string) => OpenPull[], holdOpenPr?: boolean) {
  const primary = buildPrimary();
  const { path, branch } = pushedTree(primary, name);
  const { listed } = openPullsOf(pulls(branch));
  const report = pruneWorktrees(primary.root, { now: IDLE_PAST_AGE(), claim: NOBODY_CLAIMS, ...(holdOpenPr === undefined ? {} : { holdOpenPr }) });
  return { path, branch, report, listed };
}

test("#1167: with the flag ON, a clean pushed tree whose branch has an open PR is KEPT, and the report names the PR", () => {
  const { path, branch, report, listed } = pruneOfPushedTree("wt-1167-a", (head) => [{ number: 1201, headRefName: head }], true);
  assert.equal(listed(), 1, "the code host was asked for the open pull requests");
  assert.deepEqual(report.removed, []);
  assert.deepEqual(report.held.map((r) => r.path), [path]);
  assert.match(report.held[0].reason, /open pull request #1201/);
  assert.match(report.held[0].reason, new RegExp(`has head branch ${branch}`));
  assert.ok(existsSync(path), "the held tree must still be on disk");
  // The log line is the report's line: it names the PR, so the hold can be read from the output.
  assert.match(formatAppliedReport(report), /open pull request #1201 \(https:\/\/github\.com\/fake\/pull\/1201\)/);
});

test("#1167 OFF: the same clean pushed tree with an open PR is REMOVED, and GitHub is never asked (today's prune)", () => {
  const { path, report, listed } = pruneOfPushedTree("wt-1167-b", (head) => [{ number: 1201, headRefName: head }]);
  assert.deepEqual(report.removed.map((r) => r.path), [path]);
  assert.ok(!existsSync(path), "with the flag omitted the tree must really be gone");
  assert.equal(listed(), 0, "the flag is OFF, so the code host must not be asked for the open PRs");
});

test("#1167 OFF: an explicit `holdOpenPr: false` is the same as omitting it -- removed, and no listing is read", () => {
  const { path, report, listed } = pruneOfPushedTree("wt-1167-c", (head) => [{ number: 1201, headRefName: head }], false);
  assert.deepEqual(report.removed.map((r) => r.path), [path]);
  assert.deepEqual(report.held, []);
  assert.equal(listed(), 0, "the flag is OFF, so the code host must not be asked for the open PRs");
});

type Primary = ReturnType<typeof buildPrimary>;
type Report = ReturnType<typeof pruneWorktrees>;

/** Each case keeps its tree on disk when the open-PR listing cannot be used, and checks the reason the report gives for it. */
testEach("#1167: an open-PR listing the hold cannot use keeps the tree, and says why", [
  {
    name: "#1167: a listing that FAILS keeps every removable tree and says so -- nothing is removed on an unknown",
    arrange: (primary: Primary) => { openPullsOf([], "the open pull request listing failed: HTTP 502: bad gateway"); return pushedTree(primary, "wt-1167-d").path; },
    check: (report: Report, path: string) => {
      assert.match(report.held[0].reason, /could not be listed/);
      assert.match(report.held[0].reason, /HTTP 502: bad gateway/);
      assert.ok(existsSync(path), "a tree that could not be checked must stay on disk");
    },
  },
  {
    name: "#1167: a listing that returns something other than a list also keeps everything",
    arrange: (primary: Primary) => { openPullsOf([], "the open pull request listing did not return a list"); return pushedTree(primary, "wt-1167-e").path; },
    check: (report: Report) => {
      assert.match(report.held[0].reason, /did not return a list/);
    },
  },
  {
    name: "#1167: a stamped tree whose session label is on an open PR is kept, though its own work is on main",
    arrange: (primary: Primary) => {
      openPullsOf([{ number: 1202, headRefName: "feature/other", labels: ["session:worker-1167-f"] }]);
      return deliveredStampedTree(primary, "wt-1167-f", "worker-1167-f").path;
    },
    check: (report: Report) => {
      assert.match(report.held[0].reason, /open pull request #1202/);
      assert.match(report.held[0].reason, /carries session:worker-1167-f/);
    },
  },
], (c) => {
  const primary = buildPrimary();
  const path = c.arrange(primary);
  const report = pruneWorktrees(primary.root, { now: IDLE_PAST_AGE(), claim: NOBODY_CLAIMS, holdOpenPr: true });
  assert.deepEqual(report.removed, []);
  assert.deepEqual(report.held.map((r) => r.path), [path]);
  c.check(report, path);
});

test("#1167 NEGATIVE: the flag ON with open PRs that name neither the branch nor the session removes the tree", () => {
  const { path, report, listed } = pruneOfPushedTree("wt-1167-g", () => [{ number: 1203, headRefName: "agent/some-other-tree", labels: ["session:worker-elsewhere"] }], true);
  assert.equal(listed(), 1, "the listing was read, so the removal is the decision and not a flag left off");
  assert.deepEqual(report.held, []);
  assert.deepEqual(report.removed.map((r) => r.path), [path]);
  assert.ok(!existsSync(path));
});

test("#1167: the listing is read ONCE per run, not once per tree", () => {
  const primary = buildPrimary();
  pushedTree(primary, "wt-1167-h1");
  pushedTree(primary, "wt-1167-h2");
  const { listed } = openPullsOf([]);
  pruneWorktrees(primary.root, { now: IDLE_PAST_AGE(), claim: NOBODY_CLAIMS, holdOpenPr: true });
  assert.equal(listed(), 1);
});

// A11-160, step 9: how GitHub's answer to the listing is parsed (its fields, the labels flattened to names, a full page refused, a failed call read as unreadable) and the argument list that asks for it are
// `plugins/github/rows/open-pull-heads.test.ts`. What is core's is the repository it asks about and the cap it puts on the listing.
test("listOpenPulls asks the code host for the open PRs of this repo, capped at the limit, and answers what it read", () => {
  const { asked } = openPullsOf([{ number: 7, headRefName: "h", labels: ["session:x", "lane:y"] }]);
  const listing = listOpenPulls();
  assert.deepEqual(listing, { read: true, pulls: [{ number: 7, url: "https://github.com/fake/pull/7", headRefName: "h", labels: ["session:x", "lane:y"] }] });
  assert.deepEqual(asked, [{ repo: REPO, limit: PULL_LIST_LIMIT }]);
});

test("listOpenPulls answers a listing the code host could not read as unreadable, with its reason, and never as an empty list", () => {
  openPullsOf([], "the open pull request listing failed: gh: authentication required");
  assert.deepEqual(listOpenPulls(), { read: false, reason: "the open pull request listing failed: gh: authentication required" });
});

test(`${OPEN_PR_HOLD_FLAG}: ON only when the canary state says so; absent or unreadable state is OFF`, async () => {
  const dir = join(BASE, "state-on");
  mkdirSync(dir);
  writeFileSync(join(dir, "machinery-canary.json"), JSON.stringify({ flags: { [OPEN_PR_HOLD_FLAG]: { on: true } }, samples: [], memo: {} }));
  assert.equal(await openPrHoldOn(dir), true);

  const absent = join(BASE, "state-absent");
  mkdirSync(absent);
  assert.equal(await openPrHoldOn(absent), false);

  const bad = join(BASE, "state-bad");
  mkdirSync(bad);
  writeFileSync(join(bad, "machinery-canary.json"), "{ not json");
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string) => { stderr.push(String(chunk)); return true; };
  try {
    assert.equal(await openPrHoldOn(bad), false);
  } finally {
    (process.stderr as { write: unknown }).write = write;
  }
  assert.match(stderr.join(""), new RegExp(`${OPEN_PR_HOLD_FLAG}: machinery-canary\\.json is unreadable`));
});

test("the flag read agrees with org-health's parseCanaryState + machineryFlagOn on every shape, and reads the same file name", async () => {
  const { CANARY_STATE_FILE } = await import("./org-health/claim-and-tick-readings.ts");
const { machineryFlagOn, parseCanaryState } = await import("./org-health/fleet-build-readings.ts");
  const texts: (string | null)[] = [
    null, "", "null", "{ not json", "{}", '{"flags":{}}', '{"flags":{},"samples":[]}',
    `{"flags":{"${OPEN_PR_HOLD_FLAG}":{"on":true}},"samples":[],"memo":{}}`,
    `{"flags":{"${OPEN_PR_HOLD_FLAG}":{"on":false}},"samples":[],"memo":{}}`,
    `{"flags":{"${OPEN_PR_HOLD_FLAG}":{"on":"true"}},"samples":[]}`,
  ];
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string) => { stderr.push(String(chunk)); return true; };
  try {
    for (const [i, text] of texts.entries()) {
      const dir = join(BASE, `parity-${i}`);
      mkdirSync(dir);
      if (text !== null) writeFileSync(join(dir, CANARY_STATE_FILE), text);
      let reference: boolean;
      try {
        reference = machineryFlagOn(parseCanaryState(text), OPEN_PR_HOLD_FLAG);
      } catch {
        reference = false; // org-health THROWS on a shape it does not read; the open-PR read is OFF on any unreadable state
      }
      assert.equal(await openPrHoldOn(dir), reference, `shape ${i}: ${JSON.stringify(text)}`);
    }
  } finally {
    (process.stderr as { write: unknown }).write = write;
  }
});
