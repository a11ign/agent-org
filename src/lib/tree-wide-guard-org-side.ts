// agent-org#1503 (ADR 0045 cut c, receiving side of a11ign#5460): THE ORG SIDE OF a11ign's `guardSweep`, in a file of its own because `work-gate/tick.ts`
// must load in a tree with NO node_modules (`work-gate.test.ts` #2174) and `./tree-wide-guard.ts` re-exports the toolchain's marker, a bare specifier.
// The sweep ran every tracked `*.test.ts` that
// IMPORTS the marker (`./tree-wide-guard.ts`) and CALLS it, on every pull request, whether or not `ts` ran. What is left marked in a project after its guards are sorted
// (product invariants become plain tests or lint, dead ones go) is the population the org runs for an agent pull request; a guard "declares its own
// membership" exactly as it did, so the tool names no project file. The discovery is the product's own `treeWideGuardFiles` read over a checkout that is
// NOT the process's cwd, which the toolchain's `walkTree` cannot do (it walks cwd). The comment-stripper is `local-import-closure.ts`'s, which is the one the
// product's own discovery uses, so a file is classified as the sweep classified it.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./local-import-closure.ts";
import { sandboxGitEnv } from "./git-env.ts";
import { pnpmCliInvocation } from "./npm-cli-executable.ts";
import { isBrokenRed } from "../red-pr.ts";

/** The marker's specifiers: the toolchain's, and the tool's own declared export a travelling guard may still import. Read off COMMENT-STRIPPED source, so a
 *  specifier spelled in a comment or a string is not a declaration. */
