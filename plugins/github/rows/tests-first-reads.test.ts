// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * A11-160 (step 5): WHAT THE MERGE GUARD'S TESTS-FIRST RULE READS OFF A PULL REQUEST (a11ign#5109) -- the test files the rows it closes name, the files of its first commit, what changed since, and who approved a
 * change to them. Moved from `tests-first.test.ts`'s "THE LOOKUP" section, whose scripted `gh api` answered these reads for the guard's own lookup. What the guard DECIDES from the facts, and what it hands the code
 * host to read them with (the flag, the rows a body closes, how a row names its tests, what an approving review says), is core's and its test runs on the fake code host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { testsFirstReadsOf } from "./tests-first-reads.ts";

const TEST_PATH = "src/packaging/tests-first.test.ts";
const HEAD = "b".repeat(40);
const FIRST = "a".repeat(40);
const REVIEWED = "c".repeat(40);

/** How the guard reads a row's body and a review's body, as these tests need them (the guard's own parsers are core's). */
const pathsOf = (rowBody: string): string[] => [...rowBody.matchAll(/Tests-first:\s*(\S+)/g)].map((found) => found[1]!);
const isApproval = (reviewBody: string): boolean => /Tests-first:\s*changes?\s+approved/i.test(reviewBody);

/** A scripted `gh api` for PR 7 of the repository `a11ign/agent-org`, closing row 5109 whose body is `rowBody`. */
function scriptedGh(rowBody: string, { reviews = [] as object[], sinceReview = [] as string[], sinceFirst = [TEST_PATH, "src/row-claim.ts"] } = {}) {
  const calls: string[] = [];
  const run = (args: string[]): string => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? args.join(" ");
    calls.push(path);
    if (path.includes("/issues/5109")) return JSON.stringify({ body: rowBody, labels: [] });
    if (path.includes("/pulls/7/commits")) return `${FIRST}\n`;
    if (path.includes(`/commits/${FIRST}`)) return JSON.stringify([TEST_PATH]);
    if (path.includes(`/compare/${FIRST}...${HEAD}`)) return JSON.stringify(sinceFirst);
    if (path.includes(`/compare/${REVIEWED}...${HEAD}`)) return JSON.stringify(sinceReview);
    if (path.includes("/pulls/7/reviews")) return reviews.map((review) => JSON.stringify(review)).join("\n");
    throw new Error(`simulated: no answer for ${path}`);
  };
  return { run, calls };
}

const PR = { repo: "a11ign/agent-org", number: 7, head: HEAD, author: "worker-5109", rows: [{ repo: "a11ign/agent-org", number: 5109 }], pathsOf, isApproval };
const APPROVAL = { reviewer: "reviewer-7", state: "APPROVED", body: "Tests-first: change approved", commitId: REVIEWED };

test("the read finds the closed row's tests, the first commit's files and what changed since, and the edit", () => {
  const { run } = scriptedGh(`Tests-first: ${TEST_PATH}\n`);
  assert.deepEqual(testsFirstReadsOf(PR, run), { paths: [TEST_PATH], firstCommitFiles: [TEST_PATH], changedSinceFirst: [TEST_PATH, "src/row-claim.ts"], approvedBy: [] });
});

test("each row is read in its own repository, and the first commit is the pull request's first of one", () => {
  const { run, calls } = scriptedGh(`Tests-first: ${TEST_PATH}\n`);
  testsFirstReadsOf({ ...PR, rows: [{ repo: "a11ign/agent-org", number: 5109 }] }, run);
  assert.deepEqual(calls.slice(0, 2), ["repos/a11ign/agent-org/issues/5109", "repos/a11ign/agent-org/pulls/7/commits?per_page=1"]);
  assert.ok(calls.includes(`repos/a11ign/agent-org/commits/${FIRST}`) && calls.includes(`repos/a11ign/agent-org/compare/${FIRST}...${HEAD}`), calls.join(", "));
});

test("a row that is not marked is exempt: no tests named is undefined, never an empty list, and nothing more is read", () => {
  const unmarked = scriptedGh("## Region\nsrc/a.ts\n");
  assert.equal(testsFirstReadsOf(PR, unmarked.run), undefined, "an unmarked row is exempt");
  assert.deepEqual(unmarked.calls, ["repos/a11ign/agent-org/issues/5109"], "only the row was read");
});

test("a reviewer's approval counts only when it is by someone other than the author, carries the line, and read what will merge", () => {
  const via = (review: object, sinceReview: string[] = []) => testsFirstReadsOf(PR, scriptedGh(`Tests-first: ${TEST_PATH}\n`, { reviews: [review], sinceReview }).run);
  assert.deepEqual(via(APPROVAL)!.approvedBy, ["reviewer-7"], "POSITIVE CONTROL: the whole shape counts");
  assert.deepEqual(via({ ...APPROVAL, reviewer: "worker-5109" })!.approvedBy, [], "the author cannot approve their own edit");
  assert.deepEqual(via({ ...APPROVAL, body: "LGTM" })!.approvedBy, [], "an approval without the line did not read the tests");
  assert.deepEqual(via({ ...APPROVAL, state: "COMMENTED" })!.approvedBy, [], "the line in a bare comment is not an approval");
  assert.deepEqual(via(APPROVAL, [TEST_PATH])!.approvedBy, [], "the tests moved again after the review, so the reviewer did not read what will merge");
});

test("a read the run refuses THROWS, and so does a pull request with no first commit: core turns either into 'could not ask'", () => {
  const broken = (args: string[]): string => { throw new Error(`simulated outage on ${args.join(" ")}`); };
  assert.throws(() => testsFirstReadsOf(PR, broken), /simulated outage/);
  const noCommit = (args: string[]): string => (args.some((arg) => arg.includes("/pulls/7/commits")) ? "\n" : scriptedGh(`Tests-first: ${TEST_PATH}\n`).run(args));
  assert.throws(() => testsFirstReadsOf(PR, noCommit), /no first commit/);
});
