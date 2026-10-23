// no-token: none -- every read and write goes through the fake code host; nothing here reaches GitHub
/**
 * #4426: A ROW IS READ FROM THE REPOSITORY IT LIVES IN. Arming agent-org#444 (`Closes a11ign/a11ign#4386`) printed
 * `Could not resolve to an issue or pull request with the number of 4386` and left the PR without `worker-4386`'s session
 * label, because `labelArmedPr` and `labelsWanted` asked the PR's own repository for the row's labels.
 *
 * The fake code host holds a row ONLY in the repository that holds it, and refuses a read against any other -- the way GitHub does --
 * so a read against the wrong repository cannot pass by being lenient. The controls change ONE thing each.
 * (A11-160, step 5: the arguments `labelsOfRow` and `addLabelsToPull` send are the GitHub plugin's, `plugins/github/rows/arming.test.ts`.)
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { labelArmedPr, labelsWanted } from "../arm-pr.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { fakePull } from "../plugins/fakes/code-host-pulls.ts";

const PR_REPO = "a11ign/agent-org";
const ROW_REPO = "a11ign/a11ign";

afterEach(() => forgetActivation());

/** The code host for pull request #444 of `PR_REPO`, whose rows are `holders[number]` in the repository named: the PR's own is the world's, another is a foreign row. */
function fakeHost(holders: Record<number, { repo: string; labels: string[] }>) {
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  world.repo = PR_REPO;
  for (const [number, { repo, labels }] of Object.entries(holders)) {
    const row = fakeRow(world, Number(number), { labels });
    if (repo === PR_REPO) world.rows.set(row.number, row);
    else world.foreignRows.set(`${repo}#${number}`, row);
  }
  const pull = fakePull(world, 444);
  substituteCodeHost(host);
  return { world, pull, reads: () => world.calls.filter((c) => c.startsWith("labelsOfRow ")).map((c) => c.split(" ")[1]), edits: () => world.calls.filter((c) => c.startsWith("addLabelsToPull ")) };
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
  const gh = fakeHost({ 4386: { repo: ROW_REPO, labels: ["in-progress", "session:worker-4386"] } });
  const { value, errors } = captureErrors(() => labelArmedPr({ number: "444", repo: PR_REPO, prBody: `Closes ${ROW_REPO}#4386\n` }));
  assert.deepEqual(errors, []);
  assert.equal(value.refused, false);
  assert.deepEqual(gh.reads(), [`${ROW_REPO}#4386`]);
  assert.deepEqual(gh.edits(), [`addLabelsToPull ${PR_REPO}#444 session:worker-4386`], "the PR is edited in ITS repository, with the row's label");
  assert.deepEqual(gh.pull.labels, ["session:worker-4386"]);
});

test("#4426: a bare `Closes #12` still reads the PR's own repository (unchanged)", () => {
  const gh = fakeHost({ 12: { repo: PR_REPO, labels: ["session:worker-12"] } });
  const { errors } = captureErrors(() => labelArmedPr({ number: "444", repo: PR_REPO, prBody: "Closes #12\n" }));
  assert.deepEqual(errors, []);
  assert.deepEqual(gh.reads(), [`${PR_REPO}#12`]);
  assert.equal(gh.edits().length, 1);
});

test("#4426 negative control: an unreadable row leaves the PR unlabelled and prints the existing message", () => {
  const gh = fakeHost({});
  const { value, errors } = captureErrors(() => labelArmedPr({ number: "444", repo: PR_REPO, prBody: `Closes ${ROW_REPO}#4386\n` }));
  assert.equal(value.refused, false);
  assert.equal(gh.edits().length, 0, "nothing is applied for a row that could not be read");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^arm-pr: could not read row #4386's labels -- leaving the PR unlabelled for it: /);
});

test("#4426: the row held in the OTHER repository is not found where the PR lives -- the fake refuses the wrong repository, so the first test cannot pass by leniency", () => {
  const gh = fakeHost({ 4386: { repo: ROW_REPO, labels: ["session:worker-4386"] } });
  const { value, errors } = captureErrors(() => labelArmedPr({ number: "444", repo: PR_REPO, prBody: "Closes #4386\n" }));
  assert.equal(value.refused, false);
  assert.deepEqual(gh.reads(), [`${PR_REPO}#4386`], "a bare number is the PR's own repository");
  assert.equal(gh.edits().length, 0);
  assert.match(errors.join("\n"), /could not read row #4386's labels/);
});

test("#4426: the refusal text (`labelsWanted`) reads the cross-repo row where it lives, and a bare row where the PR is", () => {
  fakeHost({ 4386: { repo: ROW_REPO, labels: ["session:worker-4386"] }, 12: { repo: PR_REPO, labels: ["session:worker-12"] } });
  const cross = labelsWanted({ repo: PR_REPO, prBody: `Closes ${ROW_REPO}#4386\n` });
  assert.deepEqual(cross.labels, ["session:worker-4386"]);
  const bare = labelsWanted({ repo: PR_REPO, prBody: "Closes #12\n" });
  assert.deepEqual(bare.labels, ["session:worker-12"]);
  const unreadable = labelsWanted({ repo: PR_REPO, prBody: `Closes ${ROW_REPO}#999\n` });
  assert.deepEqual(unreadable.labels, []);
  assert.match(unreadable.text, /could not re-read the rows' labels/);
});
