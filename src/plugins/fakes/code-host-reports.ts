// @ts-check
// module: the in-memory code host's operations for the board, the health and retro readings, the DORA reader, the trace, the chairman's watch and the board's snapshot (A11-160, step 8)
//
// Each group has a file of its own (`code-host-board.ts`, `-health.ts`, `-dora.ts`, `-trace.ts`, `-messaging.ts`, `-snapshot.ts`) and a piece of the world a test seeds, `world.reports.<group>`. THEY ACT ON THAT WORLD and ignore the
// `run` their caller hands them. A fake has no program: its runners throw, and a test of code that starts the code host's program itself runs against the GitHub plugin.
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import { boardOperations, emptyBoard, type FakeBoard } from "./code-host-board.ts";
import { doraOperations, emptyDora, type FakeDora } from "./code-host-dora.ts";
import { emptyHealth, healthOperations, type FakeHealth } from "./code-host-health.ts";
import { emptyMessaging, messagingOperations, type FakeMessaging } from "./code-host-messaging.ts";
import type { FakeRowsWorld } from "./code-host-rows.ts";
import { emptySnapshot, snapshotOperations, type FakeSnapshot } from "./code-host-snapshot.ts";
import { emptyTrace, traceOperations, type FakeTrace } from "./code-host-trace.ts";

/** What these callers read of the world beyond its rows and pull requests, by group. */
export type FakeReports = { board: FakeBoard; health: FakeHealth; dora: FakeDora; trace: FakeTrace; messaging: FakeMessaging; snapshot: FakeSnapshot };

export const emptyReports = (): FakeReports => ({ board: emptyBoard(), health: emptyHealth(), dora: emptyDora(), trace: emptyTrace(), messaging: emptyMessaging(), snapshot: emptySnapshot() });

const noProgram = (what: string) => (): never => {
  throw new Error(`the fake code host has no gh: ${what} runs against the GitHub plugin`);
};

export function reportOperations(world: FakeRowsWorld): Pick<CodeHostRows, "command" | "runnerWith" | "asyncRunnerWith"> & ReturnType<typeof boardOperations> & ReturnType<typeof healthOperations> & ReturnType<typeof doraOperations>
  & ReturnType<typeof traceOperations> & ReturnType<typeof messagingOperations> & ReturnType<typeof snapshotOperations> {
  return {
    command: "gh",
    runnerWith: () => noProgram("a runner of the code host's program"),
    asyncRunnerWith: () => noProgram("a runner of the code host's program"),
    ...boardOperations(world), ...healthOperations(world), ...doraOperations(world), ...traceOperations(world), ...messagingOperations(world), ...snapshotOperations(world),
  };
}
