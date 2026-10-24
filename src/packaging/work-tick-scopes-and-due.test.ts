// no-token: gh -- the probes are the fake code host's, which RECORDS each ask (A11-160, step 9); nothing here reaches GitHub or any account's config.
//
// agent-org#995 (a11ign/a11ign#5043): IN `webhook` MODE THE TICK HANDS THE GATE THE SCOPES THE EVENTS NAMED (`A11Y_TICK_SCOPES_FILE`), AND ADDS A REPOSITORY WHOSE DATED WAIT CAME DUE
// SINCE THE PREVIOUS TICK TO ITS `changed` SET, WITHOUT A GitHub CALL. Poll mode hands over neither, and a corrupt due-index makes every declared repository due.
// Every test drives the real `refreshSnapshotOrSay` (and so the real `eventsForTick`) against a scratch state directory, with a fake code host that RECORDS each probe, so
// "no call" is a count of zero and not a claim.
//
// POSITIVE CONTROL: a webhook tick whose events name pull request 12 hands the gate that scope in the variable, and the file reads back as exactly that scope. Mutation: drop the
// `env[TICK_SCOPES_VARIABLE] = path` line in `handOverScopes` -> red here.
// NEGATIVE CONTROL: a poll host, a dead receiver, and a failed write each leave the variable UNSET (a stale value inherited from the parent is removed), and a poll tick writes neither
// the scopes file nor the time file. Mutation: skip the `delete env[TICK_SCOPES_VARIABLE]` at the top of `refreshSnapshotOrSay` -> red on the poll test.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probePaths, refreshTickSnapshot, slugOf } from "../tick-snapshot.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { EVENT_QUEUE_ENTRY, parseHostConfig, type HostConfig } from "../host-config.ts";
import type { QueueLine } from "../event-receiver.ts";
import { readTickScopes } from "../tick-scopes.ts";
import { writeDueIndex, type DueEntry } from "../due-index.ts";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE: `work-tick.ts` resolves the checkout it serves when it is imported.
const SCRATCH = tmpDirForFile("work-tick-scopes-and-due-");
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
const HOST_BASE = { schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } };
writeFileSync(HOST_FILE, JSON.stringify(HOST_BASE));
process.env.AGENT_ORG_HOST = HOST_FILE;
const { refreshSnapshotOrSay, TICK_SCOPES_ENTRY, TICK_SCOPES_VARIABLE, DUE_INDEX_ENTRY, DUE_TICK_ENTRY } = await import("../work-tick.ts");

const SEC = 1000;
const T0 = Date.parse("2026-10-11T19:00:00Z");
const HOME_REPO = "a11ign/a11ign";
const OTHER = "a11ign/agent-org";
const REPOS = [HOME_REPO, OTHER];
const RECONCILE_MINUTES = 20;
const project = { tracker: [{ repo: HOME_REPO }], code: [{ repo: HOME_REPO }, { repo: OTHER }], repo: HOME_REPO } as never;

afterEach(() => forgetActivation());

/** The fake code host (installed as the active one) answering 200 with one tag and a body that lists nothing, and RECORDING every probe it is asked (`calls`). */
const recordingGh = () => {
  const host = createFakeCodeHost();
  const readouts = host.rowsWorld.tail.readouts;
  for (const path of REPOS.flatMap(probePaths)) readouts.probes.set(path, { status: 200, etag: '"t1"', facts: { newest: null, count: 0 } });
  substituteCodeHost(host);
  return { calls: readouts.probeAsks };
};

const counter = (dir: string, repo: string) => Number(readFileSync(join(dir, "read-cache", "gen", slugOf(repo)), "utf8").trim().split(" ")[0]);

/** A cache directory that has had one poll refresh at `T0`, so every repository holds generation 1. */
function polled() {
  const dir = tmpDir("work-tick-scopes-and-due-cfg-");
  recordingGh();
  refreshTickSnapshot({ repos: REPOS, homeRepo: HOME_REPO, configDir: dir, nowMs: T0 });
  return dir;
}

/** A webhook host (or a poll one) whose state directory is scratch; the queue, cursor and heartbeat sit where the receiver unit puts them. */
function webhookHost(source: "webhook" | "poll" = "webhook") {
  const stateDir = tmpDir("work-tick-scopes-and-due-state-");
  mkdirSync(join(stateDir, "events"), { recursive: true });
  const events = source === "webhook"
    ? { source, receiver: { port: 8787, secretPath: "/abs/path/to/webhook-secret", tunnel: "cloudflare" }, reconcileMinutes: RECONCILE_MINUTES }
    : { source };
  const host = parseHostConfig(JSON.stringify({ ...HOST_BASE, stateDir, events }), "host.json");
  const queue = join(stateDir, EVENT_QUEUE_ENTRY);
  return { host, stateDir, queue, alive: `${queue}.alive` };
}
const entry = (over: Partial<QueueLine> = {}): QueueLine => ({ deliveryId: "d-1", event: "pull_request", action: "opened", repo: OTHER, number: 7, sha: "abc", receivedAt: new Date(T0).toISOString(), ...over });
const append = (queue: string, ...lines: QueueLine[]) => appendFileSync(queue, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));

