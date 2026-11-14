// no-token: none -- the fixture's fakes are in memory and its files are in a throwaway directory it removes
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureHost } from "../capture.ts";
import { herdrName } from "../pool.ts";
import { fixtureInstance } from "./fixture-instance.ts";

test("the fixture instance starts from ticket:capture's throwaway host file, inside its own directory, and dispose removes it", () => {
  const fixture = fixtureInstance({ keys: ["FIX-1"] });
  try {
    const written = JSON.parse(readFileSync(join(fixture.dir, "host.json"), "utf8")) as Record<string, unknown>;
    const expected = captureHost({ checkout: join(fixture.dir, "clone"), stateDir: join(fixture.dir, "state"), binDir: join(fixture.dir, "bin"), port: 47_901, uiPort: 47_902, keyPath: join(fixture.dir, "linear-key") });
    assert.deepEqual(written, expected, "the host file is captureHost's, not a copy of it");
    assert.equal(fixture.settings.stateDir, join(fixture.dir, "state"), "the board's state is the throwaway one, read back through the settings reader");
    assert.deepEqual(fixture.settings.clones, { "agent-org": join(fixture.dir, "clone") }, "the one clone is an empty folder of the throwaway directory, never a real checkout");
  } finally {
    fixture.dispose();
  }
  assert.equal(existsSync(fixture.dir), false);
});

test("a run started on the fixture is in a herdr workspace of the fake, and its scripted worker's outcome ends it", async () => {
  const fixture = fixtureInstance({ keys: ["FIX-1"] });
  try {
    await fixture.pass();
    assert.equal(fixture.entry("FIX-1")?.phase, "running");
    assert.equal(fixture.entry("FIX-1")?.pane, "w1:p1");
    fixture.working("FIX-1");
    await fixture.pass(30_000);
    fixture.finish("FIX-1", { kind: "checked", reason: "nothing to change" });
    await fixture.pass(30_000);
    assert.equal(fixture.entry("FIX-1")?.phase, "finished");
    assert.equal(fixture.entry("FIX-1")?.outcome?.kind, "checked");
    assert.equal(fixture.herdr.status.get(herdrName("FIX-1")), "idle");
  } finally {
    fixture.dispose();
  }
});
