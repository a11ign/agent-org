// no-token: none -- `run` answers from a stub: no GitHub CLI runs
/**
 * A11-160, step 9: WHAT `pr:hold` ASKS OF GITHUB WHEN THE LABEL IT ADDS ALREADY EXISTS, in GitHub's own words. `src/packaging/pr-hold.test.ts` held these two cases over a stateful stub `gh` first on PATH
 * (`#3862 CONTROL` and `#3862: the SECOND take by the same session does not create the label again`), and the core test now runs the command over the fake code host, which has no `gh` to count `label create` calls on.
 * The other `#3862` cases (the make, its description, a failure that is not 'not found', a failed make) are in `pullwork-rows.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const REPO = "a11ign/agent-org";
const DESCRIPTION = "This PR is HELD by worker-old and must not merge.";

/** A repository that holds `labels`: a `pr edit --add-label` of any other is refused as GitHub refuses it, and a `label create` makes one. Every argument list handed to it is kept. */
function repositoryHolding(labels: string[]) {
  const calls: string[][] = [];
  const run: RowsRun = (args) => {
    calls.push([...args]);
    if (args[0] === "label") { labels.push(args[2]); return ""; }
    const label = args[args.indexOf("--add-label") + 1];
    if (!labels.includes(label)) throw Object.assign(new Error(`Command failed: gh\n'${label}' not found`), { status: 1, stderr: `'${label}' not found\n` });
    return "";
  };
  return { run, calls, labels };
}

test("#3862 CONTROL: a hold label the repository already has is added with ONE `pr edit` and no `label create`, though the caller asked for it to be made if missing", () => {
  const { run, calls } = repositoryHolding(["hold:worker-old"]);
  rows().editHeldPullLabel({ repo: REPO, number: 7, label: "hold:worker-old", how: "add", createdWith: DESCRIPTION, run });
  assert.deepEqual(calls, [["pr", "edit", "7", "--repo", REPO, "--add-label", "hold:worker-old"]]);
});

test("#3862: the SECOND take by the same session makes nothing: the first made the label, the second finds it", () => {
  const repository = repositoryHolding([]);
  const add = () => rows().editHeldPullLabel({ repo: REPO, number: 7, label: "hold:worker-old", how: "add", createdWith: DESCRIPTION, run: repository.run });
  add();
  assert.deepEqual(repository.calls.filter((call) => call[0] === "label").length, 1, "the first take made the label");
  repository.calls.length = 0;
  add();
  assert.deepEqual(repository.calls, [["pr", "edit", "7", "--repo", REPO, "--add-label", "hold:worker-old"]], "the second add is one edit and no make");
});