/**
 * One real `refreshSnapshotOrSay` at `nowMs` against `fixture`, with the heartbeat written `heartbeatAgeSeconds` before it (fresh by default). Returns what the tick said
 * and the gh calls it made.
 */
function tickAt(fixture: { host: HostConfig; alive: string }, nowMs: number, env: NodeJS.ProcessEnv, configDir: string, heartbeatAgeSeconds = 5) {
  writeFileSync(fixture.alive, `${new Date(nowMs - heartbeatAgeSeconds * SEC).toISOString()}\n`);
  const gh = recordingGh();
  const said = refreshSnapshotOrSay({ declaration: () => project, configDir, env, host: () => fixture.host, nowMs,
    refresh: (input) => refreshTickSnapshot({ ...input, nowMs }) });
  return { said, calls: gh.calls };
}

/** A webhook host whose previous tick ran at T0 + 10 s, the arrangement the due tests start from; it records that tick's time. */
function hostAfterTickAt10s() {
  const fixture = webhookHost();
  const cfg = polled();
  const env: NodeJS.ProcessEnv = {};
  tickAt(fixture, T0 + 10 * SEC, env, cfg);
  return { fixture, cfg, env };
}

const dueIndexPath = (fixture: { stateDir: string }) => join(fixture.stateDir, DUE_INDEX_ENTRY);
const writeDue = (fixture: { stateDir: string }, repo: string, entries: DueEntry[]) => writeDueIndex({ path: dueIndexPath(fixture), repo, entries });
const due = (at: number): DueEntry => ({ number: 1, dueAtMs: at, kind: "not-before" });

test("POSITIVE CONTROL: a webhook tick whose events name pull request 12 hands the gate that scope in A11Y_TICK_SCOPES_FILE, and the file reads back as exactly that scope", () => {
  const fixture = webhookHost();
  append(fixture.queue, entry({ number: 12, repo: OTHER }));
  const env: NodeJS.ProcessEnv = {};
  const { calls } = tickAt(fixture, T0 + 30 * SEC, env, polled());
  assert.deepEqual(calls, [], "a named repository is served from the cache: no gh call");
  assert.equal(env[TICK_SCOPES_VARIABLE], join(fixture.stateDir, TICK_SCOPES_ENTRY), "the gate is told where the scopes are");
  assert.deepEqual(readTickScopes(env[TICK_SCOPES_VARIABLE]!), [{ repo: OTHER, kind: "pr", number: 12 }]);
});

test("NEGATIVE CONTROL: a poll host hands no scopes: a stale variable inherited from the parent is removed, and the tick writes no scopes file and no time file", () => {
  const fixture = webhookHost("poll");
  append(fixture.queue, entry({ number: 12, repo: OTHER }));
  writeDue(fixture, OTHER, [due(T0 + 30 * SEC)]);
  const env: NodeJS.ProcessEnv = { [TICK_SCOPES_VARIABLE]: "/stale/tick-scopes.json" };
  const cfg = polled();
  const { said } = tickAt(fixture, T0 + 60 * SEC, env, cfg);
  assert.equal(counter(cfg, OTHER), 1, "a dated wait that came due is not in a poll tick's `changed`: the probes decide, as they always did");
  assert.equal(env[TICK_SCOPES_VARIABLE], undefined, "poll passes no scopes: the gate reads whole");
  assert.equal(existsSync(join(fixture.stateDir, TICK_SCOPES_ENTRY)), false, "poll writes no scopes file the gate could read");
  assert.equal(existsSync(join(fixture.stateDir, DUE_TICK_ENTRY)), false, "poll keeps no time either");
  assert.doesNotMatch(said, /EVENTS|due /, "and says what it always said");
});

test("a healthy webhook tick that named nothing hands over an empty scope list, which the gate reads as nothing changed, not as unknown", () => {
  const fixture = webhookHost();
  const env: NodeJS.ProcessEnv = {};
  tickAt(fixture, T0 + 30 * SEC, env, polled());
  assert.deepEqual(readTickScopes(env[TICK_SCOPES_VARIABLE]!), []);
});

test("a dead receiver hands over no scopes: it delivers nothing, so an empty list would tell the gate that nothing changed", () => {
  const fixture = webhookHost();
  append(fixture.queue, entry({ number: 12, repo: OTHER }));
  const env: NodeJS.ProcessEnv = { [TICK_SCOPES_VARIABLE]: "/stale/tick-scopes.json" };
  const { said, calls } = tickAt(fixture, T0 + 30 * SEC, env, polled(), 400);
  assert.match(said, /EVENTS UNHEALTHY \(heartbeat 400s\), probes run/);
  assert.equal(env[TICK_SCOPES_VARIABLE], undefined);
  assert.equal(existsSync(join(fixture.stateDir, TICK_SCOPES_ENTRY)), false);
  assert.equal(calls.length, 4, "the probes ran, as they do for a dead receiver");
});

