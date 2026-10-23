// module: how an operation whose caller may hand no runner runs on the plugin's own (A11-160, steps 5 and 7)
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/** An operation with a `run` in its request, made to use `own` when the caller hands none. */
export const withOwnRun = <Request extends { run: RowsRun }, Result>(operation: (request: Request) => Result, own: RowsRun) =>
  (request: Omit<Request, "run"> & { run?: RowsRun }): Result => operation({ ...request, run: request.run ?? own } as Request);
