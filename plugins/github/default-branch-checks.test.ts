// no-token: gh -- `readDefaultBranchRed` is handed a stub `run`; nothing here spawns `gh` or needs a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { corePolicy } from "../../src/plugins/policy.ts";
import { readDefaultBranchRed as read } from "./default-branch-checks.ts";

const readDefaultBranchRed = (repository: string, run: (args: string[]) => string) => read(repository, run, corePolicy());

const at = (minute: number) => `2026-10-16T12:${String(minute).padStart(2, "0")}:00Z`;

/** A `run` that answers the read with `branch` as the repository's default branch, and records each call. */
function answering(branch: unknown) {
  const calls: string[][] = [];
  return { calls, run: (args: string[]) => { calls.push(args); return JSON.stringify({ data: { repository: { defaultBranchRef: branch } } }); } };
}
const head = (nodes: unknown[], name = "main") => ({ name, target: { __typename: "Commit", oid: "c0ffee", statusCheckRollup: { contexts: { nodes } } } });
const run = (name: string, conclusion: string | null, minute: number) => ({ __typename: "CheckRun", name, conclusion, startedAt: at(minute), completedAt: conclusion === null ? null : at(minute) });

test("A11-179: the checks failing on the head of the default branch are named once each, newest run per name, with the branch and its head", () => {
  const { run: ask, calls } = answering(head([
    run("refusalOwners", "FAILURE", 10), run("refusalOwners", "FAILURE", 20), run("typecheck", "FAILURE", 5), run("typecheck", "SUCCESS", 15), run("lint", "CANCELLED", 30), run("suite", null, 31),
    { __typename: "StatusContext", context: "netlify", state: "ERROR", createdAt: at(35) },
  ]));
  assert.deepEqual(readDefaultBranchRed("a11ign/a11ign", ask), { branch: "main", head: "c0ffee", failing: ["refusalOwners", "netlify"] },
    "a re-run that passed replaces its failure, a cancelled or running check is not red, and a commit status is read as a check run");
  assert.deepEqual(calls[0].slice(0, 2), ["api", "graphql"]);
  assert.ok(calls[0].includes("owner=a11ign") && calls[0].includes("repo=a11ign"), "the repository is asked by its owner and name");
});

test("A11-179: a default branch whose head has no check on it has nothing failing, which is not 'could not ask'", () => {
  assert.deepEqual(readDefaultBranchRed("a11ign/a11ign", answering({ name: "trunk", target: { __typename: "Commit", oid: "abc", statusCheckRollup: null } }).run), { branch: "trunk", head: "abc", failing: [] });
});

test("A11-179: a repository gh refuses, one with no default branch, an answer of another shape and a name that is no repository's are null, never 'nothing is red'", () => {
  const refused = () => { throw new Error("gh: HTTP 502"); };
  assert.equal(readDefaultBranchRed("a11ign/a11ign", refused), null);
  assert.equal(readDefaultBranchRed("a11ign/a11ign", answering(null).run), null, "an empty repository has no default branch");
  assert.equal(readDefaultBranchRed("a11ign/a11ign", answering({ name: "main", target: { __typename: "Tag" } }).run), null, "a head that is no commit");
  assert.equal(readDefaultBranchRed("a11ign/a11ign", () => "not json"), null);
  assert.equal(readDefaultBranchRed("a11ign/a11ign", () => JSON.stringify({ data: null })), null);
  const calls: string[][] = [];
  assert.equal(readDefaultBranchRed("not a repository", (args) => { calls.push(args); return "{}"; }), null);
  assert.deepEqual(calls, [], "and nothing is asked for it");
});
