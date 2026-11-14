// @ts-check
// no-token: none -- the scenarios run on fixture instances of in-memory fakes; nothing is spawned and no account is reached
// module: the fault-injection command (A11-439): which scenarios to run, the report, and the exit code `scripts/fault-injection.ts` ends with
//
// EXIT 0 WHEN NO RUN IS STUCK, 1 WHEN ONE IS, 2 FOR A SCENARIO IT DOES NOT KNOW. A person runs `node scripts/fault-injection.ts`, or names scenarios with `--scenario <name>` (more than once for several), and reads the report: every
// run's status and reason, and the run log of each run left stuck with no reason shown.
import { runScenario, SCENARIOS, type Scenario } from "./scenarios.ts";
import { report, stuckOf, type ScenarioResult } from "./stuck-runs.ts";

/** What the command prints, where, and the code it exits with. */
export type CommandResult = Readonly<{ stdout: string; stderr: string; code: 0 | 1 | 2 }>;

/** The scenarios `names` asks for, in the command's order, every one when none is named; or the names it does not know. PURE. */
export function chosenScenarios(names: readonly string[] | undefined, scenarios: readonly Scenario[] = SCENARIOS): Readonly<{ chosen: Scenario[] } | { unknown: string[] }> {
  if (names === undefined || names.length === 0) return { chosen: [...scenarios] };
  const unknown = names.filter((name) => !scenarios.some((scenario) => scenario.name === name));
  return unknown.length > 0 ? { unknown } : { chosen: scenarios.filter(({ name }) => names.includes(name)) };
}

/** The exit code for `results`: 1 when any run is stuck with no reason shown, else 0. PURE. */
export const exitCodeOf = (results: readonly ScenarioResult[]): 0 | 1 => (results.some((result) => stuckOf(result).length > 0) ? 1 : 0);

/** Runs the scenarios `names` asks for, one after another, and answers the report and the exit code. */
export async function faultInjection(names: readonly string[] | undefined, scenarios: readonly Scenario[] = SCENARIOS): Promise<CommandResult> {
  const picked = chosenScenarios(names, scenarios);
  if ("unknown" in picked) {
    return { stdout: "", stderr: `fault-injection: no scenario named ${picked.unknown.join(", ")}; the scenarios are ${scenarios.map(({ name }) => name).join(", ")}\n`, code: 2 };
  }
  const results: ScenarioResult[] = [];
  for (const scenario of picked.chosen) results.push(await runScenario(scenario));
  return { stdout: report(results), stderr: "", code: exitCodeOf(results) };
}
