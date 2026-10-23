// A test-support module (A11-160, step 8): the fake code host in place for the tests of the chairman's watch and answers. `messagingHost(repo, seed)` makes the fake code host, points its tracker at `repo`, lets the test SEED
// its world (rows, pull requests, runs, releases: `fakeRow`, `fakeRowPull`, `world.reports.messaging`), WATCHES its rows (`calls`: every operation asked, with the request) and puts it where core finds it. A test calls
// `forgetActivation()` after each case. `noGh` is the `gh` such a test hands a caller that wants one: the fake's operations ignore it, so it fails the case if anything runs it.
import type { AsyncRowsRun } from "../contracts/code-host-rows-facts.ts";
import { substituteCodeHost } from "../active.ts";
import { createFakeCodeHost } from "./code-host.ts";
import type { FakeRowsWorld } from "./code-host-rows.ts";
import { watchedRows } from "./watched-rows.test.support.ts";

export { forgetActivation } from "../active.ts";
export { fakeRow, type FakeRowsWorld } from "./code-host-rows.ts";
export { fakeRowPull } from "./code-host-messaging.ts";

export function messagingHost(repo: string, seed: (world: FakeRowsWorld) => void = () => undefined) {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = repo;
  seed(host.rowsWorld);
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  return { world: host.rowsWorld, calls: watched.calls };
}

export const noGh: AsyncRowsRun = async (argv) => {
  throw new Error(`gh was run: ${argv.join(" ")}`);
};
