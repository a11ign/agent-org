#!/usr/bin/env node
// command: run one of a project's weekly reports (CI health, token cost, weekly review, the outsider verdict) from outside the project, behind `outside.reports` in `.agent-org/decisions.json`
// module: THE OUTSIDE HOME OF THE REPORTS (agent-org#1582, epic "agent-org stands alone", a11ign/a11ign#928)
//
// THE PROJECT'S REPORTS ARE THE ORG'S PROCESS ACTING ON THE PROJECT: the CI-health table on the report issue, the calls-and-dollars reading appended to it, the weekly review row,
// and the outsider verdict's `regression` row. That has to run from the org's side before it can leave the project's CI. This is that side, SHIPPED OFF.
//
// THE REPORTS ARE THE PROJECT'S OWN SCRIPTS, NOT A SECOND IMPLEMENTATION, exactly as `outside-trunk.ts` runs the project's trunk scripts: each already reads its targets, its documents
// and its issue from the project it runs in, and each is idempotent per period by its own contract (CI health: the week's heading on the report issue; token cost: the week's section
// of that comment; weekly review: the ISO week's row title; the verdict: the version's row title). So the pair of actors prints the same thing and the second finds the work done and
// posts nothing, whichever order they fire in; the equality the canary reads holds by construction. Moving the scripts' logic into this repository is a later row, and nothing here
// depends on it.
//
// THE PROJECT DECLARES WHERE THEY ARE, in `.agent-org/project.json`: `units.reports.<name> = { "script": "<path in the project>", "args": ["--post"] }`. No project path or name is
// in this file; an undeclared report is not run, and a name outside the closed set below is refused.
//
// WHERE EACH RUNS, AND WHY (read 2026-10-16 from the project's own units and workflows, not from the row's text):
//   - `ci-health`, `outsider-verdict`: a scheduled workflow (`org-reports.yml`). They read public run lists and post with a repository token.
//   - `token-cost`: ON THE HOST. It reads the session transcripts under the host's home, so a runner reads an empty directory and would post a figure of zero calls. Refused under Actions.
//   - `weekly-review`: ON THE HOST. It files through `row-file`, whose board step needs a credential a runner's `github.token` is not (the project's own unit says so, run 37133463643).
//
// OFF IS ABSENT. The flag is read from the same file, with the same reader, as `routing.haikuDefault`; absent, `false`, a non-boolean and an unreadable file are all off, and off does
// nothing at all: no declaration read, no child.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { decisionSwitchesPath, readSwitches } from "./decision-provider.ts";
import { HOME_CHECKOUT, PROJECT_DECLARATION_PATH } from "./project-config.ts";
import { printDiagnostic, processState } from "./triage-provider.ts";

/** The key in `.agent-org/decisions.json`. Absent is off; the revert is that key set to `false`, and the project's own jobs run either way. */
export const OUTSIDE_REPORTS_SWITCH = "outside.reports";

/** The closed set of reports and where each can run. `host` is refused under GitHub Actions, with the reason it prints. */
export const REPORTS: Readonly<Record<string, { where: "runner" | "host"; why: string }>> = {
  "ci-health": { where: "runner", why: "reads public run lists and posts with a repository token" },
  "outsider-verdict": { where: "runner", why: "reads the registry and a public run list and files with a repository token" },
  "token-cost": { where: "host", why: "reads the session transcripts on the host's disk, which a runner does not have, and would post a figure of zero calls" },
  "weekly-review": { where: "host", why: "files through row-file, whose board step needs a credential a runner's own token is not" },
};

const CHILD_TIMEOUT_MS = 30 * 60_000;
/** The exit code the project's scripts share for "could not ask / could not run". */
const CANNOT_RUN = 2;

export type Declared = { script: string; args: string[] };
export type OutsideReportsResult =
  | { ran: false; why: "off" | "unknown-report" | "undeclared" | "wrong-place" | "declaration-unusable" | "script-missing"; detail?: string }
  | { ran: true; code: number | null; line: string };
export type OutsideReportsDeps = {
  switches: Readonly<Record<string, boolean | undefined>>;
  /** True under GitHub Actions: the one fact `where: "host"` is refused on. */
  onRunner: boolean;
  /** The text of the project's `.agent-org/project.json`, or `null` when it cannot be read. */
  declaration: () => string | null;
  scriptExists: (script: string) => boolean;
  run: (declared: Declared, extra: string[]) => { code: number | null; line: string };
  say: (line: string) => void;
};

/** Whether the flag is on. Anything but the boolean `true` is off. */
export function outsideReportsOn(switches: Readonly<Record<string, boolean | undefined>>): boolean {
  return switches[OUTSIDE_REPORTS_SWITCH] === true;
}

/** A script path the project may declare: relative, inside the project, never a flag. A declared path that climbs out of the checkout would run something that is not the project's. */
export const scriptPathUsable = (script: unknown): script is string =>
  typeof script === "string" && script !== "" && !isAbsolute(script) && !script.startsWith("-") && !normalize(script).split("/").includes("..");

