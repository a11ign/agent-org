// no-token: gh -- nothing here calls `gh`; the project's script is a fixture that writes a file, and every other read is injected
//
// agent-org#1582: THE OUTSIDE HOME OF THE REPORTS, shipped OFF. Every claim has its negative control: the run that does something beside the run that does nothing (off, undeclared,
// a host report on a runner), and the second actor beside the first IN BOTH ORDERS. THE FIXTURE SCRIPT STANDS FOR THE PROJECT'S: it keeps the contract each real report documents
// (post once per period, say "already posted" the second time), so the pair test proves the home adds no write of its own and passes the script's answer through; it does not prove
// the project's script keeps that contract, which is the project's own test. Mutations are in the PR's `.acceptance/` file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parse } from "yaml";
import { COMMANDS } from "./commands.ts";
import { OUTSIDE_REPORTS_SWITCH, REPORTS, declaredReport, exitCodeOf, liveDeps, outsideReport, outsideReportsOn, scriptPathUsable, type OutsideReportsDeps } from "./outside-reports.ts";

const ON = { [OUTSIDE_REPORTS_SWITCH]: true };
const declaration = (reports: unknown): string => JSON.stringify({ units: { reports } });
const DECLARED = declaration({ "ci-health": { script: "scripts/ci-health.ts", args: ["--post"] }, "token-cost": { script: "scripts/token-cost.ts", args: ["--post"] } });

function rig(over: Partial<OutsideReportsDeps> = {}) {
  const ran: { script: string; args: string[]; extra: string[] }[] = [];
  const said: string[] = [];
  const deps: OutsideReportsDeps = {
    switches: ON, onRunner: false, say: (line) => said.push(line),
    declaration: () => DECLARED,
    scriptExists: () => true,
    run: (declared, extra) => { ran.push({ script: declared.script, args: declared.args, extra }); return { code: 0, line: "exit 0" }; },
    ...over,
  };
  return { deps, ran, said };
}

test("1. OFF IS ABSENT: absent, false and a non-boolean all do nothing at all -- no declaration read, no script, no line", () => {
  for (const switches of [{}, { [OUTSIDE_REPORTS_SWITCH]: false }, { [OUTSIDE_REPORTS_SWITCH]: "true" as unknown as boolean }, { "outside.trunk": true }]) {
    const tripwire = (what: string) => () => { throw new Error(`${what} was reached with the flag off`); };
    const result = outsideReport("ci-health", [], { switches, onRunner: true, say: tripwire("say"), declaration: tripwire("declaration"), scriptExists: tripwire("scriptExists"), run: tripwire("run") });
    assert.deepEqual(result, { ran: false, why: "off" });
    assert.equal(outsideReportsOn(switches), false);
    assert.equal(exitCodeOf(result), 0, "off is not a fault");
  }
  assert.equal(outsideReportsOn(ON), true, "CONTROL: the same reader says on for the boolean true");
});

test("2. ON runs the declared script with its declared arguments, then the caller's, and says how it ended", () => {
  const { deps, ran, said } = rig();
  const result = outsideReport("token-cost", ["--week=2026-10-05"], deps);
  assert.deepEqual(ran, [{ script: "scripts/token-cost.ts", args: ["--post"], extra: ["--week=2026-10-05"] }]);
  assert.deepEqual(result, { ran: true, code: 0, line: "exit 0" });
  assert.deepEqual(said, ["outside-reports: token-cost: exit 0"]);
});

