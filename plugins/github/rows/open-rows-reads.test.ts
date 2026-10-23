// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * agent-org#1624 (moved here by A11-160, step 6): AN OPEN-ROWS ANSWER THAT PARSES BUT IS NOT A LIST IS A REFUSAL THAT SAYS WHAT IT WAS. The operation (`openRowsOf`) throws it with the answer's first 120 characters; what the gate says
 * about a refused read, and that it is read as refused, is core's and runs on the fake code host (`src/work-gate/open-rows-null-said.test.ts`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";
import { recording } from "./recording-run.test.support.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const open = (answer: string) => rows().openRowsOf({ limit: 500, fields: "number", run: recording(answer).run });

test("agent-org#1624: an answer that is not a list throws, naming the answer", () => {
  for (const answer of ["null", "{}", "{\"message\":\"Not Found\"}", "\"text\""]) {
    assert.throws(() => open(answer), new Error(`the answer was not a list: ${JSON.stringify(answer)}`), `thrown for ${answer}`);
  }
  // THE CUT: a long answer is named by its first 120 characters, not whole
  const long = `{"message":"${"x".repeat(200)}"}`;
  assert.throws(() => open(long), new Error(`the answer was not a list: ${JSON.stringify(long.slice(0, 120))}`));
});

test("agent-org#1624 RED CONTROL: a list answer is returned", () => {
  assert.deepEqual(open("[]"), []);
  assert.deepEqual(open('[{"number":4}]'), [{ number: 4 }]);
});