const MARKER_SPECIFIER = /\b(?:from|import)\s*\(?\s*['"](?:@a11ign\/toolchain\/lib\/tree-wide-guard|agent-org\/tree-wide-guard)['"]/;
/** Imported is not used: the call is what declares (the product's own distinction, for a canonical helper pulled in and never called). */
const MARKER_CALL = /\bdeclareTreeWideGuard\(/;

/** Does this source import the marker AND call it. Pure, so the positive and the negative control are both a string. */
export function declaresTreeWideGuard(source: string): boolean {
  const code = stripComments(source);
  return MARKER_SPECIFIER.test(code) && MARKER_CALL.test(code);
}

/** Every tracked `*.test.ts` of the checkout at `cwd` that declares itself a tree-wide guard, sorted. `lsFiles` and `readFile` are the seams. */
export function treeWideGuardFilesIn(cwd: string, { lsFiles = () => execFileSync("git", ["ls-files", "*.test.ts"], { cwd, encoding: "utf8", env: sandboxGitEnv() }),
  readFile = (path: string) => readFileSync(join(cwd, path), "utf8") }: { lsFiles?: () => string; readFile?: (path: string) => string; } = {}): string[] {
  return lsFiles().split("\n").filter(Boolean).filter((path) => declaresTreeWideGuard(readFile(path))).sort();
}

/** How long the guards of one pull request may run. A run that hits it says nothing about the pull request, so it is `not-run`, never `fail`. */
export const GUARD_RUN_TIMEOUT_MS = 10 * 60 * 1000;

export type GuardRun = { ok: boolean; lines: string[]; ran: number; timedOut: boolean; };

/** The runner config a project of this family keeps (the toolchain's `./rstest-config`, which the tool's own tree uses too). Present, the guards run under THE
 *  PROJECT'S runner: measured on a11ign `a73817378`, `node --test` alone fails `criteria-counts-are-not-spelled-out.test.ts` on a `./coverage.js` import that
 *  only the runner's resolver maps to `coverage.ts`, where the same five guards pass 48 tests under rstest. Absent, plain `node --test`. */
export const RSTEST_CONFIG = "scripts/rstest/rstest.config.ts";

type Spawn = (command: string, args: string[], options: object) => { status: number | null; stdout?: string; stderr?: string; error?: Error; };

/**
 * Run `files` in `cwd` and read the verdict off the runner, not off the files, and refuse the run that ran nothing, which exits 0 and is the vacuity this
 * whole family exists to refuse. Tokens in the host's environment are not passed on (this is a pull request's own test code), nor is `NODE_TEST_CONTEXT`,
 * which makes a nested `node --test` print v8 frames, not a summary.
 *
 * - under rstest, the verdict is the project's `VERDICT pass: N tests in M files` line: absent, `REFUSED` or `fail` is not a pass, and M must be every file;
 * - under `node --test`, which reports a file that registered no test as ONE PASSING test named for the file (`✔ x.test.ts`), `ℹ tests` cannot say a guard
 *   ran, so each file's own line is what is read.
 *
 * `spawn` and `exists` are the seams.
 */
export function runTreeWideGuards(files: string[], cwd: string, { env = process.env, timeoutMs = GUARD_RUN_TIMEOUT_MS, spawn = spawnSync as unknown as Spawn,
  exists = existsSync }: { env?: Record<string, string | undefined>; timeoutMs?: number; spawn?: Spawn; exists?: (path: string) => boolean; } = {}): GuardRun {
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !/TOKEN|SECRET|PASSWORD|PAT$|_KEY$|^NODE_TEST_CONTEXT$/i.test(name)));
  const rstest = exists(join(cwd, RSTEST_CONFIG));
  const invocation = rstest ? pnpmCliInvocation(["exec", "rstest", "run", "--config", RSTEST_CONFIG, ...files]) : { command: process.execPath, args: ["--test", ...files] };
  const result = spawn(invocation.command, invocation.args, { cwd, env: clean, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const all = text.split("\n");
  const settled = !timedOut && result.error === undefined && result.status === 0;
  const lines: string[] = [];
  let ok: boolean;
  let ran: number;
  if (rstest) {
    const verdict = /^VERDICT (\w+): (\d+) tests? in (\d+) files?/m.exec(text);
    ran = Number(verdict?.[2] ?? 0);
    ok = settled && verdict?.[1] === "pass" && ran >= 1 && Number(verdict?.[3]) === files.length;
    lines.push(...all.filter((line) => /^(VERDICT|FAIL|✖|\s*(AssertionError|Error))/.test(line)).slice(0, 40));
    if (verdict === null && lines.length === 0) lines.push("no VERDICT line: an unread verdict is not a pass");
    if (settled && !ok && verdict?.[1] === "pass") lines.push(`FAIL: ${ran} test(s) in ${verdict?.[3]} of ${files.length} guard file(s): a guard that ran nothing is not a pass`);
  } else {
    ran = Number(/^ℹ tests (\d+)$/m.exec(text)?.[1] ?? 0);
    const failed = Number(/^ℹ fail (\d+)$/m.exec(text)?.[1] ?? 0);
    const fileLevel = new Set(all.filter((line) => /^✔ \S+\.[cm]?[jt]s( \(|$)/.test(line)).map((line) => line.slice(2).replace(/ \([\d.]+m?s\)$/, "")));
    const ranNothing = files.filter((file) => [...fileLevel].some((name) => file === name || file.endsWith(`/${name}`) || name.endsWith(`/${file}`)));
    lines.push(...all.filter((line) => /^(✖|ℹ (tests|pass|fail))/.test(line)).slice(0, 40));
    ok = settled && failed === 0 && ran >= 1 && ranNothing.length === 0;
    if (settled && failed === 0 && !ok) lines.push(`FAIL: ${ranNothing.length === 0 ? "no test ran" : `${ranNothing.join(", ")} ran nothing`}: a guard that ran nothing is not a pass`);
  }
  if (!ok && lines.length === 0) lines.push(`exit ${String(result.status)}${timedOut ? " (timed out)" : ""}${result.error === undefined ? "" : `: ${result.error.message.slice(0, 160)}`}`);
  return { ok, lines, ran, timedOut };
}

/**
 * agent-org#1580 (the epic "agent-org stands alone", a11ign#928): THE OUTSIDE HOME OF a11ign's `guardSweep` JOB, SHIPPED OFF, AND SHADOW WHEN ON.
 *
 * The flag is `outside.guards` in the project's `.agent-org/decisions.json`; the caller reads it with `decision-provider.ts`'s `readSwitches` (absent = off) and hands the
 * record here, so this file imports no reader that reaches `gh` (it must still load with no `node_modules`). OFF: `verdictOf` is never called, so nothing is checked out,
 * discovered or run. ON: the verdict it returns (`treeWideGuardVerdict` in the caller) is RECORDED beside the job's, and `blocks` is the literal `false`: a shadow verdict
 * arms nothing and holds nothing, and `guardSweep` stays in `gate`'s `needs`. Revert is the flag set `false`.
 *
 * THE FIRST READ (a11ign#928 section 3 named the commands, not their equivalence): the discovery and the run above ARE the job's (`declareTreeWideGuard()` is its own
 * membership), so the receiver of every guard still marked in a project is this home, by the marker, and the tool names no project file. The sorting of the population
 * into org-only, product and dead is the project's to do on the guards it marks (a11ign#5615 is the switch row); a guard it unmarks is no longer in this population.
 */
export const OUTSIDE_GUARDS_FLAG = "outside.guards";
export const outsideGuardsOn = (switches: Readonly<Record<string, unknown>> | null | undefined): boolean => switches?.[OUTSIDE_GUARDS_FLAG] === true;

/** A named a11ign job's verdict on a head, read off the pull request's check rollup already narrowed to the newest run per name: `pass` on SUCCESS, `fail` when `isBrokenRed` says the check is red,
 *  and `null` for everything else (absent, still running, skipped, cancelled), which the comparison reads as not-compared, never as agreement. agent-org#1579: the one reader of a job's verdict, shared by the shadows. */
export function namedJobOf(rollup: { name?: string; conclusion?: string | null; }[] | null | undefined, job: string): "pass" | "fail" | null {
  const run = (rollup ?? []).find((check) => new RegExp(`(^|[\\s/])${job}$`).test(String(check?.name ?? "")));
  if (run === undefined) return null;
  // red is `isBrokenRed`'s to say (#2956 ONE DECIDER), asked of this one check alone so another check's failure is not the job's
  if (isBrokenRed({ statusCheckRollup: [run] })) return "fail";
  return String(run.conclusion ?? "").toUpperCase() === "SUCCESS" ? "pass" : null;
}

/** The a11ign `guardSweep` job's verdict on a head (see `namedJobOf`). */
export const guardSweepJobOf = (rollup: { name?: string; conclusion?: string | null; }[] | null | undefined): "pass" | "fail" | null => namedJobOf(rollup, "guardSweep");

type GuardVerdict = import("../acceptance-commands.ts").OrgSideVerdict;

/** `agree`: the same pass or fail as the job. `disagree`: the two differ, which the canary counts. `not-compared`: the home did not run to an end, or the job's verdict was not read. */
export type ShadowGuards =
  | { on: false; }
  | { on: true; blocks: false; verdict: GuardVerdict; job: "pass" | "fail" | null; agreement: "agree" | "disagree" | "not-compared"; };

export function shadowGuardsVerdict<PR>(pr: PR, { switches, job = null, verdictOf }: {
  switches: Readonly<Record<string, unknown>> | null | undefined; job?: "pass" | "fail" | null; verdictOf: (pr: PR) => GuardVerdict;
}): ShadowGuards {
  if (!outsideGuardsOn(switches)) return { on: false };
  const verdict = verdictOf(pr);
  const agreement = verdict.kind === "not-run" || job === null ? "not-compared" : verdict.kind === job ? "agree" : "disagree";
  return { on: true, blocks: false, verdict, job, agreement };
}