test("3. a report the project does not declare is not run: undeclared is quiet, a malformed or climbing declaration is a fault", () => {
  const undeclared = rig();
  const result = outsideReport("weekly-review", [], undeclared.deps);
  assert.equal(result.ran === false && result.why, "undeclared");
  assert.equal(exitCodeOf(result), 0);
  assert.equal(undeclared.ran.length, 0);
  for (const text of ["not json", declaration({ "ci-health": { script: "../elsewhere.ts" } }), declaration({ "ci-health": { script: "/etc/x.ts" } }), declaration({ "ci-health": { script: "--eval" } }), declaration({ "ci-health": { script: "a.ts", args: [1] } })]) {
    const bad = rig({ declaration: () => text });
    const refused = outsideReport("ci-health", [], bad.deps);
    assert.equal(refused.ran === false && refused.why, "declaration-unusable", text);
    assert.equal(exitCodeOf(refused), 2);
    assert.equal(bad.ran.length, 0);
  }
  assert.equal(outsideReport("ci-health", [], rig({ declaration: () => null }).deps).ran, false, "an unreadable declaration runs nothing");
  assert.equal(scriptPathUsable("scripts/ci-health.ts"), true, "CONTROL: an ordinary relative path is usable");
  assert.equal(outsideReport("ci-health", [], rig({ scriptExists: () => false }).deps).ran, false, "a declared script that is not in the checkout runs nothing");
});

test("4. a name outside the closed set is refused, and a HOST report is refused on a runner (it would post zero calls) but runs on the host", () => {
  const unknown = outsideReport("deploy", [], rig().deps);
  assert.equal(unknown.ran === false && unknown.why, "unknown-report");
  assert.equal(exitCodeOf(unknown), 2);
  for (const name of Object.keys(REPORTS).filter((n) => REPORTS[n].where === "host")) {
    const onRunner = rig({ onRunner: true, declaration: () => declaration({ [name]: { script: "scripts/x.ts" } }) });
    const refused = outsideReport(name, [], onRunner.deps);
    assert.equal(refused.ran === false && refused.why, "wrong-place", name);
    assert.equal(onRunner.ran.length, 0);
    const onHost = rig({ onRunner: false, declaration: () => declaration({ [name]: { script: "scripts/x.ts" } }) });
    assert.equal(outsideReport(name, [], onHost.deps).ran, true, `CONTROL: ${name} runs off a runner`);
  }
  const runnerReport = rig({ onRunner: true });
  assert.equal(outsideReport("ci-health", [], runnerReport.deps).ran, true, "CONTROL: a runner report runs on a runner");
  assert.deepEqual(Object.keys(REPORTS).sort(), ["ci-health", "outsider-verdict", "token-cost", "weekly-review"]);
});

test("5. the exit is the script's: a verdict of 1 and a could-not-ask of 2 pass through, and a timeout (no code) is 2", () => {
  for (const [code, want] of [[0, 0], [1, 1], [2, 2], [null, 2]] as const) {
    const result = outsideReport("ci-health", [], rig({ run: () => ({ code, line: `exit ${code}` }) }).deps);
    assert.equal(exitCodeOf(result), want, `script exit ${code}`);
  }
});

const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A project checkout whose report script keeps the real reports' contract: one post per period, the second finds it and says so. */
function fixtureProject() {
  const dir = mkdtempSync(join(tmpdir(), "outside-reports-"));
  made.push(dir);
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts/report.mjs"), [
    'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
    'const week = process.argv.find((a) => a.startsWith("--week="))?.slice(7) ?? "2026-10-05";',
    'const posted = existsSync("posted.txt") ? readFileSync("posted.txt", "utf8") : "";',
    'if (posted.split("\\n").includes(week)) { console.log(`already posted for ${week}: posting nothing`); process.exit(0); }',
    'appendFileSync("posted.txt", week + "\\n"); console.log(`posted for ${week}`);',
  ].join("\n"));
  const run = (declared: { script: string; args: string[] }, extra: string[]) => {
    const child = spawnSync(process.execPath, [join(dir, declared.script), ...declared.args, ...extra], { cwd: dir, encoding: "utf8" });
    return { code: child.status, line: `exit ${child.status} -- ${child.stdout.trim()}` };
  };
  const posts = () => (existsSync(join(dir, "posted.txt")) ? readFileSync(join(dir, "posted.txt"), "utf8").split("\n").filter(Boolean) : []);
  return { dir, run, posts, deps: (): OutsideReportsDeps => rig({ declaration: () => declaration({ "ci-health": { script: "scripts/report.mjs", args: [] } }), run }).deps };
}

