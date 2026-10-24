// no-token: gh -- the probes are the fake code host's (A11-160, step 9); nothing here reaches GitHub or any account's config.
//
// #4148: THE TICK ASKS GITHUB "DID ANYTHING CHANGE?" ONCE PER REPOSITORY, THROUGH REST WITH AN ETAG (a 304 costs no point), AND MOVES A GENERATION THE WRAPPER'S CACHE READS. A probe
// that cannot say is a CHANGE (fail towards reading), a repository with no Actions is a steady state and not one, and the tag is sent WITHOUT its `W/` (measured: the prefixed one came
// back 200 and cost a point). THE POSITIVE CONTROL for "unchanged" is the same refresh with a 200 in the stub's place, which moves the generation.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_UNCHANGED_SECONDS, probeOnce, probePaths, refreshTickSnapshot, slugOf } from "../tick-snapshot.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { ProbeReading } from "../plugins/contracts/code-host-rows-readouts.ts";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE: see `org-health-auto-off-refusal.test.ts`. `work-tick.ts` resolves the checkout it serves when it is imported.
const SCRATCH = tmpDirForFile("tick-snapshot-project-");
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
const { refreshSnapshotOrSay } = await import("../work-tick.ts");

const T0 = Date.parse("2026-10-08T15:00:00Z");
const SEC = 1000;
const REPO = "a11ign/agent-org";
const [ISSUES, RUNS] = probePaths(REPO);
/** What a probe answers: a 200 with this tag (`W/` already taken off, as the code host reads it), a 304, or something else. */
const ok = (tag: string): ProbeReading => ({ status: 200, etag: `"${tag}"`, facts: undefined });
const notModified: ProbeReading = { status: 304, etag: '"x"', facts: undefined };
const unreadable = (status: number | null): ProbeReading => ({ status, etag: null, facts: undefined });

afterEach(() => forgetActivation());

/** The fake code host (installed as the active one) answering each probed path from a table; a path the table does not name is silence, as a `gh` that printed nothing. `asks` is what each probe sent as its held tag. */
const host = (answers: Record<string, ProbeReading>) => {
  const fake = createFakeCodeHost();
  const probes = fake.rowsWorld.tail.readouts;
  for (const path of [...probePaths(REPO), ...probePaths("a11ign/a11ign")]) probes.probes.set(path, unreadable(null));
  for (const [path, answer] of Object.entries(answers)) probes.probes.set(path, answer);
  substituteCodeHost(fake);
  return { asks: probes.probeAsks, probes: probes.probes };
};

// WHAT IS SENT (`api -i`, then the held tag as `If-None-Match`, `absent` never) and HOW THE `-i` BLOCK IS READ are the plugin's: `plugins/github/rows/readouts-rows.test.ts`. Here is what the tick DECIDES from a probe's reading.
test("#4148: a probe sends the held tag and reads 304 as unchanged, 200 with a new tag as changed, and anything else as changed", () => {
  const send = (held: string | undefined, answer: ProbeReading) => {
    const fake = host({ [ISSUES]: answer });
    return { got: probeOnce({ path: ISSUES, held }), asked: fake.asks[0] };
  };
  const unchanged = send('"t1"', notModified);
  assert.equal(unchanged.got.changed, false);
  assert.deepEqual(unchanged.asked, { path: ISSUES, etag: '"t1"' }, "the held tag is sent");
  assert.equal(send(undefined, ok("t1")).asked.etag, undefined, "no tag held: unconditional");
  assert.equal(send('"t1"', ok("t2")).got.changed, true, "POSITIVE CONTROL: a new tag moves it");
  assert.equal(send('"t1"', ok("t1")).got.changed, false, "a 200 carrying the SAME tag (a cache ignoring the condition) is not a change");
  assert.equal(send('"t1"', unreadable(502)).got.changed, true, "a server error is a change: fail towards reading");
  assert.equal(send('"t1"', unreadable(null)).got.changed, true, "silence is a change");
  const gone = send('"t1"', unreadable(404));
  assert.deepEqual([gone.got.changed, gone.got.etag], [false, "absent"], "no Actions is a steady state");
  assert.equal(send("absent", unreadable(404)).asked.etag, undefined, "and `absent` is never sent as a tag");
});

const configDir = () => tmpDir("tick-snapshot-cfg-");
const gen = (dir: string, repo: string) => {
  const path = join(dir, "read-cache", "gen", slugOf(repo));
  return existsSync(path) ? readFileSync(path, "utf8").trim().split(" ").map(Number) : null;
};

