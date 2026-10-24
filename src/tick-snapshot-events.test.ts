// no-token: gh -- the probes are the fake code host's, which RECORDS each ask (A11-160, step 9); nothing here reaches GitHub or any account's config.
//
// agent-org#981 (a11ign/a11ign#5043): IN `webhook` MODE THE TICK'S SNAPSHOT IS MOVED BY THE EVENT QUEUE, SO A QUIET TICK MAKES NO GITHUB CALL, AND A DEAD RECEIVER FALLS BACK TO THE PROBES.
// Every test drives the real `refreshTickSnapshot` (and, where the host declaration matters, the real `refreshSnapshotOrSay`) against a scratch directory with a fake code host that
// records each probe it is asked, so "no call" is a count of zero and not a claim.
//
// POSITIVE CONTROL: the poll path (no `events`) runs two probes per repository and moves a generation when a probe says changed; every "makes no call" below is only worth anything because
// the same refresh, handed no `events` (or an unhealthy receiver), DOES call.
// NEGATIVE CONTROL: a healthy receiver with nothing named makes zero calls and keeps every counter, and the same setup with a stale or absent heartbeat runs the probes and says
// `EVENTS UNHEALTHY`; the cursor test pins what is NOT acked (a write that threw) beside the same events acked once the write held.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_UNCHANGED_SECONDS, probePaths, refreshTickSnapshot, slugOf } from "./tick-snapshot.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { EVENT_QUEUE_ENTRY, parseHostConfig } from "./host-config.ts";
import type { QueueLine } from "./event-receiver.ts";
import { tmpDir, tmpDirForFile } from "./lib/tmp-fixture.ts";

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE (see `packaging/tick-snapshot.test.ts`): `work-tick.ts` resolves the checkout it serves when it is imported.
const SCRATCH = tmpDirForFile("tick-snapshot-events-");
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
const HOST_BASE = { schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } };
writeFileSync(HOST_FILE, JSON.stringify(HOST_BASE));
process.env.AGENT_ORG_HOST = HOST_FILE;
const { refreshSnapshotOrSay, eventsForTick, HEARTBEAT_MAX_AGE_SECONDS } = await import("./work-tick.ts");

const SEC = 1000;
const T0 = Date.parse("2026-10-11T19:00:00Z");
const HOME_REPO = "a11ign/a11ign";
const OTHER = "a11ign/agent-org";
const REPOS = [HOME_REPO, OTHER];
const RECONCILE_MINUTES = 20;
const RECONCILE_SECONDS = RECONCILE_MINUTES * 60;

afterEach(() => forgetActivation());

/** The fake code host (installed as the active one) answering 200 with a tag per path and a body that lists nothing, and RECORDING every probe it is asked (`calls`: the path and the held tag sent). */
const recordingGh = (tag = "t1") => {
  const host = createFakeCodeHost();
  const readouts = host.rowsWorld.tail.readouts;
  for (const path of REPOS.flatMap(probePaths)) readouts.probes.set(path, { status: 200, etag: `"${tag}"`, facts: { newest: null, count: 0 } });
  substituteCodeHost(host);
  return { calls: readouts.probeAsks };
};

const generation = (dir: string, repo: string) => readFileSync(join(dir, "read-cache", "gen", slugOf(repo)), "utf8").trim();
const counter = (dir: string, repo: string) => Number(generation(dir, repo).split(" ")[0]);
const verified = (dir: string, repo: string) => Number(generation(dir, repo).split(" ")[1]);
const heldTags = (dir: string) => JSON.parse(readFileSync(join(dir, "read-cache", "etags.json"), "utf8"));

/** A cache directory that has had one poll refresh at `T0`, so every repository holds a generation (counter 1) and tags. Returns the directory. */
function polled() {
  const dir = tmpDir("tick-snapshot-events-cfg-");
  recordingGh();
  refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 });
  return dir;
}
const healthy = (changed: string[] = [], reconcileEverySeconds = RECONCILE_SECONDS) => ({ changed: new Set(changed), healthy: true, reconcileEverySeconds });

