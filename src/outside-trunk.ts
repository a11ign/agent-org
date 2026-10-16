#!/usr/bin/env node
// command: the project's trunk jobs (close rows, revert guard, liveness) run from outside the project, behind `outside.trunk` in `.agent-org/decisions.json`
// module: THE OUTSIDE HOME OF TRUNK (agent-org#1576, epic "agent-org stands alone", a11ign/a11ign#928)
//
// THE PROJECT'S `trunk.yml` RUNS THE ORG'S PROCESS ON THE PROJECT: `closeRows` (`close-rows-sweep`), `watchdogs` (`workflow:liveness`, `board:liveness`) and `trunkGate`
// (`trunk-revert-guard`). That is the org acting ON a project, so it has to run from the org's side before it can leave the project's CI. This is that side, shipped OFF.
//
// THE COMMANDS ARE THE JOBS' OWN, NOT A SECOND IMPLEMENTATION. Each already serves the project it runs in (`project-identity.ts`'s `REPO` is the home declaration's), so the home
// runs the same five scripts against the same repository with the verdict printed the job's way, and "the revert-guard verdict equals the job's" holds by construction. The
// scripts end in `process.exit`, so they are children (`row-file.ts` is spawned the same way), run in the project's checkout because the guard reads its git and the board
// liveness reads its workflow files.
//
// WHAT IS NOT HERE, AND WHY. `parent-recheck-summary` has its outside equivalent already: `trunk-red.ts` and `work-gate/causes/pr-ejected.ts` read a run's log through
// `summarizeTestLog`, which is the summary half of `trunkRecheck`; the test run it summarises is the product's (`trunkBuildTest`) and stays.
//
// THE SECOND ACTOR FINDS THE WORK DONE AND DOES NOTHING. The sweep closes by `closurePlan`, which reports a row already closed as `already` and never closes it twice, so a run
// beside the project's job closes nothing the job closed. The per-commit checks are verdicts, not writes, and a commit is asked ONCE: `checked` in the state names the commits
// answered, so a second run over the same window runs the sweep (cheap, idempotent) and the board check (it comments once) and nothing per commit.
//
// OFF IS ABSENT. The flag is read from the same file, with the same reader, as `routing.haikuDefault`; absent, `false` and an unreadable file are all off, and off does nothing
// at all: no state read, no git, no child.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decisionSwitchesPath, readSwitches } from "./decision-provider.ts";
import { stateEntryPath } from "./host-config.ts";
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { HOME_CHECKOUT, homeProjectDeclaration } from "./project-config.ts";
import { printDiagnostic, processState } from "./triage-provider.ts";

/** The key in `.agent-org/decisions.json`. Absent is off; the revert is that key set to `false`, and the project's own jobs run either way. */
export const OUTSIDE_TRUNK_SWITCH = "outside.trunk";
/** The least time between two runs from the host gate; the scheduled workflow and `--force` ignore it. */
export const INTERVAL_MS = 10 * 60_000;
/** Commits kept owed between runs; past this the oldest are dropped, said. */
export const MAX_OWED = 200;
/** Names a file for the state, for a runner that has no host declaration (the scheduled workflow) and keeps the file between runs itself. */
export const STATE_PATH_ENV = "OUTSIDE_TRUNK_STATE";
/** The commits looked at when nothing says how long it has been (a first run, or a runner with no state). */
export const DEFAULT_WINDOW_MINUTES = 60;
const MIN_WINDOW_MINUTES = 30;
const MAX_WINDOW_MINUTES = 24 * 60;
/** Commits asked per run. The rest are not marked answered, so the next run asks them: a run that met a long window stays inside a gate tick's reach. */
export const MAX_SHAS_PER_RUN = 5;
const CHILD_TIMEOUT_MS = 90_000;
/** The exit codes the scripts share: a verdict is 0 or 1, and 2 is "could not ask", which is asked again. */
const CANNOT_ASK = 2;

