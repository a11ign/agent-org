// no-token: none -- a fixture for tests that file a whole row on the fake code host; it spawns nothing and reaches nothing
// A11-160, step 9: THE WORLD A WHOLE `createIssue` FILING RUNS ON. A filing reads the milestones of the tracker, files through the injected `spawnGh` (which answers a URL naming row #900), then boards that row, labels it
// and reads it back; on the fake code host each of those is the world's, so the world has to hold row #900 and the milestone the filing names. The tests that file a row end to end (the blast radius's wiring, the sweep
// window's) seed it here, once, instead of answering GitHub's text for each command.
import { fakeRow, type FakeRowsWorld } from "../../plugins/fakes/code-host-rows.ts";

/** The trackers a filing may land in: the tracker a filing lands in is the one its Region names, and the project the tests run against declares these two. */
const TRACKERS = ["a11ign/a11ign", "a11ign/agent-org"];

/** A `run` for a filing on the fake code host: every operation the filing asks acts on the host's world, so no program is ever run. */
export const noProgram = (_cmd: string, args: string[]): string => { throw new Error(`the fake code host answers; no program is run (${args.join(" ")})`); };

/** Row #900, the one `spawnGh` answers, reads back from `world` as `body` and carries the milestone `CI reset`, which exists in every tracker a filing may land in. */
export function seedFiledRow(world: FakeRowsWorld, body: string): void {
  const filed = fakeRow(world, 900, { body });
  world.rows.set(900, filed); // the board add and the Status move are the world's, which holds its own repository's rows
  for (const repo of TRACKERS) {
    world.filing.milestones.set(repo, [{ title: "CI reset" }]);
    world.filing.rowMilestones.set(`${repo}#900`, "CI reset");
    world.foreignRows.set(`${repo}#900`, filed);
  }
}
