// no-token: gh -- reads .github/workflows/ci.yml, release.yml, package.json and pnpm-lock.yaml; no network, no `gh`
// Ticket A11-95: agent-org lints with `eslint` and the Clean Code plugin. The lint runs in its own `lint` job, installs from the lockfile so the ESLint tree is the one that was
// reviewed, and `gate` needs it and reads its result. `ci-changeset-on-push.test.ts` runs `gate`'s script on every result, `lint` included; this file checks the rest of the shape.
//
// EACH CHECK IS A FUNCTION OVER THE PARSED FILES, returning what is wrong. Each is also run on a copy with exactly the thing it checks broken (a check that passes on
// everything would pass the real files too), so a mutation that the check does not see turns the test red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

interface Step { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }
interface Job { if?: string; needs?: string[] | string; env?: Record<string, string>; steps?: Step[] }
interface Workflow { on: Record<string, unknown>; jobs: Record<string, Job> }
interface Pins { scripts?: Record<string, string>; devDependencies?: Record<string, string> }
interface Lock { importers: Record<string, { devDependencies?: Record<string, { specifier: string; version: string }> }> }

const REPO = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(`${REPO}${path}`, "utf8");

/**
 * The packages whose version the lint job must install exactly as reviewed. The test names them and never their versions: a Dependabot bump moves the manifest and the lockfile
 * together and passes; a hand edit of one side, a range, or a missing entry does not.
 */
const LINT_TOOLS = ["eslint", "typescript-eslint", "@george2f/eslint-plugin-clean-code"] as const;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
/** What a failure of the pin or lockfile check says the invariant is, and how a lint tool's version moves. */
const LINT_PIN_INVARIANT = `the lint job installs a reviewed ESLint tree from the lockfile. So each of ${LINT_TOOLS.join(", ")} is in devDependencies with an exact version (no range), `
  + "and pnpm-lock.yaml's root importer has that same specifier and resolves exactly that version. The version itself is free to move: it moves in a Dependabot pull request, "
  + "or by hand in package.json and pnpm-lock.yaml together.";
/** The pnpm `release.yml` pins: the lint job uses the same one, so a lockfile means one thing in both places. */
const PNPM_RELEASE = /pnpm-version: (\S+)/.exec(read(".github/workflows/release.yml"))?.[1] ?? "";

/** The `lint` job's steps. `runs` is the whole run text of every step, so a check reads a step's command wherever it sits. */
const lintJobOf = (ci: Workflow): Job => ci.jobs.lint ?? {};
const runsOf = (job: Job): string[] => (job.steps ?? []).map((step) => step.run ?? "");

/** The `lint` job exists, runs on every event `ci.yml` triggers on (no `if:`), installs from the frozen lockfile with no lifecycle scripts, and runs `npm run lint`. */
function lintJobProblems(ci: Workflow): string[] {
  if (!ci.jobs.lint) return ["ci.yml has no `lint` job"];
  const job = lintJobOf(ci);
  const problems: string[] = [];
  if (job.if !== undefined) problems.push(`the lint job has an \`if:\` (${job.if}), so it does not run on every event`);
  const runs = runsOf(job);
  if (!runs.some((run) => /^pnpm install --frozen-lockfile\b/m.test(run) && /--ignore-scripts\b/.test(run))) {
    problems.push("the lint job does not install with `pnpm install --frozen-lockfile --ignore-scripts`, so the ESLint tree is not the reviewed one");
  }
  if (!runs.some((run) => /^npm run lint$/m.test(run))) problems.push("the lint job does not run `npm run lint`");
  if (job.env?.PNPM_VERSION !== PNPM_RELEASE) problems.push(`the lint job's pnpm is not the ${PNPM_RELEASE} that release.yml pins`);
  return problems;
}

/** `gate` needs the `lint` job, and its script reads that job's result, the same way it reads the others. */
function gateProblems(ci: Workflow): string[] {
  const problems: string[] = [];
  const needs = ci.jobs.gate?.needs;
  if (!Array.isArray(needs) || !needs.includes("lint")) problems.push("gate does not need the `lint` job");
  const script = (ci.jobs.gate?.steps ?? []).map((step) => step.run ?? "").join("\n");
  if (!script.includes("${{ needs.lint.result }}")) problems.push("gate's script does not read the lint job's result");
  return problems;
}

