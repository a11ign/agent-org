// A11-272: whether the board's queue holds a run parked on a ticket wait, or a wait cycle -- the ticket's After-merge check, runnable on a queue read from a live board or on a fixture.
//
//   curl -s <the instance>/api/queue | node scripts/check-wait-state.ts
//   node scripts/check-wait-state.ts queue.json
//
// The queue is `GET /api/queue`'s answer (an object with `entries`) or the entries alone. Prints one sentence for each problem and exits 1; prints that the waits are clean and exits 0 when there is none.
// It reads nothing else and changes nothing.
import { readFileSync } from "node:fs";
import { waitStateProblems } from "../src/ticket-mode/board-view/wait-state.ts";
import type { ViewEntry } from "../src/ticket-mode/board-view/view-types-and-filters.ts";

const STDIN = 0;
const read = JSON.parse(readFileSync(process.argv[2] ?? STDIN, "utf8")) as { entries?: ViewEntry[] } | ViewEntry[];
const entries = Array.isArray(read) ? read : (read.entries ?? []);
const problems = waitStateProblems(entries);
console.log(problems.length === 0 ? `the waits are clean: ${entries.length} runs, none parked on a ticket wait, no wait cycle` : problems.join("\n"));
process.exit(problems.length === 0 ? 0 : 1);