test("POSITIVE CONTROL: with no `events` the poll path runs two probes per repository, moves a generation when a probe says changed, and logs as it always did", () => {
  const dir = polled();
  assert.deepEqual([counter(dir, HOME_REPO), counter(dir, OTHER)], [1, 1]);
  const same = recordingGh("t1");
  const quiet = refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 + 10 * SEC });
  assert.equal(same.calls.length, 2 * REPOS.length, "two probes per declared repository, whatever the answer");
  assert.deepEqual(same.calls.map((ask) => ask.path).sort(), REPOS.flatMap(probePaths).sort());
  assert.deepEqual(quiet, [`${HOME_REPO}: unchanged (200 same tag, 200 same tag) generation 1`, `${OTHER}: unchanged (200 same tag, 200 same tag) generation 1`]);
  const moved = recordingGh("t2");
  const lines = refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 + 20 * SEC });
  assert.equal(moved.calls.length, 4);
  assert.match(lines[0], /CHANGED \(200 new tag, 200 new tag\) generation 2$/);
  assert.equal(counter(dir, OTHER), 2);
});

test("NEGATIVE CONTROL: a healthy receiver with nothing named makes ZERO gh calls, keeps every counter and tag, and still moves verified-at", () => {
  const dir = polled();
  const tagsBefore = heldTags(dir);
  const { calls } = recordingGh("would-be-new");
  const lines = refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 + 60 * SEC, events: healthy() });
  assert.deepEqual(calls, [], "a quiet tick in webhook mode asks GitHub nothing");
  assert.deepEqual([counter(dir, HOME_REPO), counter(dir, OTHER)], [1, 1], "no event, so no generation moves: the cache keeps serving");
  assert.deepEqual([verified(dir, HOME_REPO), verified(dir, OTHER)], [(T0 + 60 * SEC) / SEC, (T0 + 60 * SEC) / SEC], "the live receiver vouches for the repositories, so verified-at moves");
  assert.equal(generation(dir, "").split(" ")[0], "1", "the `default` generation (the home repository's) is written too");
  assert.deepEqual(heldTags(dir)[HOME_REPO].tags, tagsBefore[HOME_REPO].tags, "the held ETags are kept for the tick the receiver is found dead");
  assert.deepEqual(lines, [`${HOME_REPO}: unchanged (no event) generation 1`, `${OTHER}: unchanged (no event) generation 1`]);
});

test("an event moves `bumpedAt` and leaves `factsReadAt` where the content was last read: the event does not re-read anything (agent-org#1431)", () => {
  const dir = polled();
  recordingGh();
  refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 + 30 * SEC, events: healthy([OTHER]) });
  assert.equal(heldTags(dir)[OTHER].bumpedAt, (T0 + 30 * SEC) / SEC, "the event moved the window");
  assert.equal(heldTags(dir)[OTHER].factsReadAt, T0 / SEC, "the content was read at the poll, and the event after it did not read it again");
  assert.equal(heldTags(dir)[HOME_REPO].factsReadAt, T0 / SEC, "a repository no event named keeps its read time too");
});

test("an event for one repository bumps only that repository's generation, and the repository is matched without regard to case", () => {
  const dir = polled();
  const { calls } = recordingGh();
  const lines = refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 + 30 * SEC, events: healthy([OTHER]) });
  assert.deepEqual(calls, []);
  assert.deepEqual([counter(dir, HOME_REPO), counter(dir, OTHER)], [1, 2], "only the named repository moved");
  assert.equal(generation(dir, "").split(" ")[0], "1", "the home repository was not named, so its `default` entry did not move");
  assert.deepEqual(lines, [`${HOME_REPO}: unchanged (no event) generation 1`, `${OTHER}: CHANGED (event) generation 2`]);
  refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 + 40 * SEC, events: healthy(["A11IGN/A11IGN"]) });
  assert.deepEqual([counter(dir, HOME_REPO), counter(dir, OTHER)], [2, 2], "GitHub's spelling of full_name is not the declaration's: still the same repository");
  assert.equal(generation(dir, "").split(" ")[0], "2");
  refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 + 50 * SEC, events: healthy(["someone/else"]) });
  assert.deepEqual([counter(dir, HOME_REPO), counter(dir, OTHER)], [2, 2], "an undeclared repository moves nothing");
});