/** The lint script: the scope `eslint.config.ts` covers, with `plugins/` (A11-158), which holds no `.ts` file until the first bundled agent-org plugin lands, so an unmatched pattern is no error, and `ui/` (A11-188), the UI package's `.ts`, `.tsx` and `.astro`. */
const LINT_SCRIPT = "eslint --no-error-on-unmatched-pattern src scripts plugins ui";

/** Each lint tool is in `devDependencies` with an EXACT specifier (no `^`, no `~`), and the lint script runs the scope `eslint.config.ts` covers. */
function pinProblems(pins: Pins): string[] {
  const problems: string[] = [];
  for (const name of LINT_TOOLS) {
    const range = pins.devDependencies?.[name];
    if (range === undefined) problems.push(`${name} is not in devDependencies`);
    else if (!EXACT_VERSION.test(range)) problems.push(`${name} is ${range} in devDependencies, a range and not an exact version`);
  }
  if (pins.scripts?.lint !== LINT_SCRIPT) problems.push(`the lint script is ${JSON.stringify(pins.scripts?.lint)}, not \`${LINT_SCRIPT}\``);
  return problems;
}

/** The lockfile agrees with the manifest on each lint tool: the same specifier, resolved to exactly that version. The install the lint job makes is the one that was reviewed. */
function lockProblems(lock: Lock, pins: Pins): string[] {
  const devDependencies = lock.importers?.["."]?.devDependencies ?? {};
  return LINT_TOOLS.flatMap((name) => {
    const declared = pins.devDependencies?.[name];
    if (declared === undefined) return []; // pinProblems names a tool missing from the manifest
    const entry = devDependencies[name];
    if (!entry) return [`pnpm-lock.yaml does not list ${name}`];
    // pnpm writes the peer suffix into `version` (`8.71.2(eslint@10.13.0)(typescript@6.0.3)`), so only the part before the first `(` is the version.
    const resolved = entry.version.split("(")[0];
    if (entry.specifier !== declared) return [`pnpm-lock.yaml has ${name} at specifier ${entry.specifier}, but package.json declares ${declared}`];
    return resolved === declared ? [] : [`pnpm-lock.yaml resolves ${name} to ${entry.version}, not the declared ${declared}`];
  });
}

const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
const pins = JSON.parse(read("package.json")) as Pins;
const lock = parse(read("pnpm-lock.yaml")) as Lock;
const clone = <T>(value: T): T => structuredClone(value);
/** A copy of the workflow whose `job` steps have `from` replaced by `to` in each `run`. */
const editedRun = (job: "lint" | "gate", from: string | RegExp, to: string): Workflow => {
  const edited = clone(ci);
  edited.jobs[job].steps = edited.jobs[job].steps?.map((step) => ({ ...step, run: step.run?.replace(from, to) }));
  return edited;
};

test("the real files pass every lint check: the lint job, gate, the pins and the lockfile", () => {
  assert.deepEqual(lintJobProblems(ci), []);
  assert.deepEqual(gateProblems(ci), []);
  assert.deepEqual(pinProblems(pins), [], LINT_PIN_INVARIANT);
  assert.deepEqual(lockProblems(lock, pins), [], LINT_PIN_INVARIANT);
});

test("the lint job check sees each thing it checks, broken on a copy", () => {
  const noJob = clone(ci);
  delete noJob.jobs.lint;
  assert.notDeepEqual(lintJobProblems(noJob), []);

  const conditional = clone(ci);
  conditional.jobs.lint.if = "github.event_name == 'pull_request'";
  assert.match(lintJobProblems(conditional).join("\n"), /`if:`/);

  const floating = editedRun("lint", "--frozen-lockfile", "");
  assert.match(lintJobProblems(floating).join("\n"), /frozen-lockfile/);

  const noScripts = editedRun("lint", " --ignore-scripts", "");
  assert.match(lintJobProblems(noScripts).join("\n"), /frozen-lockfile --ignore-scripts/);

  const noRun = editedRun("lint", /^npm run lint$/m, "echo skipped");
  assert.match(lintJobProblems(noRun).join("\n"), /npm run lint/);

  const otherPnpm = clone(ci);
  otherPnpm.jobs.lint.env = { PNPM_VERSION: "10.0.0" };
  assert.match(lintJobProblems(otherPnpm).join("\n"), /pnpm/);
});

