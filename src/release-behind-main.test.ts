// no-token: pure -- the verdicts are a function of values handed in, and the fact reader is given a fake `gh` and a fake registry; nothing here calls `gh`, curl, ssh or the fleet.
/**
 * `src/release-behind-main.ts` and `src/org-health.ts`, #4128: A REPOSITORY WHOSE `main` HOLDS A SHIPPED-PATH COMMIT NO RELEASE CARRIES, FOR OVER 24 HOURS, IS RAISED within a tick
 * (class fix for a11ign/a11ign#4084: screenreader-worker#25 and #26 merged `src/` commits with no changeset).
 *
 * THE FIXTURE IS `ceo`'s REPLAY, with the release corrected: screenreader-worker at `@a11ign/screenreader-worker@0.3.0` (npm time 2026-10-06T05:28:37Z) against `main` with the three
 * `src/` commits of 2026-10-08 (`6a943efd3` 09:45:15Z, `057ac7742` 09:55:38Z, `b613115e3` 10:37:43Z). The world is served through the REAL reader by a fake `gh`, so the classification
 * (test files, `.changeset/`, a rename out of `src/`, a merge commit, the `no-release:` line) is the reader's own and not restated here.
 *
 * POSITIVE CONTROLS: the replay trips; the same state under 24 h clears and a later release clears it, so "clear" is not what an empty reading says by default. MUTATIONS, each run by hand
 * and recorded on the row: never trip (the replay and its siblings go red), always trip (the clear cases go red, and only they), count a test file or a `.changeset/` file (their cases go red),
 * ignore `no-release:` (the declared case goes red), read a refused repository as clear (the unknown case goes red), read the cache with no age (the hour case goes red).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE (`org-health-release-failed.test.ts`'s rule): the host file is set FIRST and the tool imported AFTER it, dynamically.
const SCRATCH = mkdtempSync(join(tmpdir(), "release-behind-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { SIGNALS, releaseBehindReadings, orgHealthReadings, orgHealthOrders, orgHealthTick } = await import("./org-health.ts");
const { BEHIND_AFTER_MS, CACHE_FILE, READ_INTERVAL_MS, cachedReleaseBehind, isShipped, noReleaseReason, readReleaseBehind, readRepoFact } = await import("./release-behind-main.ts");
const { orgHealthNow } = await import("./work-gate/org-health.mjs");

const SIGNAL = "release-behind-main";
const WORKER = "a11ign/screenreader-worker";
const PACKAGE = "@a11ign/screenreader-worker";
const WORKER_PATHS = ["src/", "packages/nvda-speech/"];
const sha = (prefix: string) => prefix.padEnd(40, "0");
const at = (iso: string) => Date.parse(iso);

type File = { filename: string; previous_filename?: string };
type World = { commits: { sha: string; at: string; files: File[]; body?: string | null; pr?: number; parents?: number }[]; releases?: { tag: string; at: string }[]; time?: Record<string, string>; registryStatus?: string };

const REPLAY_COMMITS = [
  { sha: sha("6a943efd3"), at: "2026-10-08T09:45:15Z", pr: 25, files: [{ filename: "src/worker.ts" }], body: "no changeset" },
  { sha: sha("057ac7742"), at: "2026-10-08T09:55:38Z", pr: 26, files: [{ filename: "src/speech.ts" }], body: "none either" },
  { sha: sha("b613115e3"), at: "2026-10-08T10:37:43Z", pr: 27, files: [{ filename: "src/queue.ts" }], body: "same" },
];
const NPM_TIMES = { created: "2026-09-01T00:00:00Z", modified: "2026-10-07T00:00:00Z", "0.0.0-reserved": "2026-10-07T12:00:00Z", "0.2.0": "2026-10-01T09:00:00Z", "0.3.0": "2026-10-06T05:28:37Z" };

/** A fake `gh` that answers by URL from a world per repository, and records every call. Its answers are what the real `--jq` projections print. */
function fakes(worlds: Record<string, World>, { refuse = [] as string[] } = {}) {
  const calls: string[][] = [];
  const registryCalls: string[] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const url = args.find((a) => a.startsWith("repos/")) ?? "";
    const repo = url.split("/").slice(1, 3).join("/");
    if (refuse.includes(repo)) throw new Error(`gh: HTTP 403 for ${repo}`);
    const world = worlds[repo];
    if (world === undefined) throw new Error(`the fake has no world for ${repo}`);
    const rest = url.split("/").slice(3);
    if (rest[0] === "releases") return JSON.stringify((world.releases ?? []).map((r) => ({ tag: r.tag, at: r.at })));
    if (rest[0] === "commits" && rest.length === 1) {
      const path = args[args.indexOf(`path=${args.find((a) => a.startsWith("path="))?.slice(5)}`)].slice(5);
      return JSON.stringify(world.commits.filter((c) => c.files.some((f) => f.filename.startsWith(path) || f.previous_filename?.startsWith(path)))
        .map((c) => ({ sha: c.sha, at: c.at, parents: c.parents ?? 1 })).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));
    }
    const commit = world.commits.find((c) => c.sha === rest[1]);
    if (commit === undefined) throw new Error(`the fake has no commit ${rest[1]}`);
    if (rest[2] === "pulls") return JSON.stringify(commit.pr === undefined ? [] : [{ number: commit.pr, body: commit.body ?? null }]);
    return JSON.stringify(commit.files);
  };
  const registry = (npmPackage: string) => {
    registryCalls.push(npmPackage);
    const world = Object.values(worlds).find((w) => w.time !== undefined);
    if (world?.registryStatus) return { status: world.registryStatus, body: "{}" };
    return { status: "200", body: JSON.stringify({ time: world?.time }) };
  };
  return { gh, registry, calls, registryCalls };
}

