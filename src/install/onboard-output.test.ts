// no-token: none -- the output is a list of lines the test collects; no terminal is written to
import { test } from "node:test";
import assert from "node:assert/strict";
import { onboardOutput } from "./onboard-output.ts";

function output(options: { verbose?: boolean; color?: boolean } = {}) {
  const lines: string[] = [];
  return { lines, say: onboardOutput({ log: (line: string) => lines.push(line) }, { verbose: false, color: false, ...options }) };
}

test("a step that passed is one ✓ line, and its details show only with --verbose", () => {
  const quiet = output();
  quiet.say.done("Linear connected as the tracker", "installed linear as the tracker");
  assert.deepEqual(quiet.lines, ["  ✓ Linear connected as the tracker"]);
  const verbose = output({ verbose: true });
  verbose.say.done("Linear connected as the tracker", "installed linear as the tracker", "", "a second detail");
  assert.deepEqual(verbose.lines, ["  ✓ Linear connected as the tracker", "    installed linear as the tracker", "    a second detail"], "an empty detail is not a line");
});

test("a step that failed is a ✗ line with its fix indented beneath it, every line of it", () => {
  const { lines, say } = output();
  say.failed("GitHub stacked pull requests are not set up", "could not reach github.com.\nRun `gh extension install github/gh-stack`, then `agent-org doctor`.");
  assert.deepEqual(lines, ["  ✗ GitHub stacked pull requests are not set up", "    could not reach github.com.", "    Run `gh extension install github/gh-stack`, then `agent-org doctor`."]);
  const bare = output();
  bare.say.failed("It failed", "");
  assert.deepEqual(bare.lines, ["  ✗ It failed"], "no empty fix line");
});

test("each ✗ is counted, except a line that points at one already counted", () => {
  const { say } = output();
  assert.equal(say.failures(), 0);
  say.failed("one", "fix");
  say.failed("two", "fix");
  say.failedAbove("two again");
  say.done("fine");
  assert.equal(say.failures(), 2);
  const { lines, say: pointing } = output();
  pointing.failedAbove("Linear connected as the tracker");
  assert.deepEqual(lines, ["  ✗ Linear connected as the tracker", "    Fix the step above, then run `agent-org onboard` again."]);
});

test("a warning is a ! line with its fix, and is not counted", () => {
  const { lines, say } = output();
  say.warning("ui build: no build is installed", "run `pnpm ui:build`");
  assert.deepEqual(lines, ["  ! ui build: no build is installed", "    run `pnpm ui:build`"]);
  assert.equal(say.failures(), 0);
});

test("a note is always shown and a detail only with --verbose", () => {
  const quiet = output();
  quiet.say.note("Connect to Linear");
  quiet.say.detail("gh repo clone a11ign/lab ~/repos/lab");
  assert.deepEqual(quiet.lines, ["Connect to Linear"]);
  const verbose = output({ verbose: true });
  verbose.say.detail("gh repo clone a11ign/lab ~/repos/lab");
  assert.deepEqual(verbose.lines, ["gh repo clone a11ign/lab ~/repos/lab"]);
  assert.equal(verbose.say.verbose, true);
});

test("the marks are green and red on a terminal that wants colour, the outcome is bold, and plain text otherwise", () => {
  const coloured = output({ color: true });
  coloured.say.done("fine");
  coloured.say.failed("broken", "fix");
  coloured.say.succeeded("agent-org is set up on this machine.");
  coloured.say.incomplete("agent-org is not fully set up: 1 step above needs fixing.");
  assert.deepEqual(coloured.lines, ["  \x1b[32m✓\x1b[0m fine", "  \x1b[31m✗\x1b[0m broken", "    fix", "\x1b[1m\x1b[32magent-org is set up on this machine.\x1b[0m", "\x1b[1m\x1b[31magent-org is not fully set up: 1 step above needs fixing.\x1b[0m"]);
  const plain = output();
  plain.say.done("fine");
  plain.say.succeeded("agent-org is set up on this machine.");
  assert.deepEqual(plain.lines, ["  ✓ fine", "agent-org is set up on this machine."]);
  assert.ok(!plain.lines.join("").includes("\x1b"), "no escape sequence without colour");
});