/**
 * The project's declaration of one report, from its `.agent-org/project.json`. A missing or malformed one is a reason, never a default: running a script the project did not name is
 * the one thing this command must not do.
 * @returns the declared script, `"undeclared"` when the project names no such report, or a reason the declaration cannot be used
 */
export function declaredReport(text: string, name: string): Declared | "undeclared" | { refusal: string } {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return { refusal: "the project declaration is not valid JSON" }; }
  const entry = parsed?.units?.reports?.[name];
  if (entry === undefined) return "undeclared";
  if (!scriptPathUsable(entry?.script)) return { refusal: `units.reports.${name}.script must be a path inside the project, not a flag, an absolute path or one that climbs out` };
  const args = entry.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return { refusal: `units.reports.${name}.args must be a list of strings` };
  return { script: entry.script, args };
}

/**
 * One run of one report. Never throws for a report that fails: the child's exit is returned and said. The caller's extra arguments follow the declared ones, so a host unit can name
 * the week (`--week=`) without the declaration knowing it.
 */
export function outsideReport(name: string, extra: string[], deps: OutsideReportsDeps): OutsideReportsResult {
  if (!outsideReportsOn(deps.switches)) return { ran: false, why: "off" };
  const report = REPORTS[name];
  if (report === undefined) return { ran: false, why: "unknown-report", detail: `${name} is not one of ${Object.keys(REPORTS).join(", ")}` };
  if (report.where === "host" && deps.onRunner) return { ran: false, why: "wrong-place", detail: `${name} runs on the host, not under GitHub Actions: it ${report.why}` };
  const text = deps.declaration();
  if (text === null) return { ran: false, why: "declaration-unusable", detail: "the project declaration could not be read" };
  const declared = declaredReport(text, name);
  if (declared === "undeclared") return { ran: false, why: "undeclared", detail: `the project declares no units.reports.${name}` };
  if ("refusal" in declared) return { ran: false, why: "declaration-unusable", detail: declared.refusal };
  if (!deps.scriptExists(declared.script)) return { ran: false, why: "script-missing", detail: `${declared.script} is not in the project's checkout` };
  const outcome = deps.run(declared, extra);
  deps.say(`outside-reports: ${name}: ${outcome.line}`);
  return { ran: true, ...outcome };
}

/** The process exit: the child's own when it ran (a script's 1 is a verdict, its 2 is "could not ask"), 0 when nothing ran for a reason that is not a fault, 2 for one that is. */
export function exitCodeOf(result: OutsideReportsResult): number {
  if (result.ran) return result.code ?? CANNOT_RUN;
  return result.why === "off" || result.why === "undeclared" ? 0 : CANNOT_RUN;
}

/** The first line a child printed, stderr before stdout (a refusal is on stderr), so the line says the verdict and the log keeps the rest. */
const firstLine = (text: string): string => text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";

/** The live reads: the project's checkout, its declaration, and its script as a child run there. */
export function liveDeps(say: (line: string) => void = printDiagnostic): OutsideReportsDeps {
  return {
    switches: readSwitches(decisionSwitchesPath(HOME_CHECKOUT), { diagnostic: say, state: processState, read: readFileSync }),
    onRunner: process.env.GITHUB_ACTIONS === "true",
    say,
    declaration: () => {
      try { return readFileSync(join(HOME_CHECKOUT, PROJECT_DECLARATION_PATH), "utf8"); } catch { return null; }
    },
    scriptExists: (script) => existsSync(join(HOME_CHECKOUT, script)),
    run: (declared, extra) => {
      const child = spawnSync(process.execPath, [join(HOME_CHECKOUT, declared.script), ...declared.args, ...extra], { cwd: HOME_CHECKOUT, encoding: "utf8", timeout: CHILD_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
      // The child's own output is the report's record (the table it posted, "already posted"): pass it on whole, then add the one line that says how it ended.
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
      const said = firstLine(child.stderr) || firstLine(child.stdout);
      return { code: child.status, line: `exit ${child.status ?? "none (timed out or not started)"}${said === "" ? "" : ` -- ${said}`}` };
    },
  };
}

function main(): void {
  const [name, ...extra] = process.argv.slice(2);
  if (name === undefined || name.startsWith("-")) {
    console.error(`usage: agent-org outside-reports <${Object.keys(REPORTS).join("|")}> [arguments the report's script takes, after the declared ones]`);
    process.exit(CANNOT_RUN);
  }
  const result = outsideReport(name, extra, liveDeps((line) => console.log(line)));
  if (!result.ran) console.log(`outside-reports: nothing ran (${result.why}${result.why === "off" ? `: ${OUTSIDE_REPORTS_SWITCH} is not true in ${decisionSwitchesPath(HOME_CHECKOUT)}` : result.detail === undefined ? "" : `: ${result.detail}`})`);
  process.exit(exitCodeOf(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
