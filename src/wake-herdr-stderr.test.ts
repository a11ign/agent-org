// no-token: herdr -- every probe here runs a stub `herdr` put first on PATH in a child process; the real herdr is never reached
/**
 * agent-org#1487: A PROBE OF AN ENDED SEAT WRITES NOTHING TO THE TICK'S JOURNAL, AND ANY OTHER REFUSAL STILL DOES.
 *
 * `herdr` answers `agent_not_found` / `pane_not_found` for every seat that has ended, and every caller reads that as gone. The runner used to
 * inherit the tick's stderr, so each such answer was written to the journal once per probe per tick. These tests run the REAL runner in a child
 * process, so the child's stderr stands for the tick's, and the stub `herdr` stands for the real one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERDR_AGENTS = pathToFileURL(fileURLToPath(new URL("./herdr-agents.ts", import.meta.url))).href;

/** The child: `readAgents()` through its default runner, or `herdrRun` with its thrown error printed, so the test can read what rode on it. */
const DRIVER = `
import { herdrRun, readAgents } from ${JSON.stringify(HERDR_AGENTS)};
if (process.argv[2] === "thrown") {
  try { herdrRun(["--session", "org", "agent", "get", "worker-1"]); } catch (err) { process.stdout.write(String(err.stderr)); }
} else {
  process.stdout.write(JSON.stringify(readAgents()));
}
`;

/** Runs the driver in `mode` with a stub `herdr` that answers `body` on stderr and exits 1, as a refused probe does. */
function probe(mode: "listing" | "thrown", body: string) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-stderr-"));
  try {
    writeFileSync(join(dir, "herdr"), `#!/bin/sh\nprintf '%s\\n' '${body}' >&2\nexit 1\n`);
    chmodSync(join(dir, "herdr"), 0o755);
    writeFileSync(join(dir, "driver.mts"), DRIVER);
    const child = spawnSync(process.execPath, [join(dir, "driver.mts"), mode], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const code of ["agent_not_found", "pane_not_found"]) {
  test(`an ended seat's ${code} is not written to the tick's stderr`, () => {
    const body = JSON.stringify({ error: { code, message: "not found" } });
    const tick = probe("listing", body);
    assert.equal(tick.status, 0, tick.stderr);
    assert.equal(tick.stdout, "null", "the caller reads the refused probe as no listing");
    assert.equal(tick.stderr, "", `the tick's stderr must stay empty, got: ${tick.stderr}`);
  });
}

test("the refusal rides on the thrown error, so callers that read it still do", () => {
  const body = JSON.stringify({ error: { code: "agent_not_found", message: "agent target worker-1 not found" } });
  const tick = probe("thrown", body);
  assert.equal(tick.status, 0, tick.stderr);
  assert.match(tick.stdout, /agent_not_found/);
  assert.equal(tick.stderr, "");
});

test("a refusal other than 'gone' is still written to the tick's stderr", () => {
  const body = JSON.stringify({ error: { code: "agent_blocked", message: "agent is blocked" } });
  const tick = probe("listing", body);
  assert.equal(tick.status, 0, tick.stderr);
  assert.equal(tick.stdout, "null");
  assert.match(tick.stderr, /agent_blocked/, "a refusal that is not 'gone' must still reach the journal");
});
