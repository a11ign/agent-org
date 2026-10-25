// @ts-check
// module: `update`, `host:install` and `start` refuse to run from a copy of the tool that is not the installed one and is older than it (A11-285)
//
// On 2026-10-25 `agent-org update`, typed where `agent-org` was an alias to a v0.276.0 checkout, ran that old code against a v0.304.1 install: it moved `current` without the UI build and the board
// said "The UI build is missing". These three commands change the install or the services, so each says which copy ran and how to run the right one, unless `--allow-older-copy` is given
// (for development). `src/bin.ts` calls this once, between the command table and the program, so no program changes and the three cannot drift apart. A copy older than this change has no guard:
// doctor's `agent-org command` row and the end-of-install check cover that case.
//
// `unknown` (the copy does not hold the installed release's source commit) is refused as older: a copy not shown to be newer is not allowed. Every other command starts as fast as before,
// because the comparison runs git and only these three ask for it.
import type { CopyComparison } from "./tool-copy.ts";
import { currentLink } from "./tool-versions.ts";

export const GUARDED = ["update", "host:install", "start"] as const;
export const OVERRIDE_FLAG = "--allow-older-copy";

export type Guarded = Readonly<{ command: string; argv: readonly string[]; copyRoot: string; tool: string; binDir: string; compare: (copyRoot: string) => CopyComparison }>;

/** The words that say which copy ran, set against the installed one. */
function whichCopy(copyRoot: string, comparison: CopyComparison): string {
  if (comparison.kind === "unknown") return `${copyRoot} (${comparison.copy}), whose age against the installed ${comparison.installed} cannot be told: ${comparison.reason}. \`${comparison.fix}\` settles it`;
  if (comparison.kind === "older") return `${copyRoot} (${comparison.copy}), which is not the installed tool and is older than it (${comparison.installed})`;
  return copyRoot;
}

/**
 * Whether `command` may run from this copy. PURE over `compare`.
 * @returns `run` with the arguments the program should get (the override flag removed), or a `refusal` to print with exit 2
 */
export function guardCopy({ command, argv, copyRoot, tool, binDir, compare }: Guarded): { run: string[] } | { refusal: string } {
  const overridden = argv.includes(OVERRIDE_FLAG);
  const rest = argv.filter((arg) => arg !== OVERRIDE_FLAG);
  if (!(GUARDED as readonly string[]).includes(command)) return { run: [...argv] };
  if (overridden) return { run: rest };
  const comparison = compare(copyRoot);
  if (comparison.kind !== "older" && comparison.kind !== "unknown") return { run: rest };
  const words = rest.slice(1).join(" ");
  const invocation = `${command}${words === "" ? "" : ` ${words}`}`;
  return {
    refusal: `agent-org ${command}: refused: this ran ${whichCopy(copyRoot, comparison)}. Run \`${binDir}/agent-org ${invocation}\`, or \`node ${currentLink(tool)}/src/bin.ts ${invocation}\`; \`agent-org doctor\` shows what your \`agent-org\` runs. \`${OVERRIDE_FLAG}\` runs it from this copy anyway.`,
  };
}
