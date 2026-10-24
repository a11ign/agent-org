// module: the GitHub plugin's rows for the readouts section of the contract (A11-160, step 9; moved from the callers named in each operation's comment)
//
// Each operation builds the argument list its caller built and reads GitHub's answer as the caller did, and THROWS when `gh` refuses: what a caller does with a refusal stays in core. `run` is the caller's executor
// (every caller of this section hands one: a runner it asked the code host for with its policy, or its own); the one operation that starts a program of its own is the tick snapshot's probe.
import type { CodeHostRows, RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { AnsweringRun } from "../../../src/plugins/contracts/code-host-rows-facts.ts";
import type { RowsReadouts } from "../../../src/plugins/contracts/code-host-rows-readouts.ts";
import type { RowsRunners } from "./index.ts";
import { probeOf } from "./probe-reads.ts";
import { readoutsReads } from "./readouts-reads.ts";

/** The operations of this section. */
export type ReadoutsRows = Pick<CodeHostRows, keyof RowsReadouts>;

/** The runner that answers how the program ended, as the probe needs it: absent, the probe is refused as every runner of a code host built with none is. */
function answeringOf(runners: RowsRunners, request: { timeoutMs: number; maxBuffer: number }): AnsweringRun {
  if (runners.withAnswer === undefined) throw new Error("this code host's rows were built with no runner of their own, so a runner with a policy cannot be made");
  return runners.withAnswer({ ...request, echo: false });
}

export function readoutsRowsOf(runners: RowsRunners, _helpers: () => RowsHelpers): ReadoutsRows {
  return {
    ...readoutsReads,
    conditionalProbeOf: ({ path, etag, timeoutMs, maxBuffer }) => probeOf({ path, etag, run: answeringOf(runners, { timeoutMs, maxBuffer }) }),
  };
}