/** One script, by file name beside this one, and its arguments. */
export type Check = { name: string; script: string; args: string[] };
export type Outcome = { name: string; code: number | null; line: string };
/** `owed` is the commits asked and not answered (a could-not-ask, a timeout, or past the per-run cap), kept by name because the window moves on and would lose them. */
export type OutsideTrunkState = { at: number; checked: Record<string, true>; owed: string[] };
export type OutsideTrunkResult = { ran: false; why: "off" | "paced" | "commits-unreadable" } | { ran: true; outcomes: Outcome[]; skipped: number };
export type OutsideTrunkDeps = {
  switches: Readonly<Record<string, boolean | undefined>>;
  now: number;
  /** Ignore the pacing: the scheduled workflow, and an operator's hand. */
  force?: boolean;
  readState: () => OutsideTrunkState | null;
  writeState: (state: OutsideTrunkState) => void;
  /** The first-parent commits of the project's trunk newer than `windowMinutes`, oldest first, or `null` when they could not be read. */
  commits: (windowMinutes: number) => string[] | null;
  run: (check: Check) => Outcome;
  say: (line: string) => void;
};

/** Whether the flag is on. Anything but the boolean `true` is off. */
export function outsideTrunkOn(switches: Readonly<Record<string, boolean | undefined>>): boolean {
  return switches[OUTSIDE_TRUNK_SWITCH] === true;
}

/** How far back the sweep and the commit list look: since the last run, with ten minutes over, bounded both ways. No last run is the default. */
export function windowMinutes(lastAt: number | null, now: number): number {
  if (lastAt === null || lastAt > now) return DEFAULT_WINDOW_MINUTES;
  return Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, Math.ceil((now - lastAt) / 60_000) + 10));
}

/** The commit checks, in the order the job runs them: the revert guard first (pure git), then whether the pull request that produced the commit was tested. */
export const commitChecks = (sha: string): Check[] => [
  { name: `trunk-revert-guard ${sha.slice(0, 10)}`, script: "trunk-revert-guard.ts", args: [`--merge=${sha}`] },
  { name: `workflow:liveness ${sha.slice(0, 10)}`, script: "workflow-run-liveness.ts", args: [`--sha=${sha}`] },
];

/**
 * One run of the home. Never throws for a check that fails: each outcome is returned and said, and a commit is marked answered only when every one of its checks gave a verdict.
 * @returns what ran, or why nothing did
 */
export function outsideTrunk(deps: OutsideTrunkDeps): OutsideTrunkResult {
  if (!outsideTrunkOn(deps.switches)) return { ran: false, why: "off" };
  const state = deps.readState();
  if (deps.force !== true && state !== null && deps.now - state.at >= 0 && deps.now - state.at < INTERVAL_MS) return { ran: false, why: "paced" };
  const window = windowMinutes(state?.at ?? null, deps.now);
  const commits = deps.commits(window);
  if (commits === null) {
    deps.say(`outside-trunk: the commits of the last ${window}m could not be read, so nothing ran and nothing was marked answered`);
    return { ran: false, why: "commits-unreadable" };
  }
  // The commits owed from earlier runs come first and are asked whether or not the window still reaches them: `at` moves on every run, so a commit left out of `checked` would
  // otherwise fall out of `git log --since` and never be asked again.
  const checked: Record<string, true> = {};
  for (const sha of commits) if (state?.checked[sha] === true) checked[sha] = true;
  const everyone = [...new Set([...(state?.owed ?? []), ...commits])];
  const owed = everyone.filter((sha) => checked[sha] !== true);
  const asked = owed.slice(0, MAX_SHAS_PER_RUN);
  const outcomes: Outcome[] = [];
  const note = (outcome: Outcome): Outcome => { deps.say(`outside-trunk: ${outcome.line}`); outcomes.push(outcome); return outcome; };
  note(deps.run({ name: "close-rows-sweep", script: "close-rows-sweep.ts", args: [`--window=${window}`] }));
  for (const sha of asked) {
    const answered = commitChecks(sha).map((check) => note(deps.run(check)));
    if (answered.every((o) => o.code === 0 || o.code === 1)) checked[sha] = true;
  }
  const stillOwed = owed.filter((sha) => checked[sha] !== true);
  const kept = stillOwed.slice(-MAX_OWED);
  if (kept.length < stillOwed.length) deps.say(`outside-trunk: ${stillOwed.length - kept.length} commits owed a check were dropped (more than ${MAX_OWED} owed); the oldest are not asked`);
  note(deps.run({ name: "board:liveness", script: "board-schedule-liveness.ts", args: ["--post"] }));
  deps.writeState({ at: deps.now, checked, owed: kept });
  return { ran: true, outcomes, skipped: owed.length - asked.length };
}

