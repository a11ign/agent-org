// no-token: gh
// A11-238: this file runs the workflow's own steps with `gh` replaced by a stub first on PATH that answers from a table and records each call, so it never reaches GitHub and holds no token.
/**
 * A11-238: A STACKED PULL REQUEST IS MERGED WITH GITHUB'S STACK MERGE (`PUT /pulls/{n}/merge-async`), UP TO ITSELF, BY THE ARM BOT; A NON-STACKED ONE STILL USES AUTO-MERGE.
 *
 * GitHub refuses `gh pr merge --auto` for any pull request in a stack. `arm-approved` reads the pull request's `stack` field and, for a stacked one whose base is `main` and whose
 * required checks are green, requests the stack merge for that number alone; a refusal is one keyed comment carrying the head it was given at. `arm` (the `pull_request_target` job)
 * writes nothing for a stacked pull request. Like `auto-arm-workflow-honours-hold.test.ts`, this file RUNS the steps' `run:` text as the runner would (`bash -e`, the step's `env:`
 * resolved by hand), so what is asserted is what the workflow does, not what it says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";

const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/auto-arm.yml", import.meta.url));

type Step = { name?: string, id?: string, if?: string, env?: Record<string, string>, run?: string };
const jobs = (): Record<string, { steps: Step[] }> => (parseYaml(readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, { steps: Step[] }> }).jobs;
const stepRunning = (job: string, needle: string): Step => {
  const step = jobs()[job]?.steps.find((s) => (s.run ?? "").includes(needle));
  assert.ok(step, `${job} must have a step running ${needle}`);
  return step;
};

const EXECUTABLE = 0o755;
const REPOSITORY = "a11ign/agent-org";
const PR = 311;
const HEAD = "1111111111111111111111111111111111111111";
const STACK_PATH = `repos/${REPOSITORY}/pulls/${PR}`;
const MERGE_ASYNC = `${STACK_PATH}/merge-async`;
const COMMENTS = `repos/${REPOSITORY}/issues/${PR}/comments`;

/** One answer of the stub: what `gh` prints, what it says on stderr and how it exits. */
type Answer = { stdout?: unknown, stderr?: string, exit?: number };
/** Keyed by `<METHOD> <endpoint>` for `gh api` and `<command> <subcommand>` for the rest; a list is consumed in order and its last element repeats. */
type Table = Record<string, Answer | Answer[]>;

const APPROVED_PR = { state: "OPEN", baseRefName: "main", isCrossRepository: false, reviewDecision: "APPROVED", isDraft: false, labels: [], headRefOid: HEAD };

/** The stub: `--jq` is applied with the real jq, as `gh` does; an unlisted call succeeds and prints nothing. */
const STUB = `#!/usr/bin/env bash
dir=$(dirname "$0")
args="$*"; nl=$'\\n'; printf '%s\\n' "\${args//$nl/\\\\n}" >> "$dir/calls"
method=GET; jq_expr=""; endpoint=""; prev=""
for arg in "$@"; do
  case "$prev" in -X) method=$arg;; --jq) jq_expr=$arg;; esac
  case "$arg" in repos/*) endpoint=$arg;; esac
  prev=$arg
done
if [ "$1" = api ]; then key="$method $endpoint"; else key="$1 $2"; fi
n=$(cat "$dir/count" 2>/dev/null | grep -c "^$key\\$" || true)
printf '%s\\n' "$key" >> "$dir/count"
answer=$(jq -c --arg key "$key" --argjson n "$n" '.[$key] // {} | if type == "array" then (.[$n] // .[-1]) else . end' "$dir/table.json")
stdout=$(jq -r 'if .stdout == null then "" elif (.stdout | type) == "string" then .stdout else (.stdout | tojson) end' <<<"$answer")
jq -r '.stderr // empty' <<<"$answer" >&2
if [ -n "$jq_expr" ]; then printf '%s' "$stdout" | jq -r "$jq_expr"; else printf '%s\\n' "$stdout"; fi
exit "$(jq -r '.exit // 0' <<<"$answer")"
`;

type Outcome = { status: number | null, out: string, calls: string[], outputs: string };