test("`due` uses the reconcile interval in place of MAX_UNCHANGED_SECONDS while events answer, and an unhealthy tick still uses MAX_UNCHANGED_SECONDS", () => {
  assert.ok(RECONCILE_SECONDS > MAX_UNCHANGED_SECONDS, "the test only separates the two intervals if the reconcile one is the longer");
  const dir = polled();
  const { calls } = recordingGh();
  refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 + MAX_UNCHANGED_SECONDS * SEC + SEC, events: healthy() });
  assert.deepEqual([counter(dir, HOME_REPO), counter(dir, OTHER)], [1, 1], "past MAX_UNCHANGED_SECONDS but inside the reconcile interval: not re-read");
  const justBefore = refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 + (RECONCILE_SECONDS - 1) * SEC, events: healthy() });
  assert.deepEqual([counter(dir, HOME_REPO), counter(dir, OTHER)], [1, 1]);
  assert.ok(justBefore.every((line) => !line.includes("re-read due")));
  const due = refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 + RECONCILE_SECONDS * SEC, events: healthy() });
  assert.deepEqual([counter(dir, HOME_REPO), counter(dir, OTHER)], [2, 2], "the reconcile interval is up: every repository is re-read");
  assert.match(due[0], /CHANGED \(no event; re-read due\) generation 2$/);
  assert.equal(calls.length, 4, "and the reconcile is the one place a probe runs while events answer: the pair, once per repository (agent-org#982, the drift check)");
  const dead = recordingGh();
  refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 + (RECONCILE_SECONDS + MAX_UNCHANGED_SECONDS) * SEC, events: { ...healthy(), healthy: false } });
  assert.equal(dead.calls.length, 4, "an unhealthy receiver is the poll path, which asks");
  assert.deepEqual([counter(dir, HOME_REPO), counter(dir, OTHER)], [3, 3], "and re-reads on MAX_UNCHANGED_SECONDS as it always did");
});

test("a reconcile interval that is not a positive number is refused rather than never re-reading", () => {
  const dir = polled();
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0, events: healthy([], bad) }), /reconcileEverySeconds/);
  }
});

// -- the host-facing half: `eventsForTick` and `refreshSnapshotOrSay` against real queue, cursor and heartbeat files --