test("the gate check sees a gate that does not need lint, and one that does not read its result, on a copy", () => {
  const notNeeded = clone(ci);
  notNeeded.jobs.gate.needs = ["suite", "typecheck", "changeset", "release-dry-run"];
  assert.match(gateProblems(notNeeded).join("\n"), /does not need/);

  const notRead = editedRun("gate", "${{ needs.lint.result }}", "success");
  assert.match(gateProblems(notRead).join("\n"), /does not read/);
});

/** `10.13.0` -> `10.13.1`: a version the real files do not hold, derived so the copies below stay wrong however far a Dependabot update has moved the real ones. */
const nextPatch = (version: string): string => {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
};

/** The manifest and lockfile as one Dependabot update leaves them: every lint tool moved one patch, on both sides. */
const bumpedTogether = (): { pins: Pins; lock: Lock } => {
  const bumpedPins = clone(pins);
  const bumpedLock = clone(lock);
  for (const name of LINT_TOOLS) {
    const next = nextPatch(pins.devDependencies?.[name] ?? "");
    bumpedPins.devDependencies = { ...bumpedPins.devDependencies, [name]: next };
    const entry = bumpedLock.importers["."].devDependencies?.[name];
    if (entry) Object.assign(entry, { specifier: next, version: entry.version.replace(/^[^(]+/, next) });
  }
  return { pins: bumpedPins, lock: bumpedLock };
};

test("a patch bump of every lint tool, in the manifest and the lockfile together, passes", () => {
  const bumped = bumpedTogether();
  assert.notDeepEqual(bumped.pins.devDependencies, pins.devDependencies);
  assert.deepEqual(pinProblems(bumped.pins), []);
  assert.deepEqual(lockProblems(bumped.lock, bumped.pins), []);
});

test("the pin check sees a range, a missing tool, and a lint script over another scope, on a copy", () => {
  const floating = clone(pins);
  floating.devDependencies = { ...floating.devDependencies, eslint: `^${pins.devDependencies?.eslint}` };
  assert.match(pinProblems(floating).join("\n"), /eslint is \^\d+\.\d+\.\d+ in devDependencies, a range/);

  const missing = clone(pins);
  delete missing.devDependencies?.["typescript-eslint"];
  assert.match(pinProblems(missing).join("\n"), /typescript-eslint is not in devDependencies/);

  const otherScope = clone(pins);
  otherScope.scripts = { ...otherScope.scripts, lint: "eslint src" };
  assert.match(pinProblems(otherScope).join("\n"), /lint script/);
});

test("the lockfile check sees a manifest that disagrees with it, a package that resolves to another version, and a missing entry, on a copy", () => {
  const bumped = bumpedTogether();
  assert.match(lockProblems(lock, bumped.pins).join("\n"), /pnpm-lock\.yaml has eslint at specifier .*, but package\.json declares /);

  const drifted = clone(lock);
  const entry = drifted.importers["."].devDependencies?.["typescript-eslint"];
  const drift = nextPatch(pins.devDependencies?.["typescript-eslint"] ?? "");
  if (entry) entry.version = drift;
  assert.match(lockProblems(drifted, pins).join("\n"), new RegExp(`typescript-eslint to ${drift.replaceAll(".", "\\.")}`));

  const unlisted = clone(lock);
  delete unlisted.importers["."].devDependencies?.["@george2f/eslint-plugin-clean-code"];
  assert.match(lockProblems(unlisted, pins).join("\n"), /does not list @george2f\/eslint-plugin-clean-code/);
});