const WORKER_REPOSITORY = { repo: WORKER, release: { kind: "npm" as const, package: PACKAGE }, releasablePaths: WORKER_PATHS };
const replayWorld = (over: Partial<World> = {}): World => ({ commits: REPLAY_COMMITS, time: NPM_TIMES, ...over });
const factOf = (world: World, repository: any = WORKER_REPOSITORY) => readRepoFact(fakes({ [repository.repo]: world }), repository);
const readingsAt = (now: string, world: World) => releaseBehindReadings({ now: at(now), behind: [factOf(world)] });

// --- the reading -------------------------------------------------------------------------------------------------------------------

test("the worker replay: a release older than the oldest unreleased commit by over 24 hours trips, naming 0.3.0 and 6a943efd3", () => {
  const [r, ...rest] = readingsAt("2026-10-09T10:00:00Z", replayWorld());
  assert.equal(rest.length, 0);
  assert.equal(r.status, "tripped");
  assert.equal(r.signal, SIGNAL);
  assert.match(r.detail, /a11ign\/screenreader-worker is BEHIND ITS OWN main/);
  assert.match(r.detail, /latest release @a11ign\/screenreader-worker@0\.3\.0 \(2026-10-06T05:28:37Z\)/, "the release: name, version and time; the 0.0.0- reservation is not it");
  assert.match(r.detail, /oldest unreleased commit on a releasable path 6a943efd3 \(2026-10-08T09:45:15Z, #25\)/);
  assert.match(r.detail, /2 more unreleased \(057ac7742, b613115e3\)/);
  assert.equal(r.discriminator, `${SIGNAL}@${WORKER}@${sha("6a943efd3")}`, "the oldest commit keys it, so a later commit does not re-raise it");
  assert.equal(r.firstTrippedAt, at("2026-10-08T09:45:15Z") + BEHIND_AFTER_MS);
});

test("a later commit does not re-key the order; a newer oldest does", () => {
  const later = { sha: sha("c0ffee001"), at: "2026-10-08T12:00:00Z", pr: 28, files: [{ filename: "src/new.ts" }], body: "x" };
  const [withLater] = readingsAt("2026-10-09T10:00:00Z", replayWorld({ commits: [...REPLAY_COMMITS, later] }));
  assert.equal(withLater.discriminator, `${SIGNAL}@${WORKER}@${sha("6a943efd3")}`);
  assert.match(withLater.detail, /3 more unreleased/);
  const [without] = readingsAt("2026-10-09T10:00:00Z", replayWorld({ commits: [...REPLAY_COMMITS.slice(1), later] }));
  assert.equal(without.discriminator, `${SIGNAL}@${WORKER}@${sha("057ac7742")}`, "CONTROL: with the oldest gone the key moves to the next oldest");
});

test("the same state at 2026-10-08T11:00Z, under 24 h, is clear", () => {
  const [r] = readingsAt("2026-10-08T11:00:00Z", replayWorld());
  assert.equal(r.status, "clear");
});

test("the same state to the minute: 24 h is not over 24 h, and a minute past it trips", () => {
  assert.equal(readingsAt("2026-10-09T09:45:15Z", replayWorld())[0].status, "clear");
  assert.equal(readingsAt("2026-10-09T09:46:15Z", replayWorld())[0].status, "tripped");
});

test("the same state plus a release at 2026-10-08T11:52Z (0.4.0) is clear: a commit before the release is not after it", () => {
  const world = replayWorld({ time: { ...NPM_TIMES, "0.4.0": "2026-10-08T11:52:00Z" } });
  const [r] = readingsAt("2026-10-09T12:00:00Z", world);
  assert.equal(r.status, "clear");
  assert.equal(factOf(world) && (factOf(world) as any).release.version, "0.4.0");
  assert.equal(readingsAt("2026-10-09T12:00:00Z", replayWorld())[0].status, "tripped", "CONTROL: without 0.4.0 the same clock trips");
});

test("a commit only under src/x.test.ts, or only under .changeset/, is clear", () => {
  const only = (filename: string) => replayWorld({ commits: [{ sha: sha("aaa111111"), at: "2026-10-08T09:00:00Z", files: [{ filename }], pr: 1, body: "x" }] });
  for (const filename of ["src/x.test.ts", "src/deep/y.spec.mjs", "packages/nvda-speech/z.test.ts"]) assert.equal(readingsAt("2026-10-10T00:00:00Z", only(filename))[0].status, "clear", filename);
  assert.equal(readingsAt("2026-10-10T00:00:00Z", only(".changeset/the-fix.md"))[0].status, "clear", ".changeset/ is not shipped");
  assert.equal(readingsAt("2026-10-10T00:00:00Z", only("src/x.ts"))[0].status, "tripped", "CONTROL: the same commit on a non-test file trips");
});

test("a commit touching a test file AND a shipped file counts; a rename OUT of src/ counts (it changes what ships)", () => {
  const both = replayWorld({ commits: [{ sha: sha("bbb222222"), at: "2026-10-08T09:00:00Z", files: [{ filename: "src/x.test.ts" }, { filename: "src/x.ts" }], pr: 2, body: "" }] });
  assert.equal(readingsAt("2026-10-10T00:00:00Z", both)[0].status, "tripped");
  const moved = replayWorld({ commits: [{ sha: sha("ccc333333"), at: "2026-10-08T09:00:00Z", files: [{ filename: "docs/x.md", previous_filename: "src/x.ts" }], pr: 3, body: "" }] });
  assert.equal(readingsAt("2026-10-10T00:00:00Z", moved)[0].status, "tripped");
});

test("a merge commit is not counted: its own commits carry the pull request", () => {
  const merge = { sha: sha("ddd444444"), at: "2026-10-08T01:00:00Z", files: [{ filename: "src/x.ts" }], pr: 4, body: "", parents: 2 };
  assert.equal(readingsAt("2026-10-10T00:00:00Z", replayWorld({ commits: [merge] }))[0].status, "clear");
});

// --- the declared line -------------------------------------------------------------------------------------------------------------

test("a commit whose pull request body has `no-release: a refactor` is clear and named declared; `no-release:` with no reason trips", () => {
  const declared = replayWorld({ commits: [{ sha: sha("eee555555"), at: "2026-10-08T09:00:00Z", files: [{ filename: "src/x.ts" }], pr: 5, body: "Tidy.\n\nno-release: a refactor\n" }] });
  const [clear] = readingsAt("2026-10-10T00:00:00Z", declared);
  assert.equal(clear.status, "clear");
  assert.match(clear.detail, /nothing unreleased counts/);
  assert.match(clear.detail, /1 more DECLARED no-release and read as not behind: eee555555 \("a refactor"\)/);
  for (const body of ["no-release:", "no-release:   ", "no-release: <reason>", "mentions no-release: in prose after other words"]) {
    const bare = replayWorld({ commits: [{ sha: sha("fff666666"), at: "2026-10-08T09:00:00Z", files: [{ filename: "src/x.ts" }], pr: 6, body }] });
    assert.equal(readingsAt("2026-10-10T00:00:00Z", bare)[0].status, "tripped", JSON.stringify(body));
  }
});

test("a declared commit does not hide an undeclared newer one, and is named beside it", () => {
  const world = replayWorld({ commits: [
    { sha: sha("111aaaaaa"), at: "2026-10-07T09:00:00Z", files: [{ filename: "src/old.ts" }], pr: 7, body: "no-release: tooling" },
    { sha: sha("222bbbbbb"), at: "2026-10-08T09:00:00Z", files: [{ filename: "src/new.ts" }], pr: 8, body: "" }] });
  const [r] = readingsAt("2026-10-10T00:00:00Z", world);
  assert.equal(r.status, "tripped");
  assert.match(r.detail, /oldest unreleased commit on a releasable path 222bbbbbb/, "the declared one is not the oldest that counts");
  assert.match(r.detail, /1 more DECLARED no-release and read as not behind: 111aaaaaa \("tooling"\)/);
});

test("the predicate agrees with the gate's: a11ign/toolchain scripts/changeset-required.mjs (row 1, a11ign/a11ign#4127) decides these the same way", () => {
  // THE GATE'S CASES, restated. If toolchain moves one of the four rules (TEST_FILE, the releasable prefix, NO_RELEASE_LINE, PLACEHOLDER), this table moves with it.
  const paths = ["src/", "packages/nvda-speech/"];
  const shipped: [string, boolean][] = [["src/a.ts", true], ["src/a/b.mjs", true], ["packages/nvda-speech/x.ts", true], ["src/a.test.ts", false], ["src/a.spec.js", false],
    ["src/a.test", true], ["src/atest.ts", true], ["lib/a.ts", false], ["srcs/a.ts", false], [".changeset/a.md", false], ["docs/src/a.ts", false]];
  for (const [path, expected] of shipped) assert.equal(isShipped(path, paths), expected, path);
  // A changeset sits under no real releasable path, so the exclusion is reached only by a prefix that matches everything; the control is the same prefix on a source file.
  assert.equal(isShipped(".changeset/a.md", [""]), false, "a changeset is not shipped even under a catch-all prefix");
  assert.equal(isShipped("src/a.ts", [""]), true, "CONTROL: the same prefix counts a source file");
  const reasons: [string, string | null][] = [["no-release: a refactor", "a refactor"], ["  no-release:   x  ", "x"], ["a\r\nno-release: crlf\r\nb", "crlf"], ["no-release:", null],
    ["no-release: <reason>", null], ["NO-RELEASE: x", null], ["see no-release: x", null], ["no-release:\nno-release: second", "second"], ["", null]];
  for (const [body, expected] of reasons) assert.equal(noReleaseReason(body), expected, JSON.stringify(body));
});

// --- never released, the budget on the commits ------------------------------------------------------------------------------------

test("a repository that never released says `never released` and trips on the same 24 h clock; one under 24 h is clear", () => {
  const never = (kind: "npm" | "tag"): [World, any] => kind === "npm"
    ? [replayWorld({ registryStatus: "404" }), WORKER_REPOSITORY]
    : [replayWorld({ releases: [], time: undefined }), { repo: WORKER, release: { kind: "tag" }, releasablePaths: WORKER_PATHS }];
  for (const kind of ["npm", "tag"] as const) {
    const [world, repository] = never(kind);
    const [r] = releaseBehindReadings({ now: at("2026-10-09T10:00:00Z"), behind: [factOf(world, repository)] });
    assert.equal(r.status, "tripped", kind);
    assert.match(r.detail, /latest release never released/, kind);
    assert.equal(releaseBehindReadings({ now: at("2026-10-08T11:00:00Z"), behind: [factOf(world, repository)] })[0].status, "clear", kind);
  }
});

test("a long unreleased tail is bounded to the oldest 20: found in them it trips and says what it did not read; found in none it is UNKNOWN, never clear", () => {
  const commits = (shippedFirst: boolean) => Array.from({ length: 25 }, (_, i) => ({ sha: sha(`a${String(i).padStart(2, "0")}`), at: `2026-10-08T${String(i % 24).padStart(2, "0")}:00:00Z`,
    pr: 100 + i, body: "", files: [{ filename: shippedFirst && i === 0 ? "src/real.ts" : `src/t${i}.test.ts` }] }))
    .map((c, i) => ({ ...c, at: new Date(at("2026-10-07T00:00:00Z") + i * 60_000).toISOString() }));
  const tripped = readingsAt("2026-10-10T00:00:00Z", replayWorld({ commits: commits(true) }))[0];
  assert.equal(tripped.status, "tripped");
  assert.match(tripped.detail, /5 newer commit\(s\) not examined/);
  const unread = readingsAt("2026-10-10T00:00:00Z", replayWorld({ commits: commits(false) }))[0];
  assert.equal(unread.status, "unknown", "20 test-only commits examined, 5 not: nothing was found, and 'clear' would claim the 5 were read");
  assert.match(unread.detail, /5 newer commit\(s\) not examined/);
});

// --- the reader: tag against npm, a refusal ---------------------------------------------------------------------------------------

test("a `tag` repository reads the latest GitHub Release and never the registry", () => {
  const repository = { repo: "a11ign/agent-org", release: { kind: "tag" as const }, releasablePaths: ["src/"] };
  const world: World = { commits: [{ sha: sha("abc123456"), at: "2026-10-08T09:00:00Z", files: [{ filename: "src/a.ts" }], pr: 9, body: "" }],
    releases: [{ tag: "v0.80.0", at: "2026-10-05T00:00:00Z" }, { tag: "v0.82.0", at: "2026-10-07T00:00:00Z" }, { tag: "v0.81.0", at: "2026-10-06T00:00:00Z" }] };
  const io = fakes({ [repository.repo]: world });
  const fact = readRepoFact(io, repository) as any;
  assert.deepEqual([fact.release.name, fact.release.version, fact.release.at], ["a11ign/agent-org", "v0.82.0", at("2026-10-07T00:00:00Z")], "the newest by time, whatever order the list came in");
  assert.deepEqual(io.registryCalls, []);
  assert.ok(io.calls.some((c) => c.some((a) => a.endsWith("/releases"))), "CONTROL: the Releases were read");
  assert.equal(releaseBehindReadings({ now: at("2026-10-10T00:00:00Z"), behind: [fact] })[0].status, "tripped");
});

test("an `npm` repository reads the registry and never the Releases; a registry that answers 500 is unknown", () => {
  const io = fakes({ [WORKER]: replayWorld() });
  const fact = readRepoFact(io, WORKER_REPOSITORY) as any;
  assert.equal(fact.release.version, "0.3.0");
  assert.deepEqual(io.registryCalls, [PACKAGE]);
  assert.ok(!io.calls.some((c) => c.some((a) => a.endsWith("/releases"))));
  const refused = factOf(replayWorld({ registryStatus: "500" })) as any;
  assert.match(refused.unreadable, /the registry answered HTTP 500 for @a11ign\/screenreader-worker/);
  assert.equal(releaseBehindReadings({ now: at("2026-10-10T00:00:00Z"), behind: [refused] })[0].status, "unknown");
});

test("a refused read of one repository is unknown and the OTHER repositories are still read", () => {
  const other = { repo: "a11ign/lab", release: { kind: "tag" as const }, releasablePaths: ["packages/lab/"] };
  const io = fakes({ [WORKER]: replayWorld(), [other.repo]: { commits: [{ sha: sha("lab111111"), at: "2026-10-06T00:00:00Z", files: [{ filename: "packages/lab/a.ts" }], pr: 3, body: "" }],
    releases: [{ tag: "v1.0.0", at: "2026-10-01T00:00:00Z" }] } }, { refuse: [WORKER] });
  const facts = readReleaseBehind({ ...io, repositories: [WORKER_REPOSITORY, other] });
  assert.match((facts[0] as any).unreadable, /HTTP 403/);
  assert.equal((facts[1] as any).release.version, "v1.0.0", "the second was read after the first was refused");
  const readings = releaseBehindReadings({ now: at("2026-10-10T00:00:00Z"), behind: facts });
  assert.deepEqual(readings.map((r) => r.status), ["tripped", "unknown"], "a trip is not hidden by an unknown, and the unknown is not hidden by a trip");
  assert.match(readings[0].detail, /a11ign\/lab is BEHIND/);
  assert.match(readings[1].detail, new RegExp(`${WORKER}: could not be read`));
});

test("an answer that is not a list is a stated gap, and so is a listing that cannot be parsed", () => {
  const world = replayWorld();
  const io = fakes({ [WORKER]: world });
  const broken = readRepoFact({ gh: () => "<html>rate limited</html>", registry: io.registry }, WORKER_REPOSITORY) as any;
  assert.match(broken.unreadable, /could not be read/);
  assert.equal(releaseBehindReadings({ now: at("2026-10-10T00:00:00Z"), behind: [broken] })[0].status, "unknown");
  assert.equal(releaseBehindReadings({ now: at("2026-10-10T00:00:00Z"), behind: null })[0].status, "unknown");
});

// --- the price: one read an hour -------------------------------------------------------------------------------------------------

test("two calls inside one hour make ONE read (the cache), a call an hour later makes another", () => {
  const dir = mkdtempSync(join(SCRATCH, "state-"));
  const t0 = at("2026-10-09T10:00:00Z");
  let reads = 0;
  const read = () => { reads += 1; return [factOf(replayWorld())]; };
  const first = cachedReleaseBehind({ stateDir: dir, now: t0, read });
  const second = cachedReleaseBehind({ stateDir: dir, now: t0 + 2 * 60_000, read });
  assert.equal(reads, 1, "the tick is every two minutes");
  assert.deepEqual(second, first);
  cachedReleaseBehind({ stateDir: dir, now: t0 + READ_INTERVAL_MS - 1, read });
  assert.equal(reads, 1, "CONTROL: a millisecond short of the hour is still the same read");
  cachedReleaseBehind({ stateDir: dir, now: t0 + READ_INTERVAL_MS, read });
  assert.equal(reads, 2, "an hour later makes another");
});

test("the kept facts are judged against the clock of each tick: the line is crossed on the tick it is crossed, not on the next read", () => {
  const dir = mkdtempSync(join(SCRATCH, "state-"));
  let reads = 0;
  const read = () => { reads += 1; return [factOf(replayWorld())]; };
  const before = at("2026-10-09T09:30:00Z");
  const status = (now: number) => releaseBehindReadings({ now, behind: cachedReleaseBehind({ stateDir: dir, now, read }) })[0].status;
  assert.equal(status(before), "clear");
  assert.equal(status(before + 30 * 60_000), "tripped", "15 minutes past the line, from the facts read half an hour before");
  assert.equal(reads, 1);
});

test("a cache that is unreadable, from the future, or unwritable is a miss and never an error", () => {
  const dir = mkdtempSync(join(SCRATCH, "state-"));
  let reads = 0;
  const read = () => { reads += 1; return [factOf(replayWorld())]; };
  writeFileSync(join(dir, CACHE_FILE), "not json");
  cachedReleaseBehind({ stateDir: dir, now: at("2026-10-09T10:00:00Z"), read });
  assert.equal(reads, 1);
  writeFileSync(join(dir, CACHE_FILE), JSON.stringify({ readAt: at("2026-10-20T00:00:00Z"), facts: [] }));
  assert.equal(cachedReleaseBehind({ stateDir: dir, now: at("2026-10-09T10:00:00Z"), read }).length, 1, "a readAt in the future is a miss, not a fact kept for ever");
  assert.equal(reads, 2);
  assert.equal(cachedReleaseBehind({ stateDir: join(dir, "missing", "dir"), now: at("2026-10-09T10:00:00Z"), read }).length, 1);
  assert.equal(reads, 3);
});

test("the calls one read spends: a release, one listing per releasable path, and two per unreleased commit", () => {
  const io = fakes({ [WORKER]: replayWorld() });
  readRepoFact(io, WORKER_REPOSITORY);
  const named = (needle: string) => io.calls.filter((c) => c.some((a) => a.includes(needle))).length;
  assert.equal(io.registryCalls.length, 1, "npm: the registry, no gh call for the release");
  assert.equal(named("/commits") - named("/pulls") - 3, 2, "two listings (src/ and packages/nvda-speech/), the other three are one per-commit file read each");
  assert.equal(named("/pulls"), 3);
  assert.equal(io.calls.length, 2 + 3 + 3);
});

// --- the signal through the org-health path ------------------------------------------------------------------------------------

const QUIET = { now: at("2026-10-09T10:00:00Z"), lastMergedAt: at("2026-10-09T09:00:00Z"), work: { greenPrs: 0, claimableRows: 0 }, redPrs: [], refusals: {},
  drift: { behind: 0, ahead: 0, dirty: [] }, primarySince: null };
const noCopies = () => [{ original: "a.mjs", copy: "b.mjs", originalText: null, copyText: "", allowedLines: 0 }];

test("the signal is in the readings only when the fact is given, and its order names what to do", () => {
  assert.equal(SIGNALS.RELEASE_BEHIND_MAIN, SIGNAL);
  assert.equal(orgHealthReadings({ ...QUIET, autoOff: { refusal: null, readAt: QUIET.now } } as never).some((r) => r.signal === SIGNAL), false, "an omitted fact is silent");
  const orders = orgHealthOrders(orgHealthReadings({ ...QUIET, releaseBehind: [factOf(replayWorld())] } as never));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].subject, SIGNAL);
  assert.equal(orders[0].session, "ceo");
  assert.match(orders[0].prompt, /ORG HEALTH: `release-behind-main` HAS TRIPPED\. a11ign\/screenreader-worker is BEHIND ITS OWN main/);
  assert.match(orders[0].prompt, /It first tripped at 2026-10-09T09:45:15Z/);
  assert.match(orders[0].prompt, /ADD THE CHANGESET/);
  assert.match(orders[0].prompt, /no-release: <reason>/);
  assert.equal(orders[0].causeKey, `ceo/org-health/${SIGNAL}@${WORKER}@${sha("6a943efd3")}`);
});