/** A webhook host whose state directory is a scratch one; the queue, cursor and heartbeat live under it where the receiver unit puts them. */
function webhookHost(source: "webhook" | "poll" = "webhook") {
  const stateDir = tmpDir("tick-snapshot-events-state-");
  mkdirSync(join(stateDir, "events"), { recursive: true });
  const events = source === "webhook"
    ? { source, receiver: { port: 8787, secretPath: "/abs/path/to/webhook-secret", tunnel: "cloudflare" }, reconcileMinutes: RECONCILE_MINUTES }
    : { source };
  const host = parseHostConfig(JSON.stringify({ ...HOST_BASE, stateDir, events }), "host.json");
  const queue = join(stateDir, EVENT_QUEUE_ENTRY);
  return { host, queue, cursor: `${queue}.cursor`, alive: `${queue}.alive` };
}
const entry = (over: Partial<QueueLine> = {}): QueueLine => ({ deliveryId: "d-1", event: "pull_request", action: "opened", repo: OTHER, number: 7, sha: "abc", receivedAt: new Date(T0).toISOString(), ...over });
const append = (queue: string, ...lines: QueueLine[]) => appendFileSync(queue, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
const beat = (alive: string, at: number) => writeFileSync(alive, `${new Date(at).toISOString()}\n`);
const project = { tracker: [{ repo: HOME_REPO }], code: [{ repo: HOME_REPO }, { repo: OTHER }], repo: HOME_REPO } as never;

test("the host's heartbeat decides `healthy`: younger than 120 s is, 120 s and older, absent, unparseable or from the future is not", () => {
  const fixture = webhookHost();
  const at = (heartbeatAt: number | null, nowMs = T0) => {
    if (heartbeatAt !== null) beat(fixture.alive, heartbeatAt);
    return eventsForTick({ host: fixture.host, repos: REPOS, nowMs })!;
  };
  assert.equal(HEARTBEAT_MAX_AGE_SECONDS, 120);
  assert.equal(at(null).events.healthy, false, "no heartbeat file: a receiver that never ran, or one whose file is gone");
  assert.match(at(null).say, /^EVENTS UNHEALTHY \(heartbeat absent\), probes run$/);
  assert.equal(at(T0 - 119 * SEC).events.healthy, true, "POSITIVE CONTROL: a heartbeat 119 s old is a live receiver");
  assert.equal(at(T0 - 120 * SEC).events.healthy, false);
  assert.match(at(T0 - 400 * SEC).say, /^EVENTS UNHEALTHY \(heartbeat 400s\), probes run$/);
  writeFileSync(fixture.alive, "not a time\n");
  assert.equal(eventsForTick({ host: fixture.host, repos: REPOS, nowMs: T0 })!.events.healthy, false, "a heartbeat that cannot be read vouches for nothing");
  assert.equal(at(T0 + 60 * SEC).events.healthy, false, "a heartbeat from the future is not a young one");
  assert.equal(at(T0 - 10 * SEC).events.reconcileEverySeconds, RECONCILE_SECONDS, "host events.reconcileMinutes x 60");
});

test("a stale heartbeat runs the probes and says EVENTS UNHEALTHY; the same queue with a fresh one makes no call (the NEGATIVE CONTROL pair)", () => {
  const fixture = webhookHost();
  const cfg = polled();
  append(fixture.queue, entry());
  const env: NodeJS.ProcessEnv = {};
  beat(fixture.alive, T0 - 400 * SEC);
  const dead = recordingGh("t1");
  const deadSaid = refreshSnapshotOrSay({ declaration: () => project, configDir: cfg, env, host: () => fixture.host, nowMs: T0 + 30 * SEC,
    refresh: (input) => refreshTickSnapshot(input) });
  assert.equal(dead.calls.length, 4, "the probes ran: a dead receiver costs the old polling");
  assert.match(deadSaid, /^SNAPSHOT 2 repositories, 0 changed; EVENTS UNHEALTHY \(heartbeat 430s\), probes run$/);
  assert.equal(env.A11Y_TICK_SNAPSHOT, "1", "the probes ran, so there is a snapshot to believe");

  beat(fixture.alive, T0 + 25 * SEC);
  append(fixture.queue, entry({ deliveryId: "d-2", repo: HOME_REPO, receivedAt: new Date(T0 + 20 * SEC).toISOString() }));
  const live = recordingGh("t1");
  const liveSaid = refreshSnapshotOrSay({ declaration: () => project, configDir: cfg, env, host: () => fixture.host, nowMs: T0 + 40 * SEC,
    refresh: (input) => refreshTickSnapshot(input) });
  assert.deepEqual(live.calls, [], "a live receiver: the snapshot step made no gh call");
  assert.match(liveSaid, /^SNAPSHOT 2 repositories, 1 changed \(a11ign\/a11ign\); EVENTS 1 event, oldest event waited 20s$/);
});

test("the log line carries the event count and the oldest event's wait, or `no events`", () => {
  const fixture = webhookHost();
  const cfg = polled();
  const env: NodeJS.ProcessEnv = {};
  beat(fixture.alive, T0 + 10 * SEC);
  const say = () => refreshSnapshotOrSay({ declaration: () => project, configDir: cfg, env, host: () => fixture.host, nowMs: T0 + 30 * SEC,
    refresh: (input) => (recordingGh(), refreshTickSnapshot(input)) });
  assert.match(say(), /^SNAPSHOT 2 repositories, 0 changed; EVENTS no events$/);
  append(fixture.queue,
    entry({ deliveryId: "d-1", receivedAt: new Date(T0 + 5 * SEC).toISOString() }),
    entry({ deliveryId: "d-2", receivedAt: new Date(T0 + 12 * SEC).toISOString() }));
  assert.match(say(), /^SNAPSHOT 2 repositories, 1 changed \(a11ign\/agent-org\); EVENTS 2 events, oldest event waited 25s$/);
  assert.match(say(), /EVENTS no events$/, "acked, so the next tick has none");
});

test("the cursor is acked after the generations are written, and not when the write throws", () => {
  const fixture = webhookHost();
  beat(fixture.alive, T0 + 10 * SEC);
  append(fixture.queue, entry({ deliveryId: "d-1" }), entry({ deliveryId: "d-2" }));
  const env: NodeJS.ProcessEnv = {};
  const seenDuringRefresh: Array<string | null> = [];

  // The write throws: a configDir that is a FILE, so `mkdirSync(read-cache/gen)` fails inside the real refresh.
  const broken = join(tmpDir("tick-snapshot-events-broken-"), "not-a-directory");
  writeFileSync(broken, "x");
  const failed = refreshSnapshotOrSay({ declaration: () => project, configDir: broken, env, host: () => fixture.host, nowMs: T0 + 30 * SEC });
  assert.match(failed, /^SNAPSHOT NOT REFRESHED/);
  assert.equal(existsSync(fixture.cursor), false, "the write threw, so the cursor did not move: the events are read again");
  assert.equal(env.A11Y_TICK_SNAPSHOT, undefined);

  // The write holds: the cursor is where it was while `refresh` ran, and past the events after it returned.
  const cfg = polled();
  const said = refreshSnapshotOrSay({ declaration: () => project, configDir: cfg, env, host: () => fixture.host, nowMs: T0 + 30 * SEC,
    refresh: (input) => {
      const lines = (recordingGh(), refreshTickSnapshot(input));
      seenDuringRefresh.push(existsSync(fixture.cursor) ? readFileSync(fixture.cursor, "utf8") : null);
      return lines;
    } });
  assert.deepEqual(seenDuringRefresh, [null], "while the generations were being written the cursor had not moved");
  assert.equal(Number(readFileSync(fixture.cursor, "utf8")), readFileSync(fixture.queue).length, "and once they were written it is past both events");
  assert.match(said, /EVENTS 2 events/);
  assert.equal(counter(cfg, OTHER), 2, "the named repository was bumped before the ack");
});

test("an ack that fails leaves the snapshot standing and says the events are read again", () => {
  const fixture = webhookHost();
  beat(fixture.alive, T0 + 10 * SEC);
  append(fixture.queue, entry());
  mkdirSync(`${fixture.cursor}.tmp`); // ackThrough writes `<cursor>.tmp` and a directory is there instead
  const env: NodeJS.ProcessEnv = {};
  const said = refreshSnapshotOrSay({ declaration: () => project, configDir: polled(), env, host: () => fixture.host, nowMs: T0 + 30 * SEC,
    refresh: (input) => (recordingGh(), refreshTickSnapshot(input)) });
  assert.equal(env.A11Y_TICK_SNAPSHOT, "1", "the generations were written, so the snapshot is good");
  assert.match(said, /EVENTS 1 event, oldest event waited 30s; EVENTS cursor not moved \(.+\): the events are read again next tick$/);
});

test("an event that names no repository, or a queue line that does not parse, names every repository: fail towards reading", () => {
  const fixture = webhookHost();
  beat(fixture.alive, T0);
  append(fixture.queue, entry({ repo: null }));
  assert.deepEqual([...eventsForTick({ host: fixture.host, repos: REPOS, nowMs: T0 })!.events.changed].sort(), [...REPOS].sort());
  const other = webhookHost();
  beat(other.alive, T0);
  writeFileSync(other.queue, "this is not json\n");
  assert.deepEqual([...eventsForTick({ host: other.host, repos: REPOS, nowMs: T0 })!.events.changed].sort(), [...REPOS].sort());
  const named = webhookHost();
  beat(named.alive, T0);
  append(named.queue, entry());
  assert.deepEqual([...eventsForTick({ host: named.host, repos: REPOS, nowMs: T0 })!.events.changed], [OTHER], "NEGATIVE CONTROL: an event that names its repository names only it");
});

test("an unreadable queue falls back to the probes and says so", () => {
  const fixture = webhookHost();
  beat(fixture.alive, T0);
  mkdirSync(fixture.queue); // a directory where the queue file should be
  const tick = eventsForTick({ host: fixture.host, repos: REPOS, nowMs: T0 })!;
  assert.equal(tick.events.healthy, false);
  assert.match(tick.say, /^EVENTS UNHEALTHY \(queue unreadable: .+\), probes run$/);
});

test("a poll host, no block, or an unreadable declaration passes no `events`, reads no queue and logs the line it always did", () => {
  const poll = webhookHost("poll");
  append(poll.queue, entry());
  beat(poll.alive, T0);
  assert.equal(eventsForTick({ host: poll.host, repos: REPOS, nowMs: T0 }), null);
  const inputs: unknown[] = [];
  const env: NodeJS.ProcessEnv = {};
  const lines = () => [`${HOME_REPO}: unchanged (304, 304) generation 1`, `${OTHER}: CHANGED (200 new tag, 304) generation 2`];
  const expected = "SNAPSHOT 2 repositories, 1 changed (a11ign/agent-org)";
  for (const host of [() => poll.host, () => parseHostConfig(JSON.stringify(HOST_BASE), "host.json"), () => undefined]) {
    const said = refreshSnapshotOrSay({ declaration: () => project, configDir: "/cfg", env, host, refresh: (input) => { inputs.push(input); return lines(); } });
    assert.equal(said, expected);
  }
  assert.ok(inputs.every((input) => !("events" in (input as object))), "the poll path is handed no `events` key at all");
  assert.equal(existsSync(poll.cursor), false, "and the queue is not consumed");
});
