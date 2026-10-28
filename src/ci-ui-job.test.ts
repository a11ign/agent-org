// no-token: gh -- reads .github/workflows/ci.yml, package.json, eslint.config.ts and ui/package.json; no network, no `gh`
// Ticket A11-188: the UI is a package of its own under `ui/` (Astro with React islands, built to static files), checked by a `ui` job of `ci.yml` that `gate` waits for. This file checks the
// job's shape, the root scripts that call the package, and that `ui/` is a standalone package and not a workspace member (the layout check, which the `typecheck` job runs, refuses a workspace file).
//
// EACH CHECK IS A FUNCTION OVER THE PARSED FILES, returning what is wrong, and is also run on a copy with exactly the thing it checks broken, as `ci-lint-job.test.ts` does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { LINT_TARGETS } from "../scripts/lint-cache.ts";

interface Step { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown> }
interface Job { if?: string; needs?: string[] | string; env?: Record<string, string>; steps?: Step[] }
interface Workflow { jobs: Record<string, Job> }
interface Pins { scripts?: Record<string, string>; files?: string[] }

const REPO = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(`${REPO}${path}`, "utf8");
/** The pnpm `release.yml` pins: the `ui` job uses the same one as `lint`. */
const PNPM_RELEASE = /pnpm-version: (\S+)/.exec(read(".github/workflows/release.yml"))?.[1] ?? "";

/** What the `ui` job runs, in order: the install, then Chromium, then the three checks. */
const ORDER = [
  /^pnpm --dir ui install --frozen-lockfile\b.*--ignore-scripts\b/m,
  /^pnpm --dir ui exec playwright-core install --with-deps chromium$/m,
  /^pnpm ui:typecheck$/m,
  /^pnpm ui:build$/m,
  /^pnpm ui:test$/m,
];

const runsOf = (job: Job): string[] => (job.steps ?? []).map((step) => step.run ?? "");

/** The one condition the `ui` job may carry: it skips a draft pull request, which `ready_for_review` re-runs in full. */
const DRAFT_SKIP = "github.event_name != 'pull_request' || !github.event.pull_request.draft";

/** The `ui` job exists, runs on every event except a draft pull request (its only `if:` is DRAFT_SKIP; A11-363 review), pins the release's pnpm, and runs each step of ORDER in that order. */
function uiJobProblems(ci: Workflow): string[] {
  const job = ci.jobs.ui;
  if (!job) return ["ci.yml has no `ui` job"];
  const problems: string[] = [];
  if (job.if !== undefined && job.if !== DRAFT_SKIP) problems.push(`the ui job has an \`if:\` (${job.if}), so it does not run on every event`);
  if (job.env?.PNPM_VERSION !== PNPM_RELEASE) problems.push(`the ui job's pnpm is not the ${PNPM_RELEASE} that release.yml pins`);
  const runs = runsOf(job);
  let from = 0;
  for (const wanted of ORDER) {
    const at = runs.findIndex((run, index) => index >= from && wanted.test(run));
    if (at < 0) problems.push(`the ui job has no step matching ${wanted} after step ${from}`);
    else from = at + 1;
  }
  return problems;
}

/** `gate` needs the `ui` job and reads its result. */
function gateProblems(ci: Workflow): string[] {
  const needs = ci.jobs.gate?.needs;
  const script = (ci.jobs.gate?.steps ?? []).map((step) => step.run ?? "").join("\n");
  return [
    ...(Array.isArray(needs) && needs.includes("ui") ? [] : ["gate does not need the `ui` job"]),
    ...(script.includes("${{ needs.ui.result }}") ? [] : ["gate's script does not read the ui job's result"]),
  ];
}

/** The root scripts the ticket names call the package, and the lint script covers it. */
function scriptProblems(pins: Pins): string[] {
  const wanted = { "ui:dev": "pnpm --dir ui dev", "ui:build": "pnpm --dir ui build", "ui:test": "pnpm --dir ui test", "ui:typecheck": "pnpm --dir ui typecheck" };
  const problems = Object.entries(wanted).flatMap(([name, command]) => (pins.scripts?.[name] === command ? [] : [`the ${name} script is ${JSON.stringify(pins.scripts?.[name])}, not \`${command}\``]));
  if (pins.scripts?.lint !== "node scripts/lint.ts" || !LINT_TARGETS.includes("ui")) problems.push("the lint script does not lint ui/");
  return problems;
}