test("the tick says an unread repository on stderr and offers nothing; a level one is silent", () => {
  const said: string[] = [];
  const io = { log: (l: string) => said.push(l), readCopies: noCopies, readAutoOff: () => undefined as never };
  assert.deepEqual(orgHealthTick({ ...QUIET, releaseBehind: null } as never, io), []);
  assert.match(said.join(""), /org-health: release-behind-main UNKNOWN -- the dora repositories could not be listed/);
  const silent: string[] = [];
  assert.deepEqual(orgHealthTick({ ...QUIET, now: at("2026-10-08T11:00:00Z"), releaseBehind: [factOf(replayWorld())] } as never, { ...io, log: (l: string) => silent.push(l) }), []);
  assert.deepEqual(silent, []);
});

test("the gate's own path carries it: orgHealthNow with the fact orders it, and without the reader asks nothing", () => {
  const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
  const tick = (readReleaseBehind?: () => unknown) => orgHealthNow({ prsRead: [], readyRead: [], openRowsRead: [], decideArgs, decided: [] } as never,
    { now: QUIET.now, lastMergedAt: () => QUIET.now, readCaptures: () => undefined, readLabJobs: () => [], readCopies: () => [], log: () => {}, teamAccess: () => undefined,
      readWaits: () => ({ facts: new Map(), stale: [], bare: [], manual: 0 }), ...(readReleaseBehind && { readReleaseBehind }) } as never) as { subject: string }[];
  const ofSignal = (orders: { subject: string }[]) => orders.filter((o) => o.subject === SIGNAL);
  assert.equal(ofSignal(tick(() => [factOf(replayWorld())])).length, 1, "a repository behind its releases is offered by the tick");
  assert.deepEqual(ofSignal(tick()), [], "a caller that does not ask is silent");
  assert.deepEqual(ofSignal(tick(() => [factOf(replayWorld({ time: { ...NPM_TIMES, "0.4.0": "2026-10-08T11:52:00Z" } }))])), [], "a level repository is silent");
});

test("the gate's call site passes the real, cached reader through the identity the tick reads as (#2980's lesson)", () => {
  const gate = readFileSync(fileURLToPath(new URL("./work-gate.ts", import.meta.url)), "utf8");
  assert.match(gate, /readReleaseBehind: releaseBehindNow/);
  assert.match(gate, /cachedReleaseBehind\(\{ stateDir, now: Date\.now\(\), read: \(\) => readReleaseBehind\(\{ gh: defaultRun, registry: npmRegistryRead, repositories \}\) \}\)/);
  assert.ok(!/releaseBehind[^\n]*GH_CONFIG_DIR/.test(gate), "it never picks another account's config (.claude/rules/gh-api-budget.md)");
});
