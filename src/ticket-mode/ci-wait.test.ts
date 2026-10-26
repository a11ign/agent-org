// no-token: gh -- the hook decides on text; nothing is run
// A11-306: a worker that waits on CI (`gh pr checks … --watch`, `gh run watch`, a `sleep` over a minute) is refused by the Bash hook, with the board waking the run in the message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CI_WAIT_WHY, ciWaitRefusal, LONGEST_SLEEP_SECONDS } from "./ci-wait.ts";
import { toolVerdict } from "./hook.ts";

const verdict = (command: string) => toolVerdict("Bash", { command });
const URL = "https://github.com/a11ign/agent-org/pull/1957";

test("A11-306: `gh pr checks … --watch` is refused by the Bash hook, whatever else the command says", () => {
  for (const command of [
    "gh pr checks --watch",
    "gh pr checks 1957 --watch",
    `gh pr checks ${URL} --watch --interval 30`,
    `gh pr checks --watch ${URL}`,
    `gh pr checks ${URL} --watch=true`,
    `gh -R a11ign/agent-org pr checks 1957 --watch`,
    `gh --repo a11ign/agent-org pr checks 1957 --watch --fail-fast`,
    `cd /work/agent-org && gh pr checks 1957 --watch`,
    `timeout 600 gh pr checks ${URL} --watch`,
    `GH_PAGER=cat gh pr checks ${URL} --watch`,
    `gh pr checks ${URL} --watch | tee checks.log`,
    `until gh pr checks 1957 --watch; do sleep 5; done`,
    `(gh pr checks 1957 --watch)`,
    `/usr/bin/gh pr checks 1957 --watch`,
    `timeout -s KILL 600 gh pr checks 1957 --watch`,
    `timeout --kill-after=5 600 gh pr checks 1957 --watch`,
    `gh pr checks 1957 --watch > checks.log 2>&1`,
    `gh pr create --draft --title t --body 'closes the gap'; gh pr checks 1957 --watch`,
  ]) {
    const refused = verdict(command);
    assert.equal(refused.code, 2, command);
    assert.match(refused.say[0], /gh pr checks --watch waits on CI: the board watches the checks and the review, and wakes this run/, command);
  }
});

test("A11-306: `gh run watch` is refused by the Bash hook", () => {
  for (const command of ["gh run watch", "gh run watch 40382975143", "gh run watch 40382975143 --exit-status", "gh -R a11ign/agent-org run watch 1", "nohup gh run watch 7 &", "/opt/bin/gh run watch 7"]) {
    const refused = verdict(command);
    assert.equal(refused.code, 2, command);
    assert.match(refused.say[0], /gh run watch waits on CI: the board watches the checks and the review, and wakes this run/, command);
  }
});

test("A11-306: a `sleep` over 60 seconds is refused by the Bash hook, however its duration is written", () => {
  for (const command of ["sleep 61", "sleep 120", "sleep 300 && gh pr checks 1", "sleep 2m", "sleep 1.5m", "sleep 1h", "sleep 30 31", "sleep 1m 1s", "sleep 60.5", "sleep infinity",
    "for i in 1 2 3; do sleep 90; done", "while true; do gh pr checks 1; sleep 120; done", "echo waiting; sleep 600",
    "sleep 300 2>&1", "sleep 300 > /dev/null", "sleep 300 2>/dev/null &", "sleep 300 # wait for the checks", "/bin/sleep 300", "timeout -s KILL 900 sleep 300"]) {
    const refused = verdict(command);
    assert.equal(refused.code, 2, command);
    assert.match(refused.say[0], /a sleep over 60 s waits on CI: the board watches the checks and the review, and wakes this run with a new round on a red required check and on review feedback/, command);
  }
});

test("A11-306: the refusal says the board wakes the run, and tells the worker to push, write the outcome and end", () => {
  const { say } = verdict("gh pr checks 1957 --watch");
  assert.ok(say[0].includes(CI_WAIT_WHY));
  assert.match(say[0], /wakes this run with a new round on a red required check and on review feedback: push, write the outcome file and end your turn instead of waiting on CI/);
  assert.match(say[0], /: gh pr checks 1957 --watch$/, "and names the command, as the other refusals do");
});

test("A11-306: POSITIVE CONTROL: reading CI once, a short pause, and a Monitor's poll on a process are not waits on CI", () => {
  for (const command of [
    "gh pr checks 1957",
    `gh pr checks ${URL} --json name,state,link`,
    "gh pr view 1957 --json mergeable,mergeStateStatus",
    "gh run view 40382975143 --log-failed",
    "gh run list --limit 5",
    "sleep 5",
    "sleep 60",
    "sleep 1m",
    "sleep 0.5 && echo ok",
    "sleep 30 30",
    "until ! kill -0 4242; do sleep 5; done",
    "sleep $WAIT",
    "sleep $((N * 60))",
    "grep -rn 'gh run watch' src",
    `git commit -m "docs: a worker that runs gh pr checks 1957 --watch is refused"`,
    `echo "do not sleep 300"`,
    "git push -u origin admin/a11-306-end-at-the-push",
    // Text that only mentions a wait: a pull request body, a reply and a heredoc quote the commands the hook refuses.
    "gh pr create --draft --body 'The hook refuses `gh run watch` and `gh pr checks 1 --watch`.'",
    `gh pr comment 1957 --body "the worker does not \`sleep 300\` or run gh run watch"`,
    "cat > notes.md <<'EOF'\nsleep 120\ngh run watch 5\nEOF",
    "cat <<EOF | gh pr comment 1957 --body-file -\nan old worker ran: gh pr checks 1957 --watch\nEOF",
    "sleep 5 2>&1",
    "echo ok # sleep 300",
    "echo sleep 300 > notes.txt",
  ]) {
    assert.equal(verdict(command).code, 0, command);
  }
});

test("A11-306: only a sleep over the limit is a wait, so the limit is a minute", () => {
  assert.equal(LONGEST_SLEEP_SECONDS, 60);
  assert.equal(ciWaitRefusal("sleep 60"), null);
  assert.notEqual(ciWaitRefusal("sleep 61"), null);
  assert.equal(ciWaitRefusal("sleep 1m"), null);
  assert.notEqual(ciWaitRefusal("sleep 61s"), null);
});
