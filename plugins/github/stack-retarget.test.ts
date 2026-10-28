// no-token: none -- `gh` is a fake that answers from a table of pull requests, branches and default branches, and the pull requests are read through snapshots over the same table: no network, and no pull request is touched
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PullSnapshots } from "./pull-snapshot.ts";
import { PUBLIC_REPOSITORY, snapshotsOf } from "./pull-snapshot-fixture.ts";
import { baseKindOf, sweepRetargets, type Gh } from "./stack-retarget.ts";

const STACKED = "https://github.com/a11ign/agent-org/pull/1749";
const OTHER = "https://github.com/a11ign/agent-org/pull/1750";

type World = {
  /** The stacked pull request's base, and its state. */
  base: string;
  state?: string;
  /** The default branch of the repository. */
  defaultBranch?: string;
  /** The states of the pull requests whose head is a branch, by name: `heads[branch]`. */
  heads?: Record<string, string[]>;
  /** The branches that exist. */
  branches?: string[];
  /** The message `gh pr edit` fails with, when it refuses the edit. */
  editRefused?: string;
  /** Pull requests whose view fails, by URL. */
  unreadable?: string[];
};

/** The value that follows `flag` in `args`, as `gh` reads its options. */
const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

/** A `gh` that answers from `world` and records each call. A `pr edit` moves the base in `world`, as GitHub does. */
function fakeGh(world: World) {
  const calls: string[][] = [];
  const pulls: Record<string, { base: string; state: string }> = {
    [STACKED]: { base: world.base, state: world.state ?? "OPEN" },
    [OTHER]: { base: world.base, state: "OPEN" },
  };
  const gh: Gh = (args) => {
    calls.push(args);
    // `gh pr <verb> <url>` and `gh api <path>`: the URL or path is the third word of a pull request call and the second of `api`.
    const [command, subcommand, target] = args;
    if (command === "repo" && subcommand === "view") return `${world.defaultBranch ?? "main"}\n`;
    if (command === "pr" && subcommand === "list") return JSON.stringify((world.heads?.[valueAfter(args, "--head")] ?? []).map((state) => ({ state })));
    if (command === "api") {
      const branch = decodeURIComponent(subcommand.split("/branches/")[1]);
      if (world.branches?.includes(branch)) return "{}";
      throw new Error("gh: Not Found (HTTP 404)");
    }
    if (command === "pr" && subcommand === "edit") {
      if (world.editRefused !== undefined) throw new Error(world.editRefused);
      pulls[target].base = valueAfter(args, "--base");
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  // The snapshots read the same table, so an edit is seen by the next read; a pull request in `unreadable` is one they cannot say.
  const invalidated: string[] = [];
  const snapshots: PullSnapshots = { ...snapshotsOf({}), invalidate: (repository) => { invalidated.push(repository); },
    pull: (repository, number) => {
      const url = `https://github.com/${repository}/pull/${number}`;
      const pull = world.unreadable?.includes(url) ? undefined : pulls[url];
      return pull === undefined ? null : { node: { number, baseRefName: pull.base, state: pull.state }, flow: PUBLIC_REPOSITORY };
    } };
  return { gh, calls, pulls, snapshots, invalidated };
}

/** The bases the run's blockers are on, which the sweep may move: the stacked pull request's base is one of them in every test but the one that says otherwise. */
const STACKED_ON = new Set(["nbf-1-fit"]);

const sweep = (urls: string[], gh: Gh, snapshots: PullSnapshots, previous: Record<string, string> = {}, stacked: ReadonlySet<string> = STACKED_ON) => {
  const said: string[] = [];
  const notes = sweepRetargets({ urls, previous, stacked, defaults: new Map(), gh, snapshots, log: (line) => said.push(line) });
  return { notes, said };
};

test("A11-106: a base no blocker of the run is on is not moved, even when a pull request from that branch merged", () => {
  const fake = fakeGh({ base: "release/2", heads: { "release/2": ["MERGED"] }, branches: ["release/2"] });
  const { notes, said } = sweep([STACKED], fake.gh, fake.snapshots);
  assert.deepEqual([notes, said], [{}, []]);
  assert.equal(fake.calls.some((args) => args[1] === "edit"), false, "the worker's own base is not the board's to move");
});

test("A11-106: a stacked pull request whose base merged is moved to the default branch, and its head is never touched", () => {
  const fake = fakeGh({ base: "nbf-1-fit", heads: { "nbf-1-fit": ["MERGED"] }, branches: ["nbf-1-fit"] });
  const { notes, said } = sweep([STACKED], fake.gh, fake.snapshots);
  assert.deepEqual(notes, {}, "retargeted, so nothing is said");
  assert.deepEqual(fake.calls.filter((args) => args[1] === "edit"), [["pr", "edit", STACKED, "--base", "main"]], "one edit, to the default branch");
  assert.equal(fake.pulls[STACKED].base, "main", "read back");
  assert.equal(fake.calls.some((args) => ["push", "rebase", "merge", "ready", "close"].includes(args[1] ?? args[0])), false, "no push, rebase, merge, or close");
  assert.deepEqual(said, [`${STACKED}: its base nbf-1-fit merged, so it now targets main`]);
});

test("A11-106: a stacked base whose branch was deleted with nothing merged is said as needing a retarget by hand, and nothing is edited", () => {
  const fake = fakeGh({ base: "nbf-1-fit", heads: { "nbf-1-fit": ["CLOSED"] } });
  const { notes } = sweep([STACKED], fake.gh, fake.snapshots);
  assert.equal(notes[STACKED], `Needs retarget: ${STACKED} still targets nbf-1-fit, whose branch is gone: retarget it by hand`);
  assert.equal(fake.calls.some((args) => args[1] === "edit"), false, "a person decides, since the work may never have landed");
});

test("A11-106: a base an open pull request builds on, a long-lived branch no pull request came from, and the default branch are left alone", () => {
  const worlds: World[] = [
    { base: "nbf-1-fit", heads: { "nbf-1-fit": ["OPEN", "MERGED"] }, branches: ["nbf-1-fit"] },
    { base: "release/2", heads: {}, branches: ["release/2"] },
    { base: "main", heads: {} },
  ];
  for (const world of worlds) {
    const fake = fakeGh(world);
    const { notes, said } = sweep([STACKED], fake.gh, fake.snapshots);
    assert.deepEqual([notes, said], [{}, []], JSON.stringify(world));
    assert.equal(fake.calls.some((args) => args[1] === "edit"), false, JSON.stringify(world));
  }
});

test("A11-106: a refused edit keeps its reason on the pull request, and the next sweep asks again", () => {
  const fake = fakeGh({ base: "nbf-1-fit", heads: { "nbf-1-fit": ["MERGED"] }, branches: ["nbf-1-fit"], editRefused: "gh: Resource not accessible by integration (HTTP 403)" });
  const first = sweep([STACKED], fake.gh, fake.snapshots);
  assert.equal(first.notes[STACKED], `Needs retarget: ${STACKED} still targets nbf-1-fit, whose pull request merged; retarget failed, and agent-org tries again: gh: Resource not accessible by integration (HTTP 403)`);
  assert.equal(first.said.length, 1);
  const second = sweep([STACKED], fake.gh, fake.snapshots, first.notes);
  assert.equal(fake.calls.filter((args) => args[1] === "edit").length, 2, "the edit is made again");
  assert.match(second.notes[STACKED] ?? "", /retarget failed/);
});

test("A11-106: a pull request that cannot be read keeps the note it had, and is asked again, never retargeted on a guess", () => {
  const fake = fakeGh({ base: "nbf-1-fit", heads: { "nbf-1-fit": ["MERGED"] }, branches: ["nbf-1-fit"], unreadable: [STACKED] });
  const previous = { [STACKED]: "Needs retarget: earlier" };
  const { notes, said } = sweep([STACKED], fake.gh, fake.snapshots, previous);
  assert.deepEqual(notes, previous);
  assert.equal(fake.calls.some((args) => args[1] === "edit"), false);
  assert.match(said[0], /its base could not be checked, so the next sweep asks again/);
});

test("A11-106: a branch that cannot be looked up, rather than found missing, is not said to be gone", () => {
  const snapshots = snapshotsOf({ "a11ign/agent-org": [{ number: 1749, baseRefName: "nbf-1-fit", state: "OPEN" }] });
  const gh: Gh = (args) => {
    if (args[0] === "repo") return "main\n";
    if (args[0] === "pr" && args[1] === "list") return "[]";
    throw new Error("gh: Bad credentials (HTTP 401)");
  };
  const { notes } = sweep([STACKED], gh, snapshots);
  assert.deepEqual(notes, {}, "an answer that is not a 404 is no evidence the branch is gone");
});

test("A11-106: the default branch of a repository is read once per sweep, however many of its pull requests are asked", () => {
  const fake = fakeGh({ base: "nbf-1-fit", heads: { "nbf-1-fit": ["MERGED"] }, branches: ["nbf-1-fit"] });
  const defaults = new Map<string, string>();
  sweepRetargets({ urls: [STACKED, OTHER], previous: {}, stacked: STACKED_ON, defaults, gh: fake.gh, snapshots: fake.snapshots, log: () => {} });
  assert.equal(fake.calls.filter((args) => args[0] === "repo").length, 1);
  assert.deepEqual([...defaults], [["a11ign/agent-org", "main"]]);
});

test("A11-106: a pull request that already merged or closed is not retargeted", () => {
  const fake = fakeGh({ base: "nbf-1-fit", state: "MERGED", heads: { "nbf-1-fit": ["MERGED"] }, branches: ["nbf-1-fit"] });
  assert.deepEqual(sweep([STACKED], fake.gh, fake.snapshots).notes, {});
  assert.equal(fake.calls.some((args) => args[1] === "edit"), false);
});

test("A11-106: the base's kind is merged when its pull request merged with none open, gone when its branch is missing, and kept when it exists", () => {
  const exists = () => true;
  const missing = () => false;
  assert.equal(baseKindOf({ base: "main", defaultBranch: "main", heads: ["MERGED"], branchExists: exists }), "current");
  assert.equal(baseKindOf({ base: "b", defaultBranch: "main", heads: ["MERGED", "OPEN"], branchExists: exists }), "current");
  assert.equal(baseKindOf({ base: "b", defaultBranch: "main", heads: ["MERGED"], branchExists: missing }), "merged");
  assert.equal(baseKindOf({ base: "b", defaultBranch: "main", heads: ["CLOSED"], branchExists: missing }), "gone");
  assert.equal(baseKindOf({ base: "b", defaultBranch: "main", heads: [], branchExists: exists }), "kept");
});

test("A11-149: two instances sweep one stacked pull request, and one edit moves its base: the second reads the default branch and edits nothing", () => {
  const fake = fakeGh({ base: "nbf-1-fit", heads: { "nbf-1-fit": ["MERGED"] }, branches: ["nbf-1-fit"] });
  // Each sweep is one instance's pool, with its own memory of the default branch, and the two share the one pull request on GitHub.
  const first = sweep([STACKED], fake.gh, fake.snapshots);
  const second = sweep([STACKED], fake.gh, fake.snapshots);
  assert.deepEqual([first.notes, second.notes], [{}, {}], "neither says anything: the first retargeted it and the second found it done");
  assert.deepEqual(fake.calls.filter((args) => args[1] === "edit"), [["pr", "edit", STACKED, "--base", "main"]], "exactly one edit reaches GitHub");
  assert.equal(fake.pulls[STACKED].base, "main", "the base is the default branch after both sweeps");
});
