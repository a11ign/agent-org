// no-token: gh -- pure: `readOpenRows` over a fake `run` and a fake REST `ask`; nothing reaches `gh` or the network
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
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readOpenRows } from "./reads.ts";

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

test("agent-org#1624: an open-rows answer that is not a list is read as refused AND says why, with the answer's first 120 characters", () => {
  for (const answer of ["null", "{}", "{\"message\":\"Not Found\"}", "\"text\""]) {
    const read = stderrOf(() => readOpenRows(() => answer, null, NO_HOME));
    assert.equal(read.value, null, `read as refused for ${answer}`);
    assert.equal(read.said, `NOTE: the open rows could not be read (the answer was not a list: ${JSON.stringify(answer)}); read as refused\n`, `said for ${answer}`);
  }
  // THE CUT: a long answer is named by its first 120 characters, not whole
  const long = `{"message":"${"x".repeat(200)}"}`;
  const cut = stderrOf(() => readOpenRows(() => long, null, NO_HOME));
  assert.equal(cut.value, null);
  assert.equal(cut.said, `NOTE: the open rows could not be read (the answer was not a list: ${JSON.stringify(long.slice(0, 120))}); read as refused\n`);
});

test("agent-org#1624: a refused open-rows call still says gh's reason (the path that was already said)", () => {
  const refused = stderrOf(() => readOpenRows(() => { throw new Error("HTTP 502: Bad Gateway\nmore"); }, null, NO_HOME));
  assert.equal(refused.value, null);
  assert.equal(refused.said, "NOTE: the open rows could not be read (HTTP 502: Bad Gateway); read as refused\n");
});

test("agent-org#1624: the conditional read says its own refusal, and the listed read that follows says its non-list answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-rows-null-said-"));
  try {
    const conditional = { ask: () => { throw new Error("HTTP 502: Bad Gateway\nmore"); }, dir, now: 1_000, repo: "a11ign/agent-org" };
    const read = stderrOf(() => readOpenRows(() => "{}", conditional, NO_HOME));
    assert.equal(read.value, null);
    assert.match(read.said, /^NOTE: the conditional read of a11ign\/agent-org's open rows failed \(HTTP 502: Bad Gateway\); read as the gate always has\n/);
    assert.match(read.said, /NOTE: the open rows could not be read \(the answer was not a list: "\{\}"\); read as refused\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent-org#1624 RED CONTROL: a list answer is returned and nothing is said", () => {
  const answered = stderrOf(() => readOpenRows(() => "[]", null, NO_HOME));
  assert.deepEqual(answered.value, []);
  assert.equal(answered.said, "");
});
