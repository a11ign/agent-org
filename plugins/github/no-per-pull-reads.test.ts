// no-token: none -- reads the plugin's source files; nothing runs
// A11-365: NO MODULE UNDER `plugins/github/` READS A PULL REQUEST BY ITSELF, outside the snapshot. A pull request's state is read once per repository per sweep (`pull-snapshot.ts`) and every reader reads it from there; a
// new `gh pr view`, `gh pr list`, `gh pr diff`, `pullRequest(number:` query or REST read of `pulls/<n>` in a module that is not named below fails this test, whichever reader it was written for.
//
// WHAT IS NAMED BELOW IS NAMED WITH ITS REASON, and each must still hold what it is named for: an entry that no longer reads a pull request fails too, so the list never outlives its reasons.
// ROW MODE (`rows/`) IS NOT HELD TO IT: its readers are the work gate's and the board's rows, called by their own loops with their own budget (`src/gh-conditional.ts`, `work-gate/`), and are handed the `run` their caller keeps its policy in.
// They are held to a ratchet instead: the number of call sites may not grow, and moving one to the snapshot lowers it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FOLDER = new URL(".", import.meta.url).pathname;

/** What reads a pull request by itself: `gh pr view|list|diff`, a GraphQL query for one pull request by its number, the REST read of `pulls/<n>`, and the read of a pull request's head ref. */
const PER_PULL_READ = /"pr",\s*"(?:view|list|diff)"|pullRequest\(number|\/pulls\/\$\{|refs\/pull\/\$\{/;

/** The modules that may, and why. */
const ALLOWED: Readonly<Record<string, string>> = {
  "pull-snapshot.ts": "the snapshot: the one query per repository, and the read by number of a pull request that is not open or was opened since, remembered",
  "merge-flow.ts": "the merge bot's file on a head (`refs/pull/<n>/head`), asked through `PullSnapshots.headHoldsMergeBot`, which asks once per head",
  "merged-findings.ts": "the diff of a merged pull request: the REST read of `pulls/<n>` asked for a diff, through the conditional reads, so it costs nothing after the first (a diff is content, not state, and is not in a snapshot)",
  "stack-merge.ts": "the stack facts of a pull request: the REST read of `pulls/<n>`, through the conditional reads, so it costs nothing while it is unchanged",
  "stack-retarget.ts": "the states of the pull requests of a stacked base's branch (`pr list --head`) and the retarget itself (`pr edit`): asked only for the bases of a run's blockers, which are few",
  "stack-live-check.ts": "the live check of the stacked retarget, a command a person runs on a real repository, which makes pull requests and reads back what it just changed",
  "close-pull.ts": "a write: the close of a pull request (`PATCH pulls/<n>`)",
  "update-branch.ts": "a write: the update of a pull request's branch (`PUT pulls/<n>/update-branch`)",
};

/** The source modules of the plugin outside `rows/`, as paths relative to the plugin: not tests, not fixtures, not shell. */
function modules(dir = FOLDER, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === "rows" || entry.name === "node_modules" ? [] : modules(join(dir, entry.name), `${prefix}${entry.name}/`);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && entry.name !== "pull-snapshot-fixture.ts" ? [`${prefix}${entry.name}`] : [];
  });
}

const textOf = (path: string): string => readFileSync(join(FOLDER, path), "utf8");

test("A11-365: no module outside the snapshot reads a pull request by itself", () => {
  const files = modules();
  assert.ok(files.length > 30, "POSITIVE CONTROL: the walk found the plugin's modules");
  const reading = files.filter((file) => PER_PULL_READ.test(textOf(file)));
  assert.deepEqual(reading.filter((file) => !(file in ALLOWED)), [], "a module that reads a pull request by number or lists them reads it from the snapshot (`PullSnapshots`) instead");
});

test("A11-365: each module named as allowed still reads a pull request that way, so the list holds only what it has a reason for", () => {
  for (const file of Object.keys(ALLOWED)) assert.ok(PER_PULL_READ.test(textOf(file)), `${file} no longer reads a pull request by itself: take it off the list`);
});

test("A11-365: the readers of a pull request are the snapshot's: each takes `PullSnapshots` and none asks `gh` for a pull request", () => {
  for (const file of ["reviews.ts", "pull-feedback.ts", "replies.ts", "open-pulls.ts", "dependency-pulls.ts", "closed-work.ts", "merged-findings.ts"]) {
    assert.match(textOf(file), /PullSnapshots/, `${file} reads from the snapshots`);
    assert.doesNotMatch(textOf(file), /readHeadHoldsMergeBot/, `${file} asks the head's file through the snapshots, which ask it once`);
  }
  assert.doesNotMatch(textOf("code-host.ts"), PER_PULL_READ, "and the code host makes no read of a pull request of its own");
});

test("A11-365: row mode's call sites that read a pull request by itself are held at their number, which only falls", () => {
  const dir = join(FOLDER, "rows");
  const sites = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .reduce((count, name) => count + readFileSync(join(dir, name), "utf8").split("\n").filter((line) => PER_PULL_READ.test(line)).length, 0);
  const BASELINE = 70;
  assert.ok(sites <= BASELINE, `row mode reads a pull request by itself at ${sites} sites, up from ${BASELINE}: read it from the snapshot (plugins/github/pull-snapshot.ts) or from the list the caller already has`);
  assert.ok(sites >= BASELINE - 10, `row mode is down to ${sites} sites from ${BASELINE}: lower BASELINE to ${sites} so it cannot grow back`);
});