test("6. THE SECOND ACTOR DOES NOTHING, IN BOTH ORDERS: the home after the project's job posts nothing, and the project's job after the home posts nothing", () => {
  const homeSecond = fixtureProject();
  homeSecond.run({ script: "scripts/report.mjs", args: [] }, []); // the project's own job
  const second = outsideReport("ci-health", [], homeSecond.deps());
  assert.equal(second.ran && second.line.includes("already posted"), true, "the home reports the script's own answer");
  assert.deepEqual(homeSecond.posts(), ["2026-10-05"], "one post, not two");

  const homeFirst = fixtureProject();
  const first = outsideReport("ci-health", [], homeFirst.deps());
  assert.equal(first.ran && first.line.includes("posted for 2026-10-05"), true);
  const jobSecond = homeFirst.run({ script: "scripts/report.mjs", args: [] }, []);
  assert.match(jobSecond.line, /already posted/);
  assert.deepEqual(homeFirst.posts(), ["2026-10-05"], "one post, not two");

  const nextWeek = outsideReport("ci-health", ["--week=2026-10-12"], homeFirst.deps());
  assert.equal(nextWeek.ran && nextWeek.line.includes("posted for 2026-10-12"), true, "CONTROL: a new period is not mistaken for done");
  assert.deepEqual(homeFirst.posts(), ["2026-10-05", "2026-10-12"]);
});

test("7. the command is registered, its script exists, and declaredReport reads exactly what units.reports holds", () => {
  assert.equal(COMMANDS["outside-reports"], "outside-reports.ts");
  assert.ok(existsSync(new URL("./outside-reports.ts", import.meta.url)));
  assert.deepEqual(declaredReport(DECLARED, "ci-health"), { script: "scripts/ci-health.ts", args: ["--post"] });
  assert.equal(declaredReport(DECLARED, "weekly-review"), "undeclared");
  assert.equal(declaredReport(JSON.stringify({ units: {} }), "ci-health"), "undeclared", "no reports block at all is undeclared, not a fault");
});

test("8. THE LIVE READ: the flag comes from the project's own .agent-org/decisions.json, and the declaration and script from the same checkout -- true runs, false and absent do nothing", () => {
  // Nothing is injected but the checkout: the switch file, the declaration and the child are the real reads.
  const project = (decisions: string | null) => {
    const { dir } = fixtureProject();
    mkdirSync(join(dir, ".agent-org"));
    writeFileSync(join(dir, ".agent-org/project.json"), declaration({ "ci-health": { script: "scripts/report.mjs", args: [] } }));
    if (decisions !== null) writeFileSync(join(dir, ".agent-org/decisions.json"), decisions);
    return dir;
  };
  const posts = (dir: string) => (existsSync(join(dir, "posted.txt")) ? readFileSync(join(dir, "posted.txt"), "utf8").split("\n").filter(Boolean) : []);
  const quietly = { say: () => {} };
  const on = project(JSON.stringify({ [OUTSIDE_REPORTS_SWITCH]: true }));
  const result = outsideReport("ci-health", [], { ...liveDeps(quietly.say, on), say: quietly.say });
  assert.equal(result.ran && result.code, 0, "the flag is read from the checkout's decisions.json, so the script runs");
  assert.deepEqual(posts(on), ["2026-10-05"]);
  for (const [what, decisions] of [["false", JSON.stringify({ [OUTSIDE_REPORTS_SWITCH]: false })], ["absent key", JSON.stringify({ "routing.haikuDefault": true })], ["no file", null], ["unreadable", "not json"]] as const) {
    const off = project(decisions);
    const refused = outsideReport("ci-health", [], liveDeps(quietly.say, off));
    assert.deepEqual(refused, { ran: false, why: "off" }, what);
    assert.deepEqual(posts(off), [], `${what}: the script did not run`);
  }
});

