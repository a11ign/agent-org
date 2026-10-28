// @ts-check
// module: this host's doctor for the After-merge checks that watch it, run in a child of its own so the board's loop goes on while it does (A11-377)
//
// THE DOCTOR'S CHECKS SPAWN SYNCHRONOUSLY: they mint each App role's token, list Claude Code's MCP servers and ask pnpm its version. Run on the board's
// thread they held its loop for seconds at a time, every sweep that read them. In a child the spawns hold only the child, and the board waits for it with
// `execAsync`. The child prints the lines as JSON on its last line, so anything else a check writes to stdout is not read as the answer.
import type { ExecResult } from "../../plugins/manifest.ts";
import type { DoctorLine } from "./observe.ts";

/** The program the child runs: `diagnose` with its real deps, as `agent-org doctor` runs it, printed as one line of JSON. */
export const DOCTOR_PROGRAM = `import(${JSON.stringify(new URL("../../install/doctor.ts", import.meta.url).href)})`
  + ".then((doctor) => doctor.diagnose(doctor.defaultDoctorDeps()))"
  + ".then((checks) => process.stdout.write(`\\n${JSON.stringify(checks.map(({ name, ok, detail }) => ({ name, ok, detail })))}\\n`));";

/** How long the child may run: the doctor gives `claude mcp list` a minute and each mint thirty seconds. */
export const DOCTOR_MS = 5 * 60_000;

const isLine = (value: unknown): value is DoctorLine => {
  const line = value as Partial<DoctorLine> | null;
  return typeof line === "object" && line !== null && typeof line.name === "string" && typeof line.ok === "boolean" && typeof line.detail === "string";
};

/** The doctor's lines from what the child answered, or the reason there are none. PURE. */
export function doctorLinesOf(answer: ExecResult): Readonly<{ lines: readonly DoctorLine[] }> | Readonly<{ failure: string }> {
  const last = answer.stdout.trimEnd().split("\n").at(-1) ?? "";
  try {
    const lines: unknown = JSON.parse(last);
    if (answer.status === 0 && Array.isArray(lines) && lines.every(isLine)) return { lines };
  } catch {
    // Not JSON: said below with the child's own reason.
  }
  const said = (answer.spawnError ?? answer.stderr).split("\n").find((line) => line.trim() !== "");
  return { failure: said ?? `the doctor's child exited ${answer.status} and printed no lines` };
}

/** The lines of this host's doctor, from a child run with `execAsync`. Never throws: a child that fails answers its reason. */
export async function hostDoctorLines(execAsync: (file: string, args: readonly string[], options: { timeoutMs: number }) => Promise<ExecResult>): Promise<ReturnType<typeof doctorLinesOf>> {
  return doctorLinesOf(await execAsync(process.execPath, ["--input-type=module", "-e", DOCTOR_PROGRAM], { timeoutMs: DOCTOR_MS }));
}