function run(step: Step, table: Table, extraEnv: Record<string, string> = {}): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "auto-arm-stack-"));
  try {
    writeFileSync(join(dir, "gh"), STUB);
    chmodSync(join(dir, "gh"), EXECUTABLE);
    // The approval re-read waits five real seconds between tries; the stub makes that instant.
    writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "sleep"), EXECUTABLE);
    writeFileSync(join(dir, "table.json"), JSON.stringify(table));
    const outputFile = join(dir, "github-output");
    writeFileSync(outputFile, "");
    const result = spawnSync("bash", ["-e", "-c", step.run ?? ""], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        // The step's own literals first (HOLD_PREFIX, API_VERSION, the poll settings); the `${{ }}` expressions are the runner's, so they are supplied here.
        ...Object.fromEntries(Object.entries(step.env ?? {}).filter(([, v]) => !String(v).includes("${{"))),
        GH_TOKEN: "minted",
        PULL_REQUEST: String(PR),
        REPOSITORY,
        PR_LABELS: "[]",
        GITHUB_OUTPUT: outputFile,
        POLL_SECONDS: "0",
        ...extraEnv,
      },
    });
    const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean) : [];
    return { status: result.status, out: result.stdout + result.stderr, calls, outputs: readFileSync(outputFile, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const armApproved = () => stepRunning("arm-approved", "gh pr merge");
const STACKED = { [`GET ${STACK_PATH}`]: { stdout: { stack: { number: 1874 } } } };
const NOT_STACKED = { [`GET ${STACK_PATH}`]: { stdout: {} } };
const withPr = (pr: object) => ({ "pr view": { stdout: pr } });
/** `arm-approved` for an approved stacked pull request, with these answers on top. */
const runStacked = (answers: Table, env: Record<string, string> = {}) => run(armApproved(), { ...withPr(APPROVED_PR), ...STACKED, ...answers }, env);
const putCalls = (calls: string[]) => calls.filter((c) => c.includes("-X PUT"));
/** The one comment the run posted, or a failure when it posted none or several. */
const onlyPost = (out: Outcome): string => {
  const posts = out.calls.filter((c) => c.includes("-X POST"));
  assert.equal(posts.length, 1, `exactly one comment is posted:\n${out.calls.join("\n")}`);
  return posts[0]!;
};
const writes = (calls: string[]) => calls.filter((c) => /-X (PUT|POST|PATCH)|pr merge|pr ready/.test(c));

test("a stacked, approved pull request with green checks is merged through the stack merge, up to itself: one merge-async PUT for this number, pinned to its head, and no auto-merge", () => {
  const out = runStacked({
    [`PUT ${MERGE_ASYNC}`]: { stdout: { status: "pending", details: { message: "queued", uuid: "u-1" } } },
    [`GET ${MERGE_ASYNC}/u-1`]: [{ stdout: { status: "pending", details: { message: "x", uuid: "u-1" } } }, { stdout: { status: "enqueued", details: { message: "in the queue" } } }],
  });
  assert.equal(out.status, 0, out.out);
  const puts = putCalls(out.calls);
  assert.equal(puts.length, 1, `exactly one stack merge request:\n${out.calls.join("\n")}`);
  assert.match(puts[0]!, new RegExp(`${MERGE_ASYNC} .*-f sha=${HEAD}`), "it names this pull request and pins the head it read");
  assert.match(puts[0]!, /-f merge_method=merge -f merge_action=default/);
  assert.match(puts[0]!, /X-GitHub-Api-Version: 2026-03-10/);
  assert.ok(!out.calls.some((c) => c.startsWith("pr merge")), "a stacked pull request is never given to auto-merge");
  assert.ok(out.calls.every((c) => !/pulls\/(?!311\b)\d+/.test(c)), `no call names another pull request, so the members above are untouched:\n${out.calls.join("\n")}`);
  assert.ok(!out.calls.some((c) => c.includes("/comments")), "an accepted merge leaves no comment");
  assert.match(out.out, /stack merge of #311 is enqueued/);
});

test("a stack merge answered `merged` at once is done, and a request still pending after the last poll is done too, with no comment", () => {
  const merged = runStacked({ [`PUT ${MERGE_ASYNC}`]: { stdout: { status: "merged", details: { message: "ok", sha: HEAD } } } });
  assert.equal(merged.status, 0, merged.out);
  assert.match(merged.out, /is merged/);
  const pending = runStacked({
    [`PUT ${MERGE_ASYNC}`]: { stdout: { status: "pending", details: { message: "x", uuid: "u-2" } } },
    [`GET ${MERGE_ASYNC}/u-2`]: { stdout: { status: "pending", details: { message: "x", uuid: "u-2" } } },
  }, { POLL_ATTEMPTS: "3" });
  assert.equal(pending.status, 0, pending.out);
  assert.equal(pending.calls.filter((c) => c.includes("merge-async/u-2")).length, 3, "it polls the number of times it is given, and no more");
  assert.match(pending.out, /still pending/);
  assert.ok(!pending.calls.some((c) => c.includes("/comments")));
});

test("a refusal (the merge answers `failed`) is shown: one comment carrying the head and GitHub's message, and the job still exits 0", () => {
  const out = runStacked({
    [`PUT ${MERGE_ASYNC}`]: { stdout: { status: "pending", details: { message: "x", uuid: "u-3" } } },
    [`GET ${MERGE_ASYNC}/u-3`]: { stdout: { status: "failed", details: { message: "A pull request below has changes requested" } } },
  });
  assert.equal(out.status, 0, `a refusal is a done, not a red step:\n${out.out}`);
  const post = onlyPost(out);
  assert.match(post, new RegExp(`${COMMENTS} `));
  assert.match(post, new RegExp(`<!-- agent-org:stack-merge head=${HEAD} -->`));
  assert.match(post, /GitHub refused the stack merge of #311: A pull request below has changes requested/);
  assert.ok(!out.calls.some((c) => c.startsWith("pr merge")));
});

test("a refusal with a comment of ours already there edits it in place, so the pull request carries one comment and its head is the new one", () => {
  const out = runStacked({
    [`PUT ${MERGE_ASYNC}`]: { stdout: { status: "failed", details: { message: "still no" } } },
    [`GET ${COMMENTS}`]: { stdout: [{ id: 41, body: "an ordinary comment" }, { id: 42, body: `<!-- agent-org:stack-merge head=${"0".repeat(40)} -->\nGitHub refused the stack merge of #311: old` }] },
  });
  assert.equal(out.status, 0, out.out);
  assert.ok(!out.calls.some((c) => c.includes("-X POST")), "nothing new is posted");
  const patches = out.calls.filter((c) => c.includes("-X PATCH"));
  assert.equal(patches.length, 1);
  assert.match(patches[0]!, new RegExp(`repos/${REPOSITORY}/issues/comments/42 `));
  assert.match(patches[0]!, new RegExp(`head=${HEAD} -->`));
  assert.match(patches[0]!, /still no/);
});

test("a 4xx answer to the PUT is a refusal too, and the comment carries the error body's message", () => {
  const out = runStacked({
    [`PUT ${MERGE_ASYNC}`]: { stdout: { message: "Pull request is not mergeable" }, stderr: "gh: Pull request is not mergeable (HTTP 422)", exit: 1 },
  });
  assert.equal(out.status, 0, out.out);
  const post = onlyPost(out);
  assert.match(post, /GitHub refused the stack merge of #311: Pull request is not mergeable/);
});

test("a 409 (a stack merge for this pull request is already running) is not a refusal: no comment, exit 0", () => {
  const out = runStacked({
    [`PUT ${MERGE_ASYNC}`]: { stdout: { message: "pending" }, stderr: "gh: Conflict (HTTP 409)", exit: 1 },
  });
  assert.equal(out.status, 0, out.out);
  assert.ok(!out.calls.some((c) => c.includes("/comments")));
});

for (const [label, exit, word] of [["pending (gh exits 8)", 8, "pending"], ["red (gh exits 1)", 1, "red"]] as const) {
  test(`stacked, required checks ${label}: no stack merge, no comment, exit 0`, () => {
    const out = runStacked({ "pr checks": { exit } });
    assert.equal(out.status, 0, out.out);
    assert.deepEqual(writes(out.calls), [], "nothing is written");
    assert.match(out.out, new RegExp(`#311 is stacked and its required checks are not green \\(${word}\\): not merging yet`));
  });
}

/** `arm-approved` for an approved pull request that the stack read says is not stacked: auto-merge, never the stack merge. */
function assertArmedWithAutoMerge(stackRead: Table): Outcome {
  const out = run(armApproved(), { ...withPr(APPROVED_PR), ...stackRead });
  assert.equal(out.status, 0, out.out);
  assert.ok(out.calls.includes(`pr merge ${PR} --repo ${REPOSITORY} --auto --merge`), out.calls.join("\n"));
  assert.ok(!out.calls.some((c) => c.includes("merge-async")));
  return out;
}

test("a pull request that is not in a stack still uses auto-merge, and never the stack merge", () => {
  const out = assertArmedWithAutoMerge(NOT_STACKED);
  assert.ok(!out.calls.some((c) => c.startsWith("pr checks")), "the checks gate is the stack merge's; auto-merge waits for them itself");
});

const UNREADABLE = { [`GET ${STACK_PATH}`]: { stderr: "gh: Server Error (HTTP 500)", exit: 1 } };

test("a stack read that fails leaves a pull request on the path it took before stacks were read: auto-merge, and a green job", () => {
  assertArmedWithAutoMerge(UNREADABLE);
});

test("the same failed stack read in the arm job still runs auto-merge", () => {
  assert.deepEqual(writes(runArmJob(UNREADABLE).calls), [`pr merge ${PR} --repo ${REPOSITORY} --auto --merge`]);
});

test("a stacked pull request that is not the bottom one (its base is not main) is left alone: it is not even read as stacked, and nothing names it", () => {
  const out = run(armApproved(), { ...withPr({ ...APPROVED_PR, baseRefName: "admin/a11-1-below" }), ...STACKED });
  assert.equal(out.status, 0, out.out);
  assert.deepEqual(writes(out.calls), []);
  assert.ok(!out.calls.some((c) => c.includes("merge-async")));
  assert.match(out.out, /its base is admin\/a11-1-below, not main/);
});

test("a stacked pull request that is not approved or is held is not merged", () => {
  for (const pr of [{ ...APPROVED_PR, reviewDecision: "CHANGES_REQUESTED" }, { ...APPROVED_PR, labels: [{ name: "hold:ceo" }] }]) {
    const out = run(armApproved(), { ...withPr(pr), ...STACKED });
    assert.equal(out.status, 0, out.out);
    assert.ok(!out.calls.some((c) => c.includes("merge-async")), out.calls.join("\n"));
  }
});

test("an approved stacked draft is marked ready, then stack-merged", () => {
  const out = run(armApproved(), { ...withPr({ ...APPROVED_PR, isDraft: true }), ...STACKED, [`PUT ${MERGE_ASYNC}`]: { stdout: { status: "enqueued", details: { message: "ok" } } } });
  assert.equal(out.status, 0, out.out);
  const ready = out.calls.indexOf(`pr ready ${PR} --repo ${REPOSITORY}`);
  assert.ok(ready >= 0 && ready < out.calls.findIndex((c) => c.includes("-X PUT")), out.calls.join("\n"));
});

/** The `arm` job's steps as the runner would take them: the stack read, then whichever of the two steps its `if:` selects. */
function runArmJob(table: Table): { out: string, calls: string[] } {
  const steps = jobs().arm!.steps;
  const read = steps.find((s) => s.id === "stack");
  const notice = steps.find((s) => (s.run ?? "").includes("is in a stack"));
  const enable = stepRunning("arm", "gh pr merge");
  assert.ok(read && notice, "arm has the stack read and the stacked notice");
  assert.equal(notice.if, "steps.stack.outputs.number != ''");
  assert.equal(enable.if, "steps.stack.outputs.number == ''");
  const first = run(read, table);
  assert.equal(first.status, 0, first.out);
  const stacked = first.outputs.trim() !== "number=";
  const second = run(stacked ? notice : enable, table);
  assert.equal(second.status, 0, second.out);
  return { out: second.out, calls: [...first.calls, ...second.calls] };
}

test("the arm job writes nothing for a stacked pull request and says why", () => {
  const { out, calls } = runArmJob(STACKED);
  assert.deepEqual(writes(calls), []);
  assert.match(out, /AUTO-ARM: #311 is in a stack: GitHub refuses auto-merge for stacks, so arm-approved merges it with the stack merge once it is approved and green/);
});

test("the arm job still runs auto-merge for a pull request that is not in a stack", () => {
  const { calls } = runArmJob(NOT_STACKED);
  assert.deepEqual(writes(calls), [`pr merge ${PR} --repo ${REPOSITORY} --auto --merge`]);
});

test("the stack merge is the arm bot's alone: arm-approved mints, and the `arm` job and `relay` never call merge-async", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  const code = text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.equal(code.match(/merge-async/g)?.length, 2, "the PUT and the poll are the only places that name the API");
  const approved = jobs()["arm-approved"]!.steps;
  assert.ok(approved.some((s) => (s.run ?? "").includes("merge-async")));
  for (const job of ["arm", "relay"]) assert.ok(!jobs()[job]!.steps.some((s) => (s.run ?? "").includes("merge-async")), `${job} must not merge`);
});
