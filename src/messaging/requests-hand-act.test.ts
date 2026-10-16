// THE HAND-ACT REFUSAL (a11ign/a11ign#4405; agent-org#1566). A brief whose `Ask:` or a `Steps:` item sends the chairman to a worker's console is refused,
// unless it shows the Ansible route was run and how it failed. The ceo brief of 2026-10-15T21:15Z asked him to press "Restart now" on worker 15 and was
// sent like any other, because `requestEvent` read nothing about WHAT the ask was.
//
// POSITIVE CONTROLS: every refusal below sits beside the same brief with the Ansible line, or with the worker taken out, which IS sent. So "nothing sent"
// cannot be a check that never reads its brief. Control (a) and (e) fail on `main`, where the brief is sent.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { observeRequests, requestEvent } from "./sources/requests.ts";

const REPO = "a11ign/agent-org";
const NOW = Date.parse("2026-10-16T09:00:00Z");

const WHAT = "What is happening: worker 15 is off and the capture is waiting on it";
const ONLY_YOU = "Only you because: the restart is a button on the box";
const CHECKED = "Checked: 09:00Z, the Ansible play was not run";
const HOW_LONG = "How long: two minutes";
const UNBLOCKS = "Unblocks: the 10:00 capture";
const NOT_HIS_CLAUDE = "Not the chairman's Claude session because: the button is on a box in his house";
const REQUIRED = [WHAT, ONLY_YOU, CHECKED, HOW_LONG, UNBLOCKS, NOT_HIS_CLAUDE];
const ANSIBLE = "Ansible tried: patch.yml -l a11y-worker-15, failed: https://github.com/a11ign/agent-org/issues/4405#issuecomment-1";

/** A brief from an org account whose lines are `lines`, in the order given. */
function brief(...lines: string[]) {
  return { body: ["**ceo — BRIEF for the chairman: bring worker 15 back.**", ...lines].join("\n"), createdAt: "2026-10-16T08:30:00Z", authorAssociation: "MEMBER" };
}

/** The row a brief sits on, numbered 1566 so the test reads like the row it proves. */
function row(comments: { body: string; createdAt: string; authorAssociation: string; }[]) {
  return { number: 1566, title: "a brief", url: `https://github.com/${REPO}/issues/1566`, comments };
}

/** The event for one brief, through `requestEvent` (what the watcher and `correct.ts` both call). */
function decide(...lines: string[]) {
  return requestEvent({ repo: REPO, row: row([brief(...lines)]), now: NOW });
}

describe("(a) an Ask that sends him to a worker by hand, with no Ansible route, is refused and not sent", () => {
  test("press Restart now on worker 15 is refused: the problem begins `alert not sent:` and nothing is sent", () => {
    const { event, problem } = decide(`Ask: press Restart now on worker 15`, ...REQUIRED);
    assert.equal(event, null);
    assert.match(String(problem), /^alert not sent:/);
  });

  test("the same verbs on a worker named the other ways are each refused: `worker-15`, `a11y-worker-15`, `worker 15`", () => {
    for (const ask of [
      "Ask: click the Restart button on a11y-worker-15",
      "Ask: restart worker-15 by hand",
      "Ask: power worker 15 on at the box",
      "Ask: log in to worker 15 and start the service",
      "Ask: look at the console of worker 15 and tell me what the screen says",
    ]) {
      const { event, problem } = decide(ask, ...REQUIRED);
      assert.equal(event, null, `${ask} must be refused`);
      assert.match(String(problem), /^alert not sent:/, ask);
    }
  });

  test("a refusal is not a brief that is silently dropped: the watcher is told it names the Ansible route", () => {
    const { problem } = decide(`Ask: press Restart now on worker 15`, ...REQUIRED);
    assert.match(String(problem), /Ansible/);
  });
});

describe("(e) the refusal names the rule's source and what to do instead", () => {
  test("it cites a11ign#4405 and says to file an Ansible row, and names the line that would clear it", () => {
    const { problem } = decide(`Ask: press Restart now on worker 15`, ...REQUIRED);
    assert.match(String(problem), /a11ign\/a11ign#4405/);
    assert.match(String(problem), /file an Ansible row/);
    assert.match(String(problem), /Ansible tried: <playbook> -l <worker>, failed: <log path or comment url>/);
  });
});

describe("(b) the same brief with its Ansible line is sent", () => {
  test("an Ansible line that names the run and its failure clears the refusal", () => {
    const { event, problem } = decide(`Ask: press Restart now on worker 15`, ANSIBLE, ...REQUIRED);
    assert.notEqual(event, null, "the chairman is asked");
    assert.equal(problem, null);
  });

  test("an Ansible line that names a run but not its failure is not the route shown, so it is refused", () => {
    const { event, problem } = decide(`Ask: press Restart now on worker 15`, "Ansible tried: patch.yml -l a11y-worker-15", ...REQUIRED);
    assert.equal(event, null);
    assert.match(String(problem), /^alert not sent:/);
  });
});

describe("(c) a worker named in a decision, with no hand act, is sent unchanged", () => {
  test("which build worker 15 should converge on is a decision and is sent", () => {
    const { event, problem } = decide(`Ask: decide which build worker 15 should converge on`, ...REQUIRED);
    assert.notEqual(event, null);
    assert.equal(problem, null);
  });
});

describe("(d) a hand act that names no worker, on the chairman's own machine, is sent unchanged", () => {
  test("a login on his own laptop is sent: the rule is about WORKERS and not every hand act", () => {
    const { event, problem } = decide(`Ask: log in to the Claude browser on your laptop and approve the site`, ...REQUIRED);
    assert.notEqual(event, null);
    assert.equal(problem, null);
  });
});

describe("the Ask is read, not the context around it", () => {
  test("a What-is-happening line that says a worker was pressed or restarted does not refuse a brief whose Ask sends him nowhere", () => {
    const context = "What is happening: worker 15 was restarted by the watchdog and then pressed by no one";
    const { event, problem } = decide(`Ask: decide whether to keep the 10:00 capture`, context, ...REQUIRED.slice(1));
    assert.notEqual(event, null);
    assert.equal(problem, null);
  });
});

describe("a procedure is read step by step: a step that sends him to a worker is refused, and one that does not is sent", () => {
  test("a step that presses a button on worker 15 refuses the walk", () => {
    const { event, problem } = decide(`Ask: bring worker 15 back`, "Steps:", "1. Press Restart now on worker 15.", ...REQUIRED);
    assert.equal(event, null);
    assert.match(String(problem), /^alert not sent:/);
  });

  test("the same walk with the Ansible line is sent, and its first step is what the chairman reads", () => {
    const { event, problem } = decide(`Ask: bring worker 15 back`, ANSIBLE, "Steps:", "1. Press Restart now on worker 15.", ...REQUIRED);
    assert.notEqual(event, null);
    assert.equal(problem, null);
  });

  test("a step that names no worker is sent", () => {
    const { event, problem } = decide(`Ask: check the Ansible controller`, "Steps:", "1. Press Save in the playbook editor on your laptop.", ...REQUIRED);
    assert.notEqual(event, null);
    assert.equal(problem, null);
  });
});

describe("the watcher records the refusal once, as a problem of the observed tick", () => {
  test("a refused brief yields no event, and its reason is in `problems` under its request key", () => {
    const { events, problems } = observeRequests({ repo: REPO, rows: [row([brief(`Ask: press Restart now on worker 15`, ...REQUIRED)])], openKeys: [], now: NOW });
    assert.deepEqual(events, []);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].key, `request:${REPO}#1566`);
    assert.match(problems[0].reason, /^alert not sent:/);
  });
});
