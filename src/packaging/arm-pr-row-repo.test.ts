// no-token: gh -- every `gh` here is an injected `run` seam; nothing imported spawns the real one
/**
 * #4426: A ROW IS READ FROM THE REPOSITORY IT LIVES IN. Arming agent-org#444 (`Closes a11ign/a11ign#4386`) printed
 * `Could not resolve to an issue or pull request with the number of 4386` and left the PR without `worker-4386`'s session
 * label, because `labelArmedPr` and `labelsWanted` asked the PR's own repository for the row's labels.
 *
 * The fake `run` answers a label read ONLY for the repository that holds the row, and fails otherwise -- the way GitHub does --
 * so a read against the wrong repository cannot pass by being lenient. The controls change ONE thing each.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { labelArmedPr, labelsWanted } from "../arm-pr.ts";

const PR_REPO = "a11ign/agent-org";
const ROW_REPO = "a11ign/a11ign";

/** A `gh` whose only issues are `#<number>` in `holders[number]`; every call is recorded. */
function fakeGh(holders: Record<number, { repo: string; labels: string[] }>) {
  const calls: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (!args.includes("view")) return "";
    const number = Number(args[args.indexOf("view") + 1]);
    const repo = args[args.indexOf("--repo") + 1];
    const row = holders[number];
    if (!row || row.repo !== repo) throw new Error(`GraphQL: Could not resolve to an issue with the number of ${number}. (${repo})`);
    return JSON.stringify({ labels: row.labels.map((name) => ({ name })) });
  };
  return { run, calls, reads: () => calls.filter((c) => c.includes("view")), edits: () => calls.filter((c) => c.includes("edit")) };
}

/** `console.error` captured for the duration of `body`, restored even when it throws. */
function captureErrors<T>(body: () => T): { value: T; errors: string[] } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => { errors.push(String(line)); };
  try {
    return { value: body(), errors };
  } finally {
    console.error = original;
  }
}

test("#4426: an agent-org PR closing a11ign/a11ign#4386 reads the labels in a11ign/a11ign and copies session:worker-4386", () => {
  const gh = fakeGh({ 4386: { repo: ROW_REPO, labels: ["in-progress", "session:worker-4386"] } });
  const { value, errors } = captureErrors(() => labelArmedPr({
    number: "444", repo: PR_REPO, prBody: `Closes ${ROW_REPO}#4386\n`, run: gh.run as never }));
  assert.deepEqual(errors, []);
  assert.equal(value.refused, false);
  assert.deepEqual(gh.reads().map((c) => c[c.indexOf("--repo") + 1]), [ROW_REPO]);
  assert.deepEqual(gh.edits().map((c) => [c[c.indexOf("--repo") + 1], c.slice(c.indexOf("--add-label"))]),
    [[PR_REPO, ["--add-label", "session:worker-4386"]]], "the PR is edited in ITS repository, with the row's label");
});

test("#4426: a bare `Closes #12` still reads the PR's own repository (unchanged)", () => {
  const gh = fakeGh({ 12: { repo: PR_REPO, labels: ["session:worker-12"] } });
  const { errors } = captureErrors(() => labelArmedPr({ number: "444", repo: PR_REPO, prBody: "Closes #12\n", run: gh.run as never }));
  assert.deepEqual(errors, []);
  assert.deepEqual(gh.reads().map((c) => c[c.indexOf("--repo") + 1]), [PR_REPO]);
  assert.equal(gh.edits().length, 1);
});

test("#4426 negative control: an unreadable row leaves the PR unlabelled and prints the existing message", () => {
  const gh = fakeGh({});
  const { value, errors } = captureErrors(() => labelArmedPr({
    number: "444", repo: PR_REPO, prBody: `Closes ${ROW_REPO}#4386\n`, run: gh.run as never }));
  assert.equal(value.refused, false);
  assert.equal(gh.edits().length, 0, "nothing is applied for a row that could not be read");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^arm-pr: could not read row #4386's labels -- leaving the PR unlabelled for it: /);
});

test("#4426: the refusal text (`labelsWanted`) reads the cross-repo row where it lives, and a bare row where the PR is", () => {
  const gh = fakeGh({ 4386: { repo: ROW_REPO, labels: ["session:worker-4386"] }, 12: { repo: PR_REPO, labels: ["session:worker-12"] } });
  const cross = labelsWanted({ repo: PR_REPO, prBody: `Closes ${ROW_REPO}#4386\n`, run: gh.run as never });
  assert.deepEqual(cross.labels, ["session:worker-4386"]);
  const bare = labelsWanted({ repo: PR_REPO, prBody: "Closes #12\n", run: gh.run as never });
  assert.deepEqual(bare.labels, ["session:worker-12"]);
  const unreadable = labelsWanted({ repo: PR_REPO, prBody: `Closes ${ROW_REPO}#999\n`, run: gh.run as never });
  assert.deepEqual(unreadable.labels, []);
  assert.match(unreadable.text, /could not re-read the rows' labels/);
});