type Step = { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
const workflow = parse(readFileSync(new URL("../.github/workflows/org-reports.yml", import.meta.url), "utf8"));
const steps: Step[] = workflow.jobs.report.steps;
const TOKEN = "secrets.OUTSIDE_REPORTS_TOKEN";

test("9. the workflow is shipped off twice, names no project, and runs on schedule and dispatch only", () => {
  assert.equal(workflow.jobs.report.if, "${{ vars.OUTSIDE_REPORTS_PROJECT != '' }}");
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"], "nothing a change can trip");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(steps.some((step) => step.uses?.startsWith("actions/checkout") && step.with?.repository === "${{ vars.OUTSIDE_REPORTS_PROJECT }}"), "the project is the variable");
  assert.doesNotMatch(JSON.stringify(workflow), /a11ign/i, "no project is named in the workflow (the header comments name the epic's issue; the parsed workflow has no comments)");
  const options: string[] = workflow.on.workflow_dispatch.inputs.report.options;
  assert.deepEqual(options, Object.keys(REPORTS).filter((name) => REPORTS[name].where === "runner"), "a dispatch offers the runner reports only, none of the host ones");
});

test("10. THE TOKEN IS NOT LEFT WHERE THE PROJECT'S INSTALL CAN READ IT: no checkout persists credentials, and the token reaches the report step alone", () => {
  const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout"));
  assert.equal(checkouts.length, 2);
  for (const step of checkouts) assert.equal(step.with?.["persist-credentials"], false, `${JSON.stringify(step.with)} must not persist its credential into .git/config`);
  const last = steps.length - 1;
  steps.forEach((step, index) => {
    const mentionsToken = JSON.stringify(step).includes(TOKEN);
    if (step.uses?.startsWith("actions/checkout") && step.with?.repository !== undefined) assert.equal(mentionsToken, true, "CONTROL: the project checkout is where the token is spent");
    else assert.equal(mentionsToken, index === last, `step ${index} (${step.uses ?? step.run?.split("\n")[0]}): the token is in the report step and nowhere else`);
  });
  const install = steps.findIndex((step) => step.run?.includes("pnpm install"));
  assert.ok(install > 0 && install < last, "CONTROL: the project's install runs before the report step, which is why a persisted credential would be readable");
});

test("11. the report step picks the report from the trigger: the daily cron is the verdict, any other schedule is CI health, and a dispatch names its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "org-reports-step-"));
  made.push(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "project"));
  writeFileSync(join(dir, "bin/node"), '#!/bin/sh\necho "node $*"\n');
  chmodSync(join(dir, "bin/node"), 0o755);
  const run = steps[steps.length - 1].run ?? "";
  const crons: string[] = workflow.on.schedule.map((entry: { cron: string }) => entry.cron);
  const daily = crons.filter((cron) => /^\d+ \d+ \* \* \*$/.test(cron));
  assert.equal(daily.length, 1, "exactly one daily cron, and it is the verdict's");
  const chosen = (schedule: string, dispatched: string) =>
    spawnSync("bash", ["-e", "-c", run], { cwd: join(dir, "project"), encoding: "utf8", env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, SCHEDULE: schedule, DISPATCHED: dispatched } }).stdout.trim();
  assert.equal(chosen(daily[0], ""), 'node ../tool/src/bin.ts outside-reports outsider-verdict');
  for (const cron of crons.filter((cron) => cron !== daily[0])) assert.equal(chosen(cron, ""), "node ../tool/src/bin.ts outside-reports ci-health", cron);
  assert.equal(chosen("", "ci-health"), "node ../tool/src/bin.ts outside-reports ci-health", "a dispatch of ci-health");
  assert.equal(chosen("", "outsider-verdict"), "node ../tool/src/bin.ts outside-reports outsider-verdict", "a dispatch of the verdict");
  assert.equal(chosen(daily[0], "ci-health"), "node ../tool/src/bin.ts outside-reports ci-health", "a dispatch wins over the schedule it was run beside");
});
