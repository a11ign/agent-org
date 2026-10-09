// no-token: gh -- reads .github/workflows/ci.yml and runs `gate`'s own script under bash; no network, no `gh`
// a11ign/a11ign#4139: `main` went red on every push because the shared `changeset-required` check has no answer for a push (it reads the pull request
// number from `github.event.pull_request`, empty on a push, and the API answers 404). A push to `main` has no pull request to decide, so `changeset` does
// not run there and `gate` accepts its `skipped` on a push and ONLY on a push.
//
// THE TEST RUNS `gate`'S SCRIPT, it does not grep it: the `run:` text is taken from `ci.yml`, its `${{ }}` expressions are filled from the case (the
// result of each needed job and the event name), and bash decides. A grep for "push" would pass a script that accepts `skipped` on every event.
//
// POSITIVE CONTROLS (the vacuity failure from both sides): the rejecting cases have an accepting twin (`success` everywhere passes on every event, and a
// skipped `changeset` passes on a push), so a `gate` that rejects everything turns the twin RED, and one that accepts everything turns the rejections RED.
// The mutations, both directions, are pasted in the pull request.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const CI_YML = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "ci.yml");
const ci = parse(readFileSync(CI_YML, "utf8"));
const EVENTS = ["push", "pull_request", "merge_group"];
const RESULTS = ["success", "failure", "skipped", "cancelled"];

/** The one condition form `ci.yml` uses on `changeset`; anything else throws, so an unreadable condition is never read as true. */
function conditionHolds(condition: any, event: any) {
  const [, operator, literal] = /^github\.event_name (==|!=) '([a-z_]+)'$/.exec(String(condition).trim()) ?? [];
  if (!operator) throw new Error(`cannot evaluate the condition ${JSON.stringify(condition)}: only \`github.event_name ==|!= '<event>'\` is understood`);
  return operator === "==" ? event === literal : event !== literal;
}

/** Whether the `changeset` job runs on `event`. No `if:` is a job that always runs. */
const changesetRuns = (event: any) => ci.jobs.changeset.if === undefined || conditionHolds(ci.jobs.changeset.if, event);

/** @param {string} text @param {Record<string, string>} values */
function fill(text: string, values: Record<string, string>) {
  return String(text).replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`gate uses \${{ ${name} }}, which this test does not fill`);
    return values[name];
  });
}

/** Run `gate`'s script on `event` with the given results; `ok` is whether `gate` would be green. */
function gate(event: any, results: any) {
  const step = ci.jobs.gate.steps.find((candidate: any) => candidate.run);
  const values = { "github.event_name": event };
  for (const [job, result] of Object.entries(results)) values[`needs.${job}.result`] = result;
  const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, fill((value as any), values)]));
  const ran = spawnSync("bash", ["-eo", "pipefail", "-c", fill(step.run, values)], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  return { ok: ran.status === 0, output: ran.stdout + ran.stderr };
}

const allSuccess = { suite: "success", typecheck: "success", changeset: "success" };

test("a push to main does not evaluate the changeset check: the changeset job's condition is false on push and true on the other two events", () => {
  assert.equal(changesetRuns("push"), false);
  assert.equal(changesetRuns("pull_request"), true);
  assert.equal(changesetRuns("merge_group"), true);
});

test("gate needs the changeset job, so a skip on push is read by gate and not lost", () => {
  assert.deepEqual([...ci.jobs.gate.needs].sort(), ["changeset", "suite", "typecheck"]);
});

test("gate accepts a skipped changeset on a push, and ONLY on a push", () => {
  assert.equal(gate("push", { ...allSuccess, changeset: "skipped" }).ok, true);
  for (const event of ["pull_request", "merge_group"]) {
    const reading = gate(event, { ...allSuccess, changeset: "skipped" });
    assert.equal(reading.ok, false, `a skipped changeset on ${event} must fail gate`);
    assert.match(reading.output, /skipped/);
  }
});

test("gate is green when every job succeeded, on every event (the accepting twin of the rejections)", () => {
  for (const event of EVENTS) assert.equal(gate(event, allSuccess).ok, true, event);
});

test("gate rejects a failed or cancelled changeset on every event, push included", () => {
  for (const event of EVENTS) {
    for (const result of ["failure", "cancelled"]) assert.equal(gate(event, { ...allSuccess, changeset: result }).ok, false, `${event} / changeset ${result}`);
  }
});

test("gate rejects a skipped, failed or cancelled suite and typecheck on every event, push included", () => {
  for (const event of EVENTS) {
    for (const job of ["suite", "typecheck"]) {
      for (const result of RESULTS.filter((candidate) => candidate !== "success")) {
        assert.equal(gate(event, { ...allSuccess, [job]: result }).ok, false, `${event} / ${job} ${result}`);
      }
    }
  }
});

test("on a push, a failed suite still fails gate beside a skipped changeset (the skip excuses nothing else)", () => {
  assert.equal(gate("push", { suite: "failure", typecheck: "success", changeset: "skipped" }).ok, false);
  assert.equal(gate("push", { suite: "success", typecheck: "failure", changeset: "skipped" }).ok, false);
});

test("ci.yml still triggers on the three events this test covers", () => {
  assert.deepEqual(Object.keys(ci.on).sort(), [...EVENTS].sort());
});