test("#4148: a refresh moves a repository's generation only when a probe says it changed (or the re-read is due), and always writes the verification time", () => {
  const dir = configDir();
  const answers = { [ISSUES]: ok("i1"), [RUNS]: ok("r1") };
  host(answers);
  const first = refreshTickSnapshot({ repos: [REPO], homeRepo: "a11ign/a11ign", configDir: dir, nowMs: T0 });
  assert.match(first[0], /CHANGED/);
  assert.deepEqual(gen(dir, REPO), [1, T0 / SEC], "the first refresh starts a generation");
  const quiet = { [ISSUES]: notModified, [RUNS]: notModified };
  host(quiet);
  refreshTickSnapshot({ repos: [REPO], homeRepo: "a11ign/a11ign", configDir: dir, nowMs: T0 + 60 * SEC });
  assert.deepEqual(gen(dir, REPO), [1, T0 / SEC + 60], "nothing changed: the counter holds and the verification moves");
  host({ [ISSUES]: ok("i2"), [RUNS]: notModified });
  refreshTickSnapshot({ repos: [REPO], homeRepo: "a11ign/a11ign", configDir: dir, nowMs: T0 + 120 * SEC });
  assert.deepEqual(gen(dir, REPO), [2, T0 / SEC + 120], "POSITIVE CONTROL: a new tag on one probe moves it");
  host(quiet);
  refreshTickSnapshot({ repos: [REPO], homeRepo: "a11ign/a11ign", configDir: dir, nowMs: T0 + (120 + MAX_UNCHANGED_SECONDS) * SEC });
  assert.equal(gen(dir, REPO)?.[0], 3, "unchanged for MAX_UNCHANGED_SECONDS: re-read anyway, what a probe cannot see is bounded");
});

test("#4148: the home repository's generation is also written under `default`, the name of a call that names no repository", () => {
  const dir = configDir();
  const answers = { [probePaths("a11ign/a11ign")[0]]: ok("a"), [probePaths("a11ign/a11ign")[1]]: ok("b"), [ISSUES]: ok("c"), [RUNS]: ok("d") };
  host(answers);
  refreshTickSnapshot({ repos: ["a11ign/a11ign", REPO], homeRepo: "a11ign/a11ign", configDir: dir, nowMs: T0 });
  assert.ok(gen(dir, "a11ign/a11ign") && gen(dir, ""), "home: its own name and `default`");
  assert.ok(gen(dir, REPO) && !existsSync(join(dir, "read-cache", "gen", "default.other")), "another repository: its own name only");
  assert.equal(slugOf("a11ign/agent-org"), "a11ign_agent-org", "the wrapper's `tr` makes the same name from `-R a11ign/agent-org`");
});

test("#4148: the tick sets A11Y_TICK_SNAPSHOT only when the refresh RAN, and says so in one line", () => {
  const project = { tracker: [{ repo: "a11ign/a11ign" }], code: [{ repo: "a11ign/a11ign" }, { repo: REPO }], repo: "a11ign/a11ign" } as never;
  const env: NodeJS.ProcessEnv = { A11Y_TICK_SNAPSHOT: "stale" };
  const seen: string[][] = [];
  const said = refreshSnapshotOrSay({ declaration: () => project, configDir: "/cfg", env, refresh: ({ repos }) => { seen.push(repos); return [`${repos[0]}: unchanged (304) generation 1`, `${repos[1]}: CHANGED (200 new tag) generation 2`]; } });
  assert.deepEqual(seen, [["a11ign/a11ign", REPO]], "the declared repositories, each once");
  assert.equal(env.A11Y_TICK_SNAPSHOT, "1");
  assert.match(said, /^SNAPSHOT 2 repositories, 1 changed \(a11ign\/agent-org\)$/);
  const failed = refreshSnapshotOrSay({ declaration: () => project, configDir: "/cfg", env, refresh: () => { throw new Error("EACCES"); } });
  assert.equal(env.A11Y_TICK_SNAPSHOT, undefined, "a refresh that threw leaves no snapshot to believe");
  assert.match(failed, /NOT REFRESHED \(EACCES\): every read goes to GitHub/);
  env.A11Y_TICK_SNAPSHOT = "1";
  assert.match(refreshSnapshotOrSay({ declaration: () => project, configDir: "", env }), /SNAPSHOT OFF: GH_CONFIG_DIR is unset/);
  assert.equal(env.A11Y_TICK_SNAPSHOT, undefined);
});
