// no-token: gh -- every `gh` here is a fake first on PATH that keeps its state in a JSON file, and no test lets the real one run.
/**
 * A HOLD THAT WAITS FOR A ROW NOBODY IS WORKING NEVER ENDS, SO THE TAKE REFUSES IT, AND A HOLD ALREADY IN FORCE IS AN INCIDENT AFTER 15 MINUTES (#4661, class
 * `hold-on-idle-row`, chairman).
 *
 * THE INCIDENT (2026-10-09): agent-org#550 was green and APPROVED and was held `--until closed a11ign/a11ign#4524` under "the chairman row lands first". #4524 was
 * `ready` and UNCLAIMED with no pull request, so nothing could ever close it; the chairman's session lifted the hold by hand. `untilOf` checks the GRAMMAR of
 * `--until` and nothing asked whether the condition could come true.
 *
 * THE POSITIVE CONTROLS are the non-empty cases every refusal is read against: the same hold on the same row IS taken once the row carries `in-progress`, a
 * `session:` label or an open pull request, and the same line with `manual` is taken. Without them "nothing was written" passes for a command that writes
 * nothing anywhere. The CLI half drives the real `pr-hold.ts` against a fake `gh` and reads its call log, because "the label call is never reached" is a
 * claim about calls, which a unit test of the decision cannot make.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { holdTargetIdleReason, idleHoldIncident, IDLE_HOLD_MINUTES, IDLE_HOLD_CLASS } from "../pr-hold-state.ts";
import type { HoldTarget, PullRequestRef } from "../pr-hold-state.ts";
import { parseWaits, WAIT_MARKER } from "../wait-condition.ts";
import { HOME_CHECKOUT, PROJECT_DECLARATION_PATH } from "../project-config.ts";

const EXECUTABLE = 0o755;
const FIRST = "a11ign/a11ign";
const KEYED = "a11ign/agent-org";
const CLI = fileURLToPath(new URL("../pr-hold.ts", import.meta.url));
const MINUTE = 60_000;
const NOW = Date.parse("2026-10-09T22:00:00Z");

// --- the decision: pure, facts in and a reason out ----------------------------------------------------------------------------------------

const waitOf = (value: string) => parseWaits(`Waiting-for: ${value}`)[0];
const target = (value: string, fact: Partial<HoldTarget["fact"]> = {}): HoldTarget => ({
  wait: waitOf(value), fact: { state: "open", labels: ["ready", "lane:any"], resolvedAt: null, changedAt: null, ...fact } });
const NO_PULL_REQUESTS: PullRequestRef[] = [];
const A_PULL_REQUEST: PullRequestRef[] = [{ number: 518, repo: KEYED }];

test("POSITIVE CONTROL: the #4524 fixture (open, `ready`, no claim, no pull request) has a reason, and it names the row and what is missing", () => {
  const reason = holdTargetIdleReason(target(`closed ${FIRST}#4524`), { openPullRequests: NO_PULL_REQUESTS });
  assert.ok(reason !== null, "the one case the rule exists for must read as idle, or every `null` below is a rule that never fires");
  assert.match(reason, /a11ign\/a11ign#4524 is OPEN, nobody holds it/);
  assert.match(reason, /no open pull request closes it/);
});

test("a claim, or an open pull request, is not idle: `in-progress`, a `session:` label (alone), and a closing pull request each read null", () => {
  const closed = `closed ${FIRST}#4524`;
  assert.equal(holdTargetIdleReason(target(closed, { labels: ["ready", "in-progress"] }), { openPullRequests: NO_PULL_REQUESTS }), null);
  assert.equal(holdTargetIdleReason(target(closed, { labels: ["session:worker-4524"] }), { openPullRequests: NO_PULL_REQUESTS }), null);
  assert.equal(holdTargetIdleReason(target(closed), { openPullRequests: A_PULL_REQUEST }), null);
});

test("the question does not apply to a `manual`, `merged`, `labelled` or `unlabelled` wait, or to a target already closed", () => {
  const facts = { openPullRequests: NO_PULL_REQUESTS };
  assert.equal(holdTargetIdleReason(target("manual"), facts), null);
  assert.equal(holdTargetIdleReason(target(`merged ${FIRST}#4524`), facts), null);
  assert.equal(holdTargetIdleReason(target(`labelled ready ${FIRST}#4524`), facts), null);
  assert.equal(holdTargetIdleReason(target(`unlabelled hold ${FIRST}#4524`), facts), null);
  assert.equal(holdTargetIdleReason(target(`closed ${FIRST}#4524`, { state: "closed" }), facts), null);
});

// --- the detector: a hold already in force ---------------------------------------------------------------------------------------------------

const HELD = { pr: { number: 550, repo: KEYED }, labels: ["hold:ceo"] };
const heldSince = (minutesAgo: number) => ({ ...HELD, since: NOW - minutesAgo * MINUTE });
const inForce = { openPullRequests: NO_PULL_REQUESTS };

test("`idleHoldIncident` is null at 15 minutes and an incident at 16, and the bound is the named constant", () => {
  const idle = target(`closed ${FIRST}#4524`);
  assert.equal(IDLE_HOLD_MINUTES, 15);
  assert.equal(idleHoldIncident(heldSince(IDLE_HOLD_MINUTES), idle, { now: NOW, ...inForce }), null, "at the bound it is not yet one");
  const incident = idleHoldIncident(heldSince(IDLE_HOLD_MINUTES + 1), idle, { now: NOW, ...inForce });
  assert.ok(incident !== null);
  assert.equal(incident.class, IDLE_HOLD_CLASS);
  assert.equal(incident.class, "hold-on-idle-row");
  assert.equal(incident.minutes, 16);
  assert.deepEqual(incident.pr, { number: 550, repo: KEYED });
  assert.equal(incident.target, `${FIRST}#4524`);
});

test("ONCE PER HOLD: the same hold read again later carries the same key, and a new hold on the same pair carries another", () => {
  const idle = target(`closed ${FIRST}#4524`);
  const hold = heldSince(16);
  const at16 = idleHoldIncident(hold, idle, { now: NOW, ...inForce });
  const at40 = idleHoldIncident(hold, idle, { now: NOW + 24 * MINUTE, ...inForce });
  assert.ok(at16 && at40);
  assert.equal(at40.key, at16.key, "a detector that keys on the minutes would file a new incident every tick");
  assert.notEqual(at40.minutes, at16.minutes, "the minutes move, which is why they are not in the key");
  const retaken = idleHoldIncident(heldSince(30), idle, { now: NOW, ...inForce });
  assert.ok(retaken);
  assert.notEqual(retaken.key, at16.key, "taking the hold again is a new hold, and its own incident");
});

test("not an incident: no hold in force, a hold with no date, a claimed target, a closing pull request, or a claim released a moment ago", () => {
  const idle = target(`closed ${FIRST}#4524`);
  assert.ok(idleHoldIncident(heldSince(60), idle, { now: NOW, ...inForce }), "control: the same hold with none of the below IS an incident");
  assert.equal(idleHoldIncident({ ...heldSince(60), labels: ["lane:any"] }, idle, { now: NOW, ...inForce }), null, "the label is gone, so nothing is held");
  assert.equal(idleHoldIncident({ ...HELD, since: null }, idle, { now: NOW, ...inForce }), null, "an age nobody can read is an unknown, not 'long enough'");
  assert.equal(idleHoldIncident(heldSince(60), target(`closed ${FIRST}#4524`, { labels: ["in-progress"] }), { now: NOW, ...inForce }), null);
  assert.equal(idleHoldIncident(heldSince(60), idle, { now: NOW, openPullRequests: A_PULL_REQUEST }), null);
  const justReleased = target(`closed ${FIRST}#4524`, { changedAt: NOW - 5 * MINUTE });
  assert.equal(idleHoldIncident(heldSince(60), justReleased, { now: NOW, ...inForce }), null, "the clock starts at the target's last change, never earlier than the hold");
});

// --- the take: the real CLI against a fake `gh` ----------------------------------------------------------------------------------------------

type FakeRow = { state: string, labels: string[], closedBy: { number: number, repo: string }[] };
type FakeState = { pr: { labels: string[], comments: string[], armed: boolean }, rows: Record<string, FakeRow>, calls: string[][] };

/** Answers `pr-hold.ts`'s calls for ONE pull request (agent-org#550) and `issue view` for the rows in `rows`; a row it does not hold fails the way a missing one does. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
state.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const json = flag("--json");
if (args[0] === "issue" && args[1] === "view") {
  const row = state.rows[flag("--repo") + "#" + args[2]];
  if (!row) { save(); process.stderr.write("fake gh: no such issue: " + args.join(" ")); process.exit(1); }
  process.stdout.write(JSON.stringify({ state: row.state, labels: row.labels.map((name) => ({ name })),
    closedByPullRequestsReferences: row.closedBy.map((c) => ({ number: c.number, repository: { name: c.repo.split("/")[1], owner: { login: c.repo.split("/")[0] } } })) }));
} else if (args[0] === "pr" && args[1] === "view") {
  const pr = state.pr;
  process.stdout.write(JSON.stringify(json === "labels" ? { labels: pr.labels.map((name) => ({ name })) }
    : json === "comments" ? { comments: pr.comments.map((body) => ({ body })) }
    : { autoMergeRequest: pr.armed ? { enabledAt: "now" } : null, state: "OPEN" }));
} else if (args[0] === "pr" && args[1] === "edit") {
  if (args.includes("--remove-label")) state.pr.labels = state.pr.labels.filter((l) => l !== flag("--remove-label"));
  if (args.includes("--add-label")) state.pr.labels.push(flag("--add-label"));
} else if (args[0] === "pr" && args[1] === "comment") {
  state.pr.comments.push(flag("--body"));
} else if (args[0] === "pr" && args[1] === "merge") {
  state.pr.armed = args.includes("--auto");
} else { save(); process.stderr.write("fake gh: unexpected " + args.join(" ")); process.exit(1); }
save();
`;

/** The host's own declaration with `tracker` and `code` replaced, so the key `agent-org` is declared exactly as the first repository is. */
function fixtureProject(dir: string): string {
  mkdirSync(join(dir, ".agent-org"), { recursive: true });
  const own = JSON.parse(readFileSync(join(HOME_CHECKOUT, PROJECT_DECLARATION_PATH), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, PROJECT_DECLARATION_PATH), JSON.stringify({ ...own, tracker: [{ key: "", repo: FIRST, board: { owner: "a11ign", number: 1 } }],
    code: [{ key: "", repo: FIRST }, { key: "agent-org", repo: KEYED }] }));
  const host = join(dir, ".agent-org", "host.json");
  writeFileSync(host, JSON.stringify({ schema: 1, home: dir, binDir: dir, primary: "fx", tool: dir, projects: [{ id: "fx", checkout: dir }] }));
  return host;
}

