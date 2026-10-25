// @ts-check
// module: what the board has asked the ticket writer for on a dependency update's behalf, in one file (A11-255)
//
// `dependency-tickets.json` in the board's tickets directory, replaced whole by rename as the queue is. `tickets` maps a key (`majorKey`, `redGroupKey`) to where its request is: `requested` (a writer run was queued and has not
// ended), `filed` (the run made a ticket), or `failed` (it made none). A key in the file is never requested again, except a `failed` one, which is asked again after a wait and a few times only. `reruns` maps a pull request
// to the head whose failed checks were rerun once, so a red head is rerun once and the second red files. To let a ticket be requested again, delete its entry from the file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A request the writer has not finished. `attempts` counts the runs that ended making no ticket before this one. */
export type Requested = Readonly<{ state: "requested"; writerRun: string; at: number; attempts: number }>;
/** A request that made a ticket: its key, whether the board is to queue it (a run that made exactly one, ending well), and whether it has. */
export type Filed = Readonly<{ state: "filed"; ticket: string; queue: boolean; queued: boolean }>;
/** A request whose run ended making no ticket, why, when, and how many runs have. */
export type Failed = Readonly<{ state: "failed"; attempts: number; at: number; reason: string }>;
export type Entry = Requested | Filed | Failed;

export type DependencyState = { tickets: Record<string, Entry>; reruns: Record<string, string> };

export const emptyState = (): DependencyState => ({ tickets: {}, reruns: {} });

/** The state on disk, or an empty one when there is no file. A file that cannot be read THROWS: reading it as empty would ask for every ticket again. */
export function loadState(path: string): DependencyState {
  if (!existsSync(path)) return emptyState();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { tickets?: DependencyState["tickets"]; reruns?: DependencyState["reruns"] } | null;
  const { tickets, reruns } = parsed ?? {};
  if (!isObject(tickets)) throw new Error(`${path} is not a dependency ticket record`);
  return { tickets, reruns: isObject(reruns) ? reruns : {} };
}

/** Whether `value` is an object, which is all the file's two maps are checked for: their entries are the board's own writes. */
const isObject = <Held extends object>(value: Held | undefined): value is Held => typeof value === "object" && value !== null;

/** Replace the file whole: write beside it, then rename over it. */
export function saveState(path: string, state: DependencyState): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(next, path);
}
