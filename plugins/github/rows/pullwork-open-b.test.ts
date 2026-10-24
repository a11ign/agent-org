// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * A11-160, step 9 (pipeline-lane authorship): THE ORDER OF THE TWO READS THAT SAY WHO `gh` AUTHORS AS. The core tests (`src/packaging/pipeline-lane-authorship.test.ts`) seed the login the code host says (or the
 * reasons no read could) and hold what `pr-open` DECIDES from it; these hold that a user token pays one call, that an empty answer of `api user` is a failure so the viewer is asked, and that a refusal of the
 * first leaves the second to answer. The failure wording is held beside the operation in `pullwork-rows.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const BOT = "a11ign-workers[bot]";
const ACCESS_403 = Object.assign(new Error("Command failed: gh api user --jq .login"), { stderr: "gh: Resource not accessible by integration (HTTP 403)\n" });

/** A `gh` that answers as a token would: `api user` and the GraphQL viewer each from its own entry (a function throws), every ask recorded in order. */
function fakeGh(answers: { user: string | (() => string); viewer: string | (() => string) }) {
  const asked: string[] = [];
  const run: RowsRun = (args) => {
    const which = args[0] === "api" && args[1] === "user" ? "user" : args[0] === "api" && args[1] === "graphql" && args.join(" ").includes("viewer") ? "viewer" : null;
    assert.ok(which, `an unexpected gh call: ${args.join(" ")}`);
    asked.push(which);
    const answer = answers[which];
    return typeof answer === "function" ? answer() : answer;
  };
  return { run, asked };
}
const refuses403 = (): string => { throw ACCESS_403; };

test("#811 (1): an installation token's `api user` is refused (403), so the viewer is asked after it, and only then", () => {
  const { run, asked } = fakeGh({ user: refuses403, viewer: BOT });
  assert.deepEqual(rows().authoringLoginOf({ run }), { login: BOT });
  assert.deepEqual(asked, ["user", "viewer"]);
});

test("#811 (4): a user token pays ONE call -- `api user` answering means the viewer is never asked, and an empty answer is no login", () => {
  const user = fakeGh({ user: ` a11ign-ai-workers\n`, viewer: () => { throw new Error("must not be asked"); } });
  assert.deepEqual(rows().authoringLoginOf({ run: user.run }), { login: "a11ign-ai-workers" });
  assert.deepEqual(user.asked, ["user"]);
  const empty = fakeGh({ user: "", viewer: BOT });
  assert.deepEqual(rows().authoringLoginOf({ run: empty.run }), { login: BOT }, "an empty `api user` answer is a failure, so the viewer is asked");
  assert.deepEqual(empty.asked, ["user", "viewer"]);
});

test("#811 (3): when neither read says, the first failure's own words (gh's stderr, not just `Command failed`) lead the reasons, and the viewer's follow", () => {
  const viewerThrows = fakeGh({ user: refuses403, viewer: () => { throw new Error("HTTP 502"); } });
  assert.deepEqual(rows().authoringLoginOf({ run: viewerThrows.run }), { failures: ["`gh api user`: gh: Resource not accessible by integration (HTTP 403)", "the GraphQL `viewer` read: HTTP 502"] });
  const viewerEmpty = fakeGh({ user: refuses403, viewer: () => "\n" });
  assert.deepEqual(rows().authoringLoginOf({ run: viewerEmpty.run }), { failures: ["`gh api user`: gh: Resource not accessible by integration (HTTP 403)", "the GraphQL `viewer` read answered no login"] });
});
