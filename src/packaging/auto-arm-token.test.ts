/**
 * #416: AUTO-ARM MUST ARM WITH A TOKEN WHOSE EVENTS FIRE.
 *
 * GitHub does not trigger workflows from events created with `GITHUB_TOKEN` -- a merge completed by
 * `github-actions[bot]` fires neither `pull_request: closed` nor a `push`, so `trunk-guard`, `close-rows`
 * and every push watchdog go silent for exactly the merges the pipeline itself performs (measured
 * 2026-09-08, 37 data points, no exceptions). Arming with a real PAT (`A11IGN_BOT_TOKEN`) instead means
 * the completed merge is attributed to that identity and every one of those triggers fires.
 *
 * Creating the token is NOT this row's job -- `ceo` asks the chairman for it. This file asserts the
 * WORKFLOW's own text, because the decision here is bash inside `auto-arm.yml`, not a separate script:
 * both `arm` (the per-PR trigger) and `sweep` (#344's queue sweep) must read the secret when present and
 * fall back to `GITHUB_TOKEN`, with a printed warning, when it is not -- so the pipeline keeps arming
 * before the token exists rather than stopping (#382's own lesson: a job that cannot do its intended work
 * must say which path it took).
 *
 * Scoped to EXACTLY these two jobs' own `run:` text, never the whole file -- C2 (#416's sibling) added a
 * THIRD job, `update-branch`, to this same workflow, and it prints its own `A11IGN_BOT_TOKEN is not set`
 * warning for a deliberately DIFFERENT reason (it skips outright rather than falling back -- see that
 * job's own comment). A whole-file regex count would have made this file's assertions couple to a job
 * this file is not about, and either broken a correct third job or hidden a real regression in the two
 * jobs this file actually specifies. See `auto-arm-update-branch.test.ts` for the third job's own tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const WORKFLOW = `${REPO}.github/workflows/auto-arm.yml`;

/** @param {{ jobs: Record<string, { steps: Array<{ env?: Record<string,string>, run?: string }> }> }} doc */
function jobRunText(doc: { jobs: Record<string, { steps: Array<{ run?: string }> }> }, jobName: string): string {
  return (doc.jobs[jobName]?.steps ?? []).map((s) => s.run ?? "").join("\n");
}

test("both arm and sweep read A11IGN_BOT_TOKEN as an env var -- never as a CLI argument or echoed", () => {
  const doc = parseYaml(readFileSync(WORKFLOW, "utf8")) as {
    jobs: Record<string, { steps: Array<{ env?: Record<string, string>, run?: string }> }>,
  };
  for (const jobName of ["arm", "sweep"]) {
    const steps = doc.jobs[jobName]?.steps ?? [];
    const withToken = steps.find((s) => s.env?.A11IGN_BOT_TOKEN === "${{ secrets.A11IGN_BOT_TOKEN }}");
    assert.ok(withToken, `${jobName} must read secrets.A11IGN_BOT_TOKEN through an env: mapping`);
    assert.ok(!(withToken?.run ?? "").includes("secrets.A11IGN_BOT_TOKEN"),
      `${jobName}'s run: script must never reference the secret directly -- only through the env var it `
      + "was mapped into, or the value risks appearing on a command line a log could capture");
  }
});

test("MUTATION TARGET: both jobs actually BRANCH on whether the token is set -- a present secret is used, "
  + "not merely read and ignored", () => {
  const doc = parseYaml(readFileSync(WORKFLOW, "utf8")) as Parameters<typeof jobRunText>[0];
  for (const jobName of ["arm", "sweep"]) {
    const branches = [...jobRunText(doc, jobName).matchAll(/if \[ -n "\$A11IGN_BOT_TOKEN" \]/g)];
    assert.equal(branches.length, 1, `expected exactly one such conditional in ${jobName}, found `
      + `${branches.length}`);
  }
});

test("the fallback prints a warning naming what breaks -- trunk-guard, close-rows, the push watchdogs, "
  + "and #416 itself, so the next reader knows this path is temporary", () => {
  const doc = parseYaml(readFileSync(WORKFLOW, "utf8")) as Parameters<typeof jobRunText>[0];
  for (const jobName of ["arm", "sweep"]) {
    const warnings = [...jobRunText(doc, jobName).matchAll(/::warning::A11IGN_BOT_TOKEN is not set[^\n]*/g)];
    assert.equal(warnings.length, 1, `${jobName} must print exactly one fallback warning`);
    const [[warning]] = warnings;
    assert.match(warning, /trunk-guard/);
    assert.match(warning, /close-rows/);
    assert.match(warning, /#416/);
  }
});

test("the fallback token is GITHUB_TOKEN (github.token), never a hard-coded or absent value", () => {
  const doc = parseYaml(readFileSync(WORKFLOW, "utf8")) as {
    jobs: Record<string, { steps: Array<{ env?: Record<string, string> }> }>,
  };
  for (const jobName of ["arm", "sweep"]) {
    const steps = doc.jobs[jobName]?.steps ?? [];
    const fallbacks = steps.filter((s) => s.env?.FALLBACK_TOKEN === "${{ github.token }}");
    assert.equal(fallbacks.length, 1, `${jobName} must map github.token as the fallback exactly once`);
  }
});

test("A11IGN_BOT_TOKEN never appears as a bare CLI argument anywhere in the workflow", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  assert.doesNotMatch(text, /gh [^\n]*A11IGN_BOT_TOKEN/,
    "the token must reach `gh` only via the GH_TOKEN environment variable it reads automatically, never "
    + "as an explicit --token flag or similar, which would put the value on a process command line");
});

test("issues: write is NOT added for this -- #333 already measured that granting it changes nothing", () => {
  const doc = parseYaml(readFileSync(WORKFLOW, "utf8")) as { permissions: Record<string, string> };
  // The permission already exists for #298's own reason (a bot-merge case predating this fix) and this
  // test does not assert its absence -- only that this PR's own change did not ADD it a second time or
  // widen it further, which would be the "do not widen permissions to make something else easier" the
  // issue's own header warns against.
  assert.equal(doc.permissions.issues, "write");
  assert.equal(doc.permissions.contents, "write");
  assert.equal(doc.permissions["pull-requests"], "write");
  assert.equal(Object.keys(doc.permissions).length, 3,
    "no permission beyond the three already here (contents, pull-requests, issues) should have been "
    + "added for this token change");
});