test("a scopes file that cannot be written leaves the variable unset and says the gate reads whole", () => {
  const fixture = webhookHost();
  append(fixture.queue, entry({ number: 12, repo: OTHER }));
  mkdirSync(join(fixture.stateDir, TICK_SCOPES_ENTRY)); // a directory where the file should be: the rename over it fails
  const env: NodeJS.ProcessEnv = {};
  const { said } = tickAt(fixture, T0 + 30 * SEC, env, polled());
  assert.equal(env[TICK_SCOPES_VARIABLE], undefined, "the file the gate would read is the previous tick's, so it is not named");
  assert.match(said, /; EVENTS 1 event, oldest event waited 30s; SCOPES NOT HANDED \(.+\): the gate reads whole$/);
});

test("POSITIVE CONTROL (due): an instant between the previous tick and now adds its repository to `changed`, which bumps its generation, and makes no gh call", () => {
  const { fixture, cfg, env } = hostAfterTickAt10s();
  writeDue(fixture, OTHER, [due(T0 + 30 * SEC)]);
  const { said, calls } = tickAt(fixture, T0 + 60 * SEC, env, cfg);
  assert.equal(counter(cfg, OTHER), 2, "the due repository's generation moved");
  assert.equal(counter(cfg, HOME_REPO), 1, "the repository with nothing due did not");
  assert.deepEqual(calls, []);
  assert.match(said, /; due a11ign\/agent-org$/);
});

test("an instant at or before the previous tick, or after now, does not make its repository due; one that has come due by a later tick does", () => {
  const { fixture, cfg, env } = hostAfterTickAt10s();
  writeDue(fixture, OTHER, [due(T0 + 10 * SEC), due(T0 + 5 * SEC)]); // exactly at the previous tick, and before it
  writeDue(fixture, HOME_REPO, [due(T0 + 120 * SEC)]); // after now
  const quiet = tickAt(fixture, T0 + 60 * SEC, env, cfg);
  assert.deepEqual([counter(cfg, HOME_REPO), counter(cfg, OTHER)], [1, 1], "neither instant is in (previous, now]");
  assert.deepEqual(quiet.calls, []);
  assert.doesNotMatch(quiet.said, /due /);
  const later = tickAt(fixture, T0 + 120 * SEC, env, cfg);
  assert.equal(counter(cfg, HOME_REPO), 2, "now the future instant is due, and it is in (T0 + 60 s, T0 + 120 s]");
  assert.equal(counter(cfg, OTHER), 1, "the instants before the previous tick stay seen");
  assert.deepEqual(later.calls, []);
});

test("a corrupt due-index makes every declared repository due, since a half-written file says nothing about what passed", () => {
  const { fixture, cfg, env } = hostAfterTickAt10s();
  writeFileSync(dueIndexPath(fixture), "{\"version\":1,\"repos\":{");
  const { said, calls } = tickAt(fixture, T0 + 30 * SEC, env, cfg);
  assert.deepEqual([counter(cfg, HOME_REPO), counter(cfg, OTHER)], [2, 2], "every declared repository is due, so every generation moved");
  assert.deepEqual(calls, []);
  assert.match(said, /due a11ign\/a11ign, a11ign\/agent-org$/);
});

test("NEGATIVE CONTROL (quiet): a healthy webhook tick with no event and nothing due makes ZERO gh calls, even with a due-index on disk", () => {
  const { fixture, cfg, env } = hostAfterTickAt10s();
  writeDue(fixture, OTHER, [due(T0 + 500 * SEC)]);
  const { said, calls } = tickAt(fixture, T0 + 30 * SEC, env, cfg);
  assert.deepEqual(calls, [], "nothing named and nothing due: the snapshot asks GitHub nothing");
  assert.deepEqual([counter(cfg, HOME_REPO), counter(cfg, OTHER)], [1, 1]);
  assert.match(said, /^SNAPSHOT 2 repositories, 0 changed; EVENTS no events$/);
});

test("the first tick, with no previous-tick time, counts an instant already passed once, and the next tick does not count it again", () => {
  const fixture = webhookHost();
  const cfg = polled();
  const env: NodeJS.ProcessEnv = {};
  writeDue(fixture, OTHER, [due(T0 + 30 * SEC)]);
  assert.equal(existsSync(join(fixture.stateDir, DUE_TICK_ENTRY)), false, "no time file yet: this is the first tick");
  const first = tickAt(fixture, T0 + 60 * SEC, env, cfg);
  assert.equal(counter(cfg, OTHER), 2, "a passed instant is due on the first tick");
  assert.match(first.said, /; due a11ign\/agent-org$/);
  const second = tickAt(fixture, T0 + 90 * SEC, env, cfg);
  assert.equal(counter(cfg, OTHER), 2, "the window is now (T0 + 60 s, T0 + 90 s]: the instant at T0 + 30 s is not in it");
  assert.deepEqual([first.calls, second.calls], [[], []]);
  assert.doesNotMatch(second.said, /due /);
});