const AGENT_ORG_550 = "550";
const UNTIL_4524 = `closed ${FIRST}#4524`;

/** Takes a hold on agent-org#550 with the fake first on PATH; returns what the command said, the PR afterwards and every `gh` call it made. */
function take(rows: Record<string, FakeRow>, ...argv: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "pr-hold-4661-"));
  try {
    const state = join(dir, "state.json");
    const fresh: FakeState = { pr: { labels: [], comments: [], armed: true }, rows, calls: [] };
    writeFileSync(state, JSON.stringify(fresh));
    writeFileSync(join(dir, "gh"), FAKE_GH);
    chmodSync(join(dir, "gh"), EXECUTABLE);
    const args = [AGENT_ORG_550, "--repo-key=agent-org", "--session=ceo", ...argv];
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: dir, FAKE_GH_STATE: state, AGENT_ORG_HOST: fixtureProject(dir) } });
    const after = JSON.parse(readFileSync(state, "utf8")) as FakeState;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, pr: after.pr, calls: after.calls.map((c) => c.join(" ")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const row = (labels: string[], closedBy: FakeRow["closedBy"] = [], state = "OPEN"): Record<string, FakeRow> => ({ [`${FIRST}#4524`]: { state, labels, closedBy } });
const WRITES = /^pr (edit|comment|merge) /;

test("REFUSED: `--until=closed #4524` on an open, unclaimed row with no pull request exits 1, names the way out, and makes no write at all", () => {
  const refused = take(row(["ready", "lane:any"]), `--until=${UNTIL_4524}`);
  assert.equal(refused.status, 1, `${refused.stderr}\n${refused.calls.join("\n")}`);
  assert.match(refused.stderr, /^REFUSING --until="closed a11ign\/a11ign#4524": a11ign\/a11ign#4524 is OPEN, nobody holds it/m);
  assert.match(refused.stderr, /no open pull request closes it/);
  assert.match(refused.stderr, /Nothing was written\. Merge agent-org#550 and let the row rebase/);
  assert.match(refused.stderr, /--until=manual/);
  assert.deepEqual(refused.pr.labels, [], "no hold label");
  assert.deepEqual(refused.pr.comments, [], "no marker comment");
  assert.equal(refused.pr.armed, true, "and it was not disarmed");
  assert.deepEqual(refused.calls.filter((c) => WRITES.test(c)), [], "the label call is never reached: no edit, comment or merge");
  assert.deepEqual(refused.calls, [`issue view 4524 --repo ${FIRST} --json state,labels,closedByPullRequestsReferences`], "the one read the decision needs, and nothing after it");
});

test("CONTROL: the same hold is TAKEN when the row carries `in-progress`, or a `session:` label, or has an open pull request that closes it", () => {
  for (const [name, facts] of [
    ["in-progress", row(["in-progress", "started"])],
    ["a session label", row(["session:worker-4524"])],
    ["an open closing pull request", row(["ready"], [{ number: 518, repo: KEYED }])],
  ] as const) {
    const taken = take(facts, `--until=${UNTIL_4524}`);
    assert.equal(taken.status, 0, `${name}: ${taken.stderr}`);
    assert.deepEqual(taken.pr.labels, ["hold:ceo", "rearm-on-release"], `${name}: the hold landed`);
    assert.deepEqual(taken.pr.comments, [`${WAIT_MARKER}\nHeld by \`ceo\`.\nWaiting-for: ${UNTIL_4524}`], `${name}: and its marker`);
  }
});

test("CONTROL: a `manual` hold and a `merged` hold are not refused by this rule, and read no row", () => {
  for (const until of ["manual", `merged ${KEYED}#518`]) {
    const taken = take(row(["ready"]), `--until=${until}`);
    assert.equal(taken.status, 0, `${until}: ${taken.stderr}`);
    assert.deepEqual(taken.pr.labels, ["hold:ceo", "rearm-on-release"]);
    assert.deepEqual(taken.calls.filter((c) => c.startsWith("issue ")), [], `${until}: nothing about a claimant was asked`);
  }
});

test("a target that cannot be read is NOT refused: the hold is taken as asked, with a note, because absence is not proof it is idle", () => {
  const taken = take({}, `--until=${UNTIL_4524}`);
  assert.equal(taken.status, 0, taken.stderr);
  assert.match(taken.stderr, /NOTE: could not read a11ign\/a11ign#4524, so whether anybody is working it was not checked/);
  assert.deepEqual(taken.pr.labels, ["hold:ceo", "rearm-on-release"]);
});

test("a bare `#4524` names the held pull request's OWN repository, and is read there", () => {
  const taken = take({ [`${KEYED}#4524`]: { state: "OPEN", labels: ["ready"], closedBy: [] } }, "--until=closed #4524");
  assert.equal(taken.status, 1, taken.stderr);
  assert.match(taken.stderr, /a11ign\/agent-org#4524 is OPEN, nobody holds it/);
  assert.ok(taken.calls[0].includes(`--repo ${KEYED}`), taken.calls[0]);
});

test("a release is untouched: it does not read a row", () => {
  const released = take(row(["ready"]), "--release", `--until=${UNTIL_4524}`);
  assert.deepEqual(released.calls.filter((c) => c.startsWith("issue ")), [], "a release does not ask who is working the target");
});
