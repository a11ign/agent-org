// A test-support module (A11-160, step 9, part B): the messaging readers' `github` (what `readLastMerge`, `observeReleases`' caller and the milestones' reader call `api(path)` on) as the REAL reader of the watch
// (`createGhReader`) over the fake code host's world. A test SEEDS the REST documents the world holds, by exact path (`world.reports.messaging.rest`; a path seeded with an `Error` is a read GitHub refuses, for that path
// alone) or lets the fake model them from the rows and pull requests it holds, and asserts on what the readers decide and on the paths the code host was asked for (`calls`). Nothing here answers an argument list: the
// fake's operations ignore the `run` the reader hands them, and the plugin's own tests hold how `gh api <path>` is built and read. The host is put back before every read, so two of these can live in one case.
import { substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { FakeRowsWorld } from "../plugins/fakes/code-host-rows.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";
import { createGhReader } from "./watch.ts";

export type RestDocuments = Record<string, unknown>;

export function githubOverWorld(documents: RestDocuments = {}, seed: (world: FakeRowsWorld) => void = () => undefined) {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = "example/project";
  const seeded = host.rowsWorld.reports.messaging.rest;
  const hold = (more: RestDocuments): void => { for (const [path, document] of Object.entries(more)) seeded.set(path, document); };
  hold(documents);
  seed(host.rowsWorld);
  const watched = watchedRows(host);
  const reader = createGhReader();
  substituteCodeHost(watched.host);
  return {
    world: host.rowsWorld,
    /** Seeds (or replaces) documents by exact path. */
    hold,
    /** The `Github` the readers take: the real reader, over this world. */
    api: (path: string): Promise<any> => { substituteCodeHost(watched.host); return reader.api(path); },
    /** The REST paths the code host was asked for, in order. */
    get calls(): string[] { return watched.calls.filter(({ op }) => op === "restGetAsync").map(({ request }) => request.path as string); },
  };
}
