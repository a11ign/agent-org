// no-token: none -- pure: `readOpenRows` over the fake code host's rows and a fake REST `ask`; nothing reaches `gh` or the network (A11-160, step 6)
/**
 * agent-org#1624: EVERY WAY THE OPEN ROWS COME BACK `null` SAYS WHY ON STDERR, IN THE SAME TICK THAT PRINTS `NO claim was evaluated`.
 *
 * THE READING, 2026-10-15/16: three of the six `claim-stall: the open rows could not be read` ticks of the first whole day of #1401 carried no `NOTE:` line,
 * so the journal named no cause. The one branch of `readOpenRows` that returns `null` and writes nothing is an answer that PARSES but is not a list: the
 * `Array.isArray(parsed) ? parsed : null` at the end of `readOpenRowsAsListed`. A throw is already said, with gh's reason. A `null` is still read as refused
 * (`NO claim was evaluated`): this test changes only what is SAID about it.
 *
 * THE POSITIVE CONTROL is the last test: a list answer is returned, and nothing is said. The negative differs from it by ONE fact (the shape of the answer), so
 * a silent `null` from the list path cannot pass by accident. The conditional read (`gh.restConditional`) reaches the same branch through its own read of the
 * listing; its refusal is said first, and the answer after it is said too.
 *
 * SINCE A11-160 (step 6) THE LIST IS THE CODE HOST'S `openRowsOf`, and these cases run on the fake code host's rows (`world.failures` refuses the read by name): what the gate SAYS about a read that was refused is held
 * here, and what the GitHub plugin makes of an answer that parses but is not a list (the error that carries the answer's first 120 characters) is held beside the operation
 * (`plugins/github/rows/open-rows-reads.test.ts`, moved from the first case).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { readOpenRows } from "./reads.ts";

afterEach(() => forgetActivation());

/** The fake code host in place; its `world` is the one whose reads a test refuses by name. */
function codeHost() {
  const host = createFakeCodeHost();
  substituteCodeHost(host);
  return host.rowsWorld;
}

const NO_HOME = { home: false, webhook: false };

/** What `process.stderr` received while `run` ran, and what `run` returned. */
function stderrOf<T>(run: () => T): { value: T; said: string; } {
  const captured: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { captured.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    return { value: run(), said: captured.join("") };
  } finally {
    process.stderr.write = write;
  }
}

test("agent-org#1624: an open-rows read that was refused with an answer that is not a list is read as refused AND says why, with the reason's first line", () => {
  for (const answer of ["null", "{}", "{\"message\":\"Not Found\"}", "\"text\""]) {
    codeHost().failures.set("openRowsOf", new Error(`the answer was not a list: ${JSON.stringify(answer)}\nmore`));
    const read = stderrOf(() => readOpenRows(undefined, null, NO_HOME));
    assert.equal(read.value, null, `read as refused for ${answer}`);
    assert.equal(read.said, `NOTE: the open rows could not be read (the answer was not a list: ${JSON.stringify(answer)}); read as refused\n`, `said for ${answer}`);
  }
});

test("agent-org#1624: a refused open-rows call still says gh's reason (the path that was already said)", () => {
  codeHost().failures.set("openRowsOf", new Error("HTTP 502: Bad Gateway\nmore"));
  const refused = stderrOf(() => readOpenRows(undefined, null, NO_HOME));
  assert.equal(refused.value, null);
  assert.equal(refused.said, "NOTE: the open rows could not be read (HTTP 502: Bad Gateway); read as refused\n");
});

test("agent-org#1624: the conditional read says its own refusal, and the listed read that follows says its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-rows-null-said-"));
  try {
    codeHost().failures.set("openRowsOf", new Error("the answer was not a list: \"{}\""));
    const conditional = { ask: () => { throw new Error("HTTP 502: Bad Gateway\nmore"); }, dir, now: 1_000, repo: "a11ign/agent-org" };
    const read = stderrOf(() => readOpenRows(undefined, conditional, NO_HOME));
    assert.equal(read.value, null);
    assert.match(read.said, /^NOTE: the conditional read of a11ign\/agent-org's open rows failed \(HTTP 502: Bad Gateway\); read as the gate always has\n/);
    assert.match(read.said, /NOTE: the open rows could not be read \(the answer was not a list: "\{\}"\); read as refused\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent-org#1624 RED CONTROL: a list answer is returned and nothing is said", () => {
  codeHost();
  const answered = stderrOf(() => readOpenRows(undefined, null, NO_HOME));
  assert.deepEqual(answered.value, []);
  assert.equal(answered.said, "");
});
