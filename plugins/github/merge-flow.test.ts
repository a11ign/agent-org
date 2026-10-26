// no-token: gh -- `readMergeFlow` is handed a stub `run`; nothing here spawns `gh` or needs a token.
//
// A11-291: whether a repository can merge a pull request by itself -- it allows auto-merge, and its default branch holds the arm workflow. a11ign/plugin#10 sat approved and green for a day in a repository with neither.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GhFailure } from "./gh.ts";
import { ARM_WORKFLOW_PATH, readMergeFlow } from "./merge-flow.ts";

const failure = (stderr: string): GhFailure => new GhFailure(["api"], { status: 1, stdout: "", stderr });

/** A `run` that answers the two reads: the repository's `allow_auto_merge` (`autoMerge`, its text) and the arm workflow's file (`workflow`: its `.type`, or the failure to throw). */
function answering({ autoMerge, workflow }: { autoMerge: string | GhFailure; workflow: string | GhFailure }) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    const answer = args[1] === "repos/a11ign/plugin" ? autoMerge : workflow;
    if (answer instanceof GhFailure) throw answer;
    return answer;
  };
  return { calls, run };
}

test("A11-291: a repository that allows auto-merge and holds the arm workflow has a merge flow, and the two reads are the repository's setting and the file on its default branch", () => {
  const { run, calls } = answering({ autoMerge: "true\n", workflow: "file\n" });
  assert.deepEqual(readMergeFlow("a11ign/plugin", run), { autoMerge: true, armWorkflow: true });
  assert.deepEqual(calls, [["api", "repos/a11ign/plugin", "--jq", ".allow_auto_merge"], ["api", `repos/a11ign/plugin/contents/${ARM_WORKFLOW_PATH}`, "--jq", ".type"]]);
  assert.equal(ARM_WORKFLOW_PATH, ".github/workflows/auto-arm.yml");
});

test("A11-291: a repository with auto-merge off and no arm workflow (a11ign/plugin before A11-291) has neither, and one with only one of them says which", () => {
  const notFound = failure("gh: Not Found (HTTP 404)");
  assert.deepEqual(readMergeFlow("a11ign/plugin", answering({ autoMerge: "false\n", workflow: notFound }).run), { autoMerge: false, armWorkflow: false });
  assert.deepEqual(readMergeFlow("a11ign/plugin", answering({ autoMerge: "true\n", workflow: notFound }).run), { autoMerge: true, armWorkflow: false });
  assert.deepEqual(readMergeFlow("a11ign/plugin", answering({ autoMerge: "false\n", workflow: "file\n" }).run), { autoMerge: false, armWorkflow: true });
});

test("A11-291: a read that cannot be made is null, never 'no flow': a refusal other than 404, a setting GitHub leaves out, a failed call and a name that is not owner/name", () => {
  assert.equal(readMergeFlow("a11ign/plugin", answering({ autoMerge: "true\n", workflow: failure("gh: Resource not accessible by integration (HTTP 403)") }).run), null, "403 on the file");
  assert.equal(readMergeFlow("a11ign/plugin", answering({ autoMerge: "true\n", workflow: failure("gh: Bad Gateway (HTTP 502)") }).run), null, "502 on the file");
  assert.equal(readMergeFlow("a11ign/plugin", answering({ autoMerge: "null\n", workflow: "file\n" }).run), null, "a setting the account cannot see is not 'off'");
  assert.equal(readMergeFlow("a11ign/plugin", answering({ autoMerge: failure("gh: Not Found (HTTP 404)"), workflow: "file\n" }).run), null, "a repository it cannot read");
  assert.equal(readMergeFlow("plugin", answering({ autoMerge: "true\n", workflow: "file\n" }).run), null, "a name without its owner");
  assert.equal(readMergeFlow("a11ign/plugin/extra", answering({ autoMerge: "true\n", workflow: "file\n" }).run), null);
});