/** `ui/` is a private package of its own: the layout check refuses a workspace file, and the tool's `files` do not ship `ui/` (A11-191 ships its build). */
function standaloneProblems(pins: Pins, ui: { private?: boolean }, hasWorkspaceFile: boolean): string[] {
  return [
    ...(hasWorkspaceFile ? ["the repository has a pnpm-workspace.yaml, which the layout check refuses"] : []),
    ...(ui.private === true ? [] : ["ui/package.json is not private"]),
    ...((pins.files ?? []).some((entry) => entry === "ui" || entry.startsWith("ui/")) ? ["package.json's `files` ships ui/"] : []),
  ];
}

const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
const pins = JSON.parse(read("package.json")) as Pins;
const uiPackage = JSON.parse(read("ui/package.json")) as { private?: boolean };
const clone = <T>(value: T): T => structuredClone(value);

test("the real files pass every UI check: the ui job, gate, the root scripts and the standalone package", () => {
  assert.deepEqual(uiJobProblems(ci), []);
  assert.deepEqual(gateProblems(ci), []);
  assert.deepEqual(scriptProblems(pins), []);
  assert.deepEqual(standaloneProblems(pins, uiPackage, existsSync(`${REPO}pnpm-workspace.yaml`)), []);
});

test("the ui job check sees each thing it checks, broken on a copy", () => {
  const noJob = clone(ci);
  delete noJob.jobs.ui;
  assert.notDeepEqual(uiJobProblems(noJob), []);

  const conditional = clone(ci);
  conditional.jobs.ui.if = "github.event_name == 'pull_request'";
  assert.match(uiJobProblems(conditional).join("\n"), /`if:`/);

  const otherPnpm = clone(ci);
  otherPnpm.jobs.ui.env = { PNPM_VERSION: "10.0.0" };
  assert.match(uiJobProblems(otherPnpm).join("\n"), /pnpm/);

  for (const wanted of ORDER) {
    const without = clone(ci);
    without.jobs.ui.steps = without.jobs.ui.steps?.filter((step) => !wanted.test(step.run ?? ""));
    assert.match(uiJobProblems(without).join("\n"), /no step matching/, String(wanted));
  }

  const reordered = clone(ci);
  reordered.jobs.ui.steps = [...(reordered.jobs.ui.steps ?? [])].reverse();
  assert.notDeepEqual(uiJobProblems(reordered), []);
});

test("the gate check sees a gate that does not need ui, and one that does not read its result, on a copy", () => {
  const notNeeded = clone(ci);
  notNeeded.jobs.gate.needs = ["suite", "typecheck", "lint", "changeset", "release-dry-run"];
  assert.match(gateProblems(notNeeded).join("\n"), /does not need/);

  const notRead = clone(ci);
  notRead.jobs.gate.steps = notRead.jobs.gate.steps?.map((step) => ({ ...step, run: step.run?.replace("${{ needs.ui.result }}", "success") }));
  assert.match(gateProblems(notRead).join("\n"), /does not read/);
});

test("the script check sees a root script that calls something else, and a lint that skips ui, on a copy", () => {
  const wrong = clone(pins);
  wrong.scripts = { ...wrong.scripts, "ui:build": "astro build" };
  assert.match(scriptProblems(wrong).join("\n"), /ui:build/);

  const missing = clone(pins);
  delete missing.scripts?.["ui:dev"];
  assert.match(scriptProblems(missing).join("\n"), /ui:dev/);

  const skipsUi = clone(pins);
  skipsUi.scripts = { ...skipsUi.scripts, lint: "eslint src scripts plugins" };
  assert.match(scriptProblems(skipsUi).join("\n"), /lint/);
});

test("the standalone check sees a workspace file, a public package and a shipped ui/, on a copy", () => {
  assert.match(standaloneProblems(pins, uiPackage, true).join("\n"), /pnpm-workspace/);
  assert.match(standaloneProblems(pins, { private: false }, false).join("\n"), /not private/);
  assert.match(standaloneProblems({ ...pins, files: [...(pins.files ?? []), "ui"] }, uiPackage, false).join("\n"), /ships ui/);
});

test("eslint.config.ts reaches .tsx and .astro files and leaves the UI's build out", () => {
  const config = read("eslint.config.ts");
  assert.match(config, /"\*\*\/\*\.tsx"/);
  assert.match(config, /"\*\*\/\*\.astro"/);
  assert.match(config, /"ui\/dist\/\*\*"/);
  assert.match(config, /"ui\/\.astro\/\*\*"/);
});
