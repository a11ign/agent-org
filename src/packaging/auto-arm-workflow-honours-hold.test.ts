// no-token: gh
// a11ign/a11ign#3867: this file runs the workflow's arming step with `gh` replaced by a recorder first on PATH, so it never reaches GitHub and
// holds no token. Without this the acceptance job refuses the row's own command for the `gh` it spawns.
/**
 * #3867: THE PER-PR ARM JOB MUST NOT ARM A PULL REQUEST THAT CARRIES A `hold:` LABEL.
 *
 * `auto-arm-sweep.mjs` and `arm-pr.mjs` both read `armabilityOf` (src/pr-hold-state.mjs) and refuse a held PR; the workflow's `arm` job, the path that
 * fires first, ran `gh pr merge --auto` on the event alone (measured on a11ign/agent-org#311: armed eight seconds after `ready_for_review`, hold on).
 *
 * The job runs on `actions/checkout` alone and must stay that way (`arm-pr.mjs`'s header), so it cannot import the predicate and mirrors its prefix in
 * shell. A mirror that nothing compares drifts, so this file RUNS the step's own `run:` text as the runner would (`bash -e`, the step's `env:`
 * resolved by hand) and ties the prefix to `HOLD_PREFIX`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";
import { HOLD_PREFIX } from "../pr-hold-state.mjs";

// This repository's own workflow, found from this file: `HOME_CHECKOUT` refuses outside a declared project, and the workflow under test is the tool's.
const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/auto-arm.yml", import.meta.url));

type Step = { name?: string, env?: Record<string, string>, run?: string };

function armStep(): Step {
  const doc = parseYaml(readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, { steps: Step[] }> };
  const steps = doc.jobs.arm?.steps ?? [];
  const step = steps.find((s) => (s.run ?? "").includes("gh pr merge"));
  assert.ok(step, "the arm job must still have a step that runs `gh pr merge`");
  return step;
}

type Outcome = { status: number | null, stdout: string, ghCalls: string[] };

/** Run the arm step's script for a PR carrying `labels`, with a recorder for `gh`. */
function runArmStep(labels: string[]): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "auto-arm-hold-"));
  try {
    const record = join(dir, "gh-calls");
    writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${record}'\n`);
    chmodSync(join(dir, "gh"), 0o755);
    const step = armStep();
    const result = spawnSync("bash", ["-e", "-c", step.run ?? ""], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        // The step's own literals (HOLD_PREFIX) first; the `${{ }}` expressions are the runner's, so they are supplied here.
        ...Object.fromEntries(Object.entries(step.env ?? {}).filter(([, v]) => !String(v).includes("${{"))),
        // `gh` is the recorder above, so the minted token (`steps.octo-sts.outputs.token`, a11ign/a11ign#4199) only has to exist.
        GH_TOKEN: "minted",
        PULL_REQUEST: "311",
        REPOSITORY: "a11ign/agent-org",
        PR_LABELS: JSON.stringify(labels),
      },
    });
    const ghCalls = existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean) : [];
    return { status: result.status, stdout: result.stdout + result.stderr, ghCalls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a PR carrying hold:<session> is not armed: no `gh pr merge`, a line naming the hold, exit 0", () => {
  const out = runArmStep(["lane:any", "hold:worker-1"]);
  assert.equal(out.status, 0, `a refusal is a DONE, not a red step:\n${out.stdout}`);
  assert.deepEqual(out.ghCalls, [], "a held PR must not reach `gh`");
  assert.match(out.stdout, /not arming #311/);
  assert.match(out.stdout, /hold:worker-1/, "the line names the hold");
  assert.match(out.stdout, /armabilityOf/, "the line names the predicate being mirrored");
});

test("every holder is named when a PR carries several holds", () => {
  const out = runArmStep(["hold:worker-1", "hold:ceo"]);
  assert.deepEqual(out.ghCalls, []);
  assert.match(out.stdout, /hold:worker-1, hold:ceo/);
});

test("a PR with no hold: label is armed exactly once, with --auto --merge", () => {
  const out = runArmStep(["lane:any", "session:worker-1"]);
  assert.equal(out.status, 0, out.stdout);
  assert.deepEqual(out.ghCalls, ["pr merge 311 --repo a11ign/agent-org --auto --merge"]);
});

test("a PR with no labels at all is armed (the positive control: the skip is not unconditional)", () => {
  assert.equal(runArmStep([]).ghCalls.length, 1);
});

test("a label that merely CONTAINS hold does not hold", () => {
  for (const label of ["on-hold", "holdout", "hold", "lane:hold:x", "Hold:worker-1"]) {
    const out = runArmStep([label]);
    assert.equal(out.ghCalls.length, 1, `${label} is not a ${HOLD_PREFIX} label, so it must not stop arming:\n${out.stdout}`);
  }
});

test("a label name is data, never shell: a hostile hold: label neither runs nor arms", () => {
  const out = runArmStep(['hold:x"; echo INJECTED; "', "hold:$(echo INJECTED)"]);
  assert.deepEqual(out.ghCalls, []);
  assert.ok(!/^INJECTED/m.test(out.stdout), `a label reached the shell:\n${out.stdout}`);
});

test("DRIFT: the workflow's prefix IS HOLD_PREFIX, and the labels come in through env, not the script text", () => {
  const step = armStep();
  assert.equal(step.env?.HOLD_PREFIX, HOLD_PREFIX, "auto-arm.yml's HOLD_PREFIX must equal src/pr-hold-state.mjs's");
  assert.equal(step.env?.PR_LABELS, "${{ toJSON(github.event.pull_request.labels.*.name) }}");
  assert.ok(!(step.run ?? "").includes("${{"), "`${{ }}` inside run: is pasted into the shell as text; route it through env:");
});