/** The process exit for a run: 0 when every check passed, 1 when one gave a refusing verdict or could not close, 2 when one could not ask. A run that did not happen is 0. */
export function exitCodeOf(result: OutsideTrunkResult): number {
  if (!result.ran) return 0;
  const codes = result.outcomes.map((o) => o.code);
  if (codes.some((code) => code === null || code === CANNOT_ASK)) return CANNOT_ASK;
  return codes.some((code) => code !== 0) ? 1 : 0;
}

const here = (script: string): string => fileURLToPath(new URL(`./${script}`, import.meta.url));

/** The first line a child printed, stderr before stdout (a refusal is on stderr), so the line says the verdict and the log keeps the rest. */
const firstLine = (text: string): string => text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";

/** The live reads: the project's checkout, its repository from the home declaration, and the state file beside the wake ledger. */
export function liveDeps(over: Partial<Pick<OutsideTrunkDeps, "switches" | "force" | "say">> = {}): OutsideTrunkDeps {
  const say = over.say ?? printDiagnostic;
  const statePath = (): string => process.env[STATE_PATH_ENV] ?? stateEntryPath("outside-trunk");
  return {
    switches: over.switches ?? readSwitches(decisionSwitchesPath(HOME_CHECKOUT), { diagnostic: say, state: processState, read: readFileSync }),
    force: over.force,
    now: Date.now(),
    say,
    readState: () => {
      let text: string;
      try {
        text = readFileSync(statePath(), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") say(`outside-trunk: the state could not be read (${firstLine(String(err))}), so it runs as a first run`);
        return null;
      }
      try {
        const parsed = JSON.parse(text) as Partial<OutsideTrunkState>;
        if (typeof parsed.at === "number" && typeof parsed.checked === "object" && parsed.checked !== null) {
          return { at: parsed.at, checked: parsed.checked, owed: Array.isArray(parsed.owed) ? parsed.owed.filter((sha): sha is string => typeof sha === "string") : [] };
        }
      } catch {
        // falls to the line below
      }
      say("outside-trunk: the state file is not a state, so it runs as a first run");
      return null;
    },
    writeState: (state) => {
      try {
        const path = statePath();
        if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(state));
      } catch (err) {
        say(`outside-trunk: the state could not be written (${firstLine(String(err))}), so the next run asks the same commits again`);
      }
    },
    commits: (minutes) => {
      try {
        const since = new Date(Date.now() - minutes * 60_000).toISOString();
        const out = execFileSync("git", ["log", "--first-parent", "--reverse", "--format=%H", `--since=${since}`, "origin/main"], { cwd: HOME_CHECKOUT, encoding: "utf8", env: sandboxGitEnv(), stdio: "pipe" });
        return out.split("\n").filter((line) => line !== "");
      } catch {
        return null;
      }
    },
    run: (check) => {
      const child = spawnSync(process.execPath, [here(check.script), ...check.args], { cwd: HOME_CHECKOUT, encoding: "utf8", timeout: CHILD_TIMEOUT_MS,
        env: { ...process.env, GITHUB_REPOSITORY: homeProjectDeclaration().repo, SWEEP_RETRY_TRANSIENT: "1" } });
      const said = firstLine(child.stderr) || firstLine(child.stdout);
      return { name: check.name, code: child.status, line: `${check.name}: exit ${child.status ?? "none (timed out or not started)"}${said === "" ? "" : ` -- ${said}`}` };
    },
  };
}

/** The host gate's call: paced, never throws (a tick that failed here would hold every other order), and silent when the flag is off. */
export function outsideTrunkOnHost(switches: Readonly<Record<string, boolean | undefined>>): void {
  try {
    if (outsideTrunkOn(switches)) outsideTrunk(liveDeps({ switches }));
  } catch (err) {
    printDiagnostic(`agent-org: outside-trunk: not run (${firstLine(String(err))})`);
  }
}

function main(): void {
  refuseUnknownFlags(["--force"], { entry: import.meta.url, command: "agent-org outside-trunk [--force]" });
  const deps = liveDeps({ force: process.argv.includes("--force"), say: (line) => console.log(line) });
  const result = outsideTrunk(deps);
  if (!result.ran) console.log(`outside-trunk: nothing ran (${result.why}${result.why === "off" ? `: ${OUTSIDE_TRUNK_SWITCH} is not true in ${decisionSwitchesPath(HOME_CHECKOUT)}` : ""})`);
  process.exit(exitCodeOf(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
