// no-token: none -- the arguments are built, never run: no GitHub CLI runs
/**
 * A11-160 (step 9, part B): THE TWO CALLS THE GATE'S CONDITIONAL AND NARROWED READS ADD, as ARGUMENTS. The gate's tests (`src/packaging/work-gate-scopes-and-due-index.test.ts`) run on the fake code host, whose argument lists
 * are stand-in lines; what `gh` is actually sent is asserted here, literally, so a changed command fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);

test("one pull request's detail is `pr view <n> --json <fields>`, with no repository of its own (the aim is the runner's)", () => {
  assert.deepEqual(rows().pullViewArgs(12, "number,isDraft,state"), ["pr", "view", "12", "--json", "number,isDraft,state"]);
});

test("a conditional GET is `api -H If-None-Match: <tag> -i <path>`, `-H` first so the ledger counts it apart; with no tag it is `api -i <path>`", () => {
  assert.deepEqual(rows().conditionalGetArgs("repos/o/r/pulls", '"v1"'), ["api", "-H", 'If-None-Match: "v1"', "-i", "repos/o/r/pulls"]);
  assert.deepEqual(rows().conditionalGetArgs("repos/o/r/pulls", null), ["api", "-i", "repos/o/r/pulls"]);
});
