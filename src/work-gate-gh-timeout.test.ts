// no-token: gh -- `gh` is a stub first on PATH that sleeps; the real one is never reached
/**
 * a11ign/a11ign#3737: A `gh` THAT NEVER RETURNS IS CUT AT A BOUND, NAMED, AND REFUSES ITS OWN LANE ONLY.
 *
 * `defaultRun` ran `gh` through `execFileSync` with no `timeout`, so one hung `gh` held the gate until `TimeoutStartSec=600` killed the whole tick,
 * every lane's reads with it. `ghWithin` is the runner `defaultRun` is made of, taking the bound as an argument so a test can use a short one:
 *   (1) THE CONTROL, shown first: a `gh` that sleeps for a minute ends at the bound, throws the `ETIMEDOUT` refusal a reader turns into `null`, and
 *       names the subcommand in one line. Without the bound the same call is still sleeping when the test gives up on it.
 *   (2) the other lanes' reads are intact: a reader whose `gh` hung answers `null`, and the next call, to a `gh` that answers, is read as ever.
 *   (3) the cut is not a way of silencing a fast `gh`: an answer inside the bound is returned, and a refusal that is not a timeout is rethrown unannounced.
 *   (4) the bound is the named constant, and it is the one `wake.mjs`'s `defaultGh` cuts at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GH_READ_TIMEOUT_MS, ghWithin, readPrs } from "./work-gate.mjs";

const BOUND_MS = 400;
const HUNG_FOR_S = 60;
/** What the test allows a cut call: the bound, plus the spawn and the kill, and far under the minute the stub sleeps. */
const SLACK_MS = 5_000;

/** A `gh` first on PATH: `pr list` hangs (`exec`, so the kill reaches the sleeper and not a shell that leaves it holding the pipe), `api` answers, anything else is refused. */
function withStubGh<T>(body: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "gate-gh-timeout-"));
  const outerPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "gh"),
      `#!/bin/sh\ncase "$1 $2" in\n  "pr list") exec sleep ${HUNG_FOR_S} ;;\n  "api repos/o/r/labels") echo '[{"name":"ready"}]' ;;\n  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;\nesac\n`);
    chmodSync(join(dir, "gh"), 0o755);
    process.env.PATH = `${dir}:${outerPath}`;
    return body();
  } finally {
    process.env.PATH = outerPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

const refusalOf = (run: () => unknown): { code?: string, status?: number | null } | undefined => {
  try { run(); } catch (error) { return error as { code?: string }; }
  return undefined;
};

test("(1) THE CONTROL: a `gh` that never returns ends at the bound, throws the timeout refusal, and the call is named", () => {
  withStubGh(() => {
    const told: string[] = [];
    const run = ghWithin(BOUND_MS, { log: (line) => told.push(line) });
    const started = Date.now();
    const refusal = refusalOf(() => run(["pr", "list", "--json", "number"]));
    const tookMs = Date.now() - started;
    assert.equal(refusal?.code, "ETIMEDOUT", "the refusal every reader already turns into `null`");
    assert.ok(tookMs >= BOUND_MS && tookMs < BOUND_MS + SLACK_MS, `ended at the bound, not at the sleeper's minute: ${tookMs} ms`);
    assert.equal(told.length, 1, told.join("|"));
    assert.match(told[0], /^GH CUT in [^:]+: `gh pr list` ran past 0\.4 s and was killed\./);
    assert.ok(!told[0].includes("--json"), "only the two words that name the call, never its arguments");
  });
});

test("(2) the other lanes' reads are intact: a reader whose `gh` hung answers `null` and the next read is made as ever", () => {
  withStubGh(() => {
    const told: string[] = [];
    const run = ghWithin(BOUND_MS, { log: (line) => told.push(line) });
    assert.equal(readPrs(run), null, "the lane whose `gh` hung is a refused read");
    assert.deepEqual(JSON.parse(run(["api", "repos/o/r/labels"])), [{ name: "ready" }], "the next lane's read is made and answered");
    assert.equal(told.length, 1, "one cut told, and the answered read tells nothing");
  });
});

test("(3) the cut does not silence a `gh` that answers, and a refusal that is not a timeout is rethrown untold", () => {
  withStubGh(() => {
    const told: string[] = [];
    const run = ghWithin(BOUND_MS, { log: (line) => told.push(line) });
    assert.equal(run(["api", "repos/o/r/labels"]).trim(), '[{"name":"ready"}]');
    const refusal = refusalOf(() => run(["api", "repos/o/r/nope"]));
    assert.equal(refusal?.status, 1);
    assert.notEqual(refusal?.code, "ETIMEDOUT");
    assert.deepEqual(told, []);
  });
});

test("(4) the bound is the named constant, the one `wake.mjs`'s `defaultGh` cuts a `gh` at", () => {
  const wake = readFileSync(fileURLToPath(new URL("./wake.mjs", import.meta.url)), "utf8");
  const wakeBound = /const defaultGh = [^;]*?timeout: (\d[\d_]*)/s.exec(wake)?.[1];
  assert.ok(wakeBound !== undefined, "positive control: `defaultGh`'s bound was found in wake.mjs");
  assert.equal(GH_READ_TIMEOUT_MS, Number(wakeBound.replaceAll("_", "")));
});
