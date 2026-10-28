// no-token: none -- GitHub is a fake that keeps branches and pull requests in memory: no network, and no repository is touched
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveCheckNames, runLiveCheck } from "./stack-live-check.ts";
import type { PullSnapshots } from "./pull-snapshot.ts";
import { PUBLIC_REPOSITORY, snapshotsOf } from "./pull-snapshot-fixture.ts";
import type { Gh } from "./stack-retarget.ts";

const REPO = "a11ign/agent-org";
const RUN = "r1";
const NAMES = liveCheckNames(RUN);

type Pull = { number: number; base: string; head: string; state: string };

/** Snapshots over the in-memory pull requests, which the sweep reads the base and state of a pull request through: the same table `gh` edits, so a retarget is seen by the next read. */
function snapshotsOver(pulls: readonly Pull[]): PullSnapshots {
  const read = (number: number): Pull | undefined => pulls.find((each) => each.number === number);
  return { ...snapshotsOf({}), pull: (_repository, number) => {
    const found = read(number);
    return found === undefined ? null : { node: { number, state: found.state, baseRefName: found.base, headRefName: found.head }, flow: PUBLIC_REPOSITORY };
  } };
}

/** GitHub for the check, in memory: branches by name, and pull requests. The options make a step refuse, the way GitHub can. */
function fakeGitHub(options: { mergeRefused?: string; deleteOnMerge?: boolean; deleteFails?: boolean } = {}) {
  const refs = new Map<string, string>([["main", "m0"]]);
  const pulls: Pull[] = [];
  const calls: string[][] = [];
  let sha = 0;
  const notFound = () => new Error("gh: Not Found (HTTP 404)");
  const pullAt = (url: string) => {
    const pull = pulls.find((p) => url.endsWith(`/pull/${p.number}`));
    if (pull === undefined) throw notFound();
    return pull;
  };
  const viewOf = (pull: Pull) => JSON.stringify({ url: `https://github.com/${REPO}/pull/${pull.number}`, state: pull.state, baseRefName: pull.base, headRefName: pull.head, headRefOid: refs.get(pull.head) ?? "" });
  const gh: Gh = (args) => {
    calls.push(args);
    const [command, verb] = args;
    if (command === "api" && args[1] === `repos/${REPO}`) return "main\n";
    if (command === "api" && args[1].startsWith(`repos/${REPO}/git/ref/heads/`)) {
      const sha0 = refs.get(args[1].slice(`repos/${REPO}/git/ref/heads/`.length));
      if (sha0 === undefined) throw notFound();
      return `${sha0}\n`;
    }
    // `gh api -X <method> <path> [-f key=value ...]`: the method is the third word, the path the fourth.
    if (command === "api" && args[2] === "POST") {
      refs.set(args[5].slice("ref=refs/heads/".length), args[7].slice("sha=".length));
      return "{}";
    }
    if (command === "api" && args[2] === "PUT" && args[3].startsWith(`repos/${REPO}/contents/`)) {
      const branch = args[args.length - 1].slice("branch=".length);
      if (!refs.has(branch)) throw notFound();
      refs.set(branch, `s${++sha}`);
      return "{}";
    }
    if (command === "api" && args[2] === "DELETE") {
      if (options.deleteFails) throw new Error("gh: Forbidden (HTTP 403)");
      const branch = args[3].slice(`repos/${REPO}/git/refs/heads/`.length);
      if (!refs.delete(branch)) throw notFound();
      return "";
    }
    if (command === "pr" && verb === "create") {
      const base = args[args.indexOf("--base") + 1];
      const head = args[args.indexOf("--head") + 1];
      if (!refs.has(head)) throw notFound();
      const pull = { number: pulls.length + 1, base, head, state: "OPEN" };
      pulls.push(pull);
      return `https://github.com/${REPO}/pull/${pull.number}\n`;
    }
    if (command === "pr" && verb === "merge") {
      if (options.mergeRefused !== undefined) throw new Error(options.mergeRefused);
      const pull = pullAt(args[2]);
      pull.state = "MERGED";
      if (options.deleteOnMerge) refs.delete(pull.head);
      return "";
    }
    if (command === "pr" && verb === "view") return viewOf(pullAt(args[2]));
    if (command === "pr" && verb === "list") {
      const head = args[args.indexOf("--head") + 1];
      return JSON.stringify(pulls.filter((p) => p.head === head).map(({ state }) => ({ state })));
    }
    if (command === "pr" && verb === "edit") {
      pullAt(args[2]).base = args[args.indexOf("--base") + 1];
      return "";
    }
    if (command === "pr" && verb === "close") {
      pullAt(args[2]).state = "CLOSED";
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const snapshots = snapshotsOver(pulls);
  return { gh, calls, refs, pulls, snapshots };
}

test("A11-106: the live check proves the chain on GitHub: B is retargeted to the scratch branch with its head unmoved, and everything it made is removed", () => {
  const fake = fakeGitHub();
  const said: string[] = [];
  assert.equal(runLiveCheck({ repo: REPO, runId: RUN, gh: fake.gh, snapshots: fake.snapshots, log: (line) => said.push(line) }), true);
  const stacked = fake.pulls.find((p) => p.head === NAMES.stacked);
  assert.equal(stacked?.base, NAMES.scratch, "B's base read back as the scratch branch");
  assert.deepEqual([...fake.refs.keys()], ["main"], "every scratch branch is deleted, and the default branch is untouched");
  assert.ok(said.some((line) => line.startsWith("PASS: the stacked pull request's base is the scratch branch")));
  assert.ok(said.some((line) => line.startsWith("cleaned up 3 branches and 2 pull requests")));
  assert.ok(said.some((line) => /: base .* -> .*; head \w+ -> \w+$/.test(line)), "the base and head before and after are said");
});

test("A11-106: the live check never merges into the default branch: the only merge is of A into the scratch branch", () => {
  const fake = fakeGitHub();
  runLiveCheck({ repo: REPO, runId: RUN, gh: fake.gh, snapshots: fake.snapshots, log: () => {} });
  const merges = fake.calls.filter((args) => args[0] === "pr" && args[1] === "merge");
  assert.equal(merges.length, 1);
  assert.equal(fake.pulls[0].base, NAMES.scratch, "A's base is the scratch branch, so its merge lands there");
});

test("A11-106: a merge GitHub refuses fails the check, says why, and still removes every branch and pull request it made", () => {
  const fake = fakeGitHub({ mergeRefused: "gh: Resource not accessible by integration (HTTP 403)" });
  const said: string[] = [];
  assert.equal(runLiveCheck({ repo: REPO, runId: RUN, gh: fake.gh, snapshots: fake.snapshots, log: (line) => said.push(line) }), false);
  assert.ok(said.includes("FAIL: gh: Resource not accessible by integration (HTTP 403)"));
  assert.deepEqual([...fake.refs.keys()], ["main"], "nothing is left behind");
  assert.ok(fake.pulls.every((p) => p.state !== "OPEN"), "no pull request is left open");
});

test("A11-106: a repository that deletes merged branches fails the check with the reason, since the stale base cannot occur there", () => {
  const fake = fakeGitHub({ deleteOnMerge: true });
  const said: string[] = [];
  assert.equal(runLiveCheck({ repo: REPO, runId: RUN, gh: fake.gh, snapshots: fake.snapshots, log: (line) => said.push(line) }), false);
  assert.ok(said.some((line) => line.includes("the repository deletes merged branches, so the stale base does not occur here")));
  assert.deepEqual([...fake.refs.keys()], ["main"]);
});

test("A11-106: a branch that cannot be removed fails the check, and is named, so nothing is left unseen", () => {
  const fake = fakeGitHub({ deleteFails: true });
  const said: string[] = [];
  assert.equal(runLiveCheck({ repo: REPO, runId: RUN, gh: fake.gh, snapshots: fake.snapshots, log: (line) => said.push(line) }), false, "the chain held, but the cleanup did not");
  assert.ok(said.some((line) => line.startsWith(`cleanup: could not delete ${NAMES.scratch}: gh: Forbidden (HTTP 403)`)));
  assert.ok(said.includes("FAIL: cleanup was incomplete; see the lines above"));
});

test("A11-106: the names of a run's branches are under one prefix, so a stopped run is found by it", () => {
  assert.deepEqual(liveCheckNames("r9"), { scratch: "agent-org-live-check/r9/scratch", base: "agent-org-live-check/r9/base", stacked: "agent-org-live-check/r9/stacked" });
});
