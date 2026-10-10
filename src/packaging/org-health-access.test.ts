// no-token: gh -- pure: the reading is a function of values handed in, `readTeamAccess` is given a fake `run` and a fake `read`, and `orgHealthNow` is given a `teamAccess` seam; nothing here reaches the real `gh`
/**
 * `src/org-health.ts`, a11ign/a11ign#3634: THE `bots` TEAM'S LEVEL ON EVERY REPOSITORY IT REACHES IS READ AGAINST THE PROJECT'S DECLARATION, and a read that cannot run is UNKNOWN, never clear.
 *
 * POSITIVE CONTROL: the 2026-10-05 reading as the row recorded it, `a11ign/auth-capture-check` at `admin` for `bots` while six declared repositories are `push`. It trips and names
 * that repository; every "clear" and every "unknown" below is only worth anything because it does, and each is run beside the same listing with one field changed.
 * THE REPOSITORIES ARE WRITTEN OUT AS LITERALS, never derived from the declaration under test.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The module under test resolves the project it serves at import, so it is handed the fixture project (which declares no `teamAccess`, so the gate's default reader makes no call here).
const SCRATCH = mkdtempSync(join(tmpdir(), "org-health-access-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { SIGNALS, teamAccessReading, readTeamAccess, parseTeamListing, orgHealthReadings } = await import("../org-health.ts");
const { orgHealthNow } = await import("../work-gate/org-health.ts");

const DECLARED = ["a11ign/a11ign", "a11ign/agent-org", "a11ign/screenreader-worker"];
const listing = (rows: Record<string, string>) => Object.entries(rows).map(([repo, level]) => ({ repo, level }));
const clean = listing({ "a11ign/a11ign": "push", "a11ign/agent-org": "push", "a11ign/screenreader-worker": "push" });
const access = (reached: unknown, why = "", exceptions?: Record<string, string>) => ({ teams: [{ team: "bots", layer: "push", exceptions, declared: DECLARED, reached, why }] }) as never;
const read = (reached: unknown, why?: string, exceptions?: Record<string, string>) => teamAccessReading({ access: access(reached, why, exceptions) });

test("#3634: an admin team level on a repository the team reaches trips and names it (the positive control)", () => {
  const stranger = read([...clean, ...listing({ "a11ign/auth-capture-check": "admin" })]);
  assert.equal(stranger.status, "tripped");
  assert.match(stranger.detail, /a11ign\/auth-capture-check: the bots team holds admin and is not declared/);
  assert.equal(stranger.discriminator, "team-access-drifted@bots:a11ign/auth-capture-check");

  const declaredAdmin = read(listing({ ...Object.fromEntries(clean.map((r) => [r.repo, r.level])), "a11ign/screenreader-worker": "admin" }));
  assert.equal(declaredAdmin.status, "tripped");
  assert.match(declaredAdmin.detail, /a11ign\/screenreader-worker: the bots team holds admin, declared push/);
});

test("#3634: a declared repository at another level, or not reached at all, trips; an undeclared one below admin does not", () => {
  const lower = read(clean.map((r) => (r.repo === "a11ign/agent-org" ? { ...r, level: "pull" } : r)));
  assert.match(lower.detail, /a11ign\/agent-org: the bots team holds pull, declared push/);
  const absent = read(clean.filter((r) => r.repo !== "a11ign/agent-org"));
  assert.match(absent.detail, /a11ign\/agent-org: the bots team holds none, declared push/);
  assert.equal(read([...clean, ...listing({ "a11ign/other": "push" })]).status, "clear");
});

test("#3634: a second repository is a new trip: the discriminator names every one, sorted", () => {
  const two = read([...clean, ...listing({ "a11ign/z-late": "admin", "a11ign/auth-capture-check": "admin" })]);
  assert.equal(two.discriminator, "team-access-drifted@bots:a11ign/auth-capture-check,bots:a11ign/z-late");
});

test("#3634: a clean read is clear", () => {
  assert.deepEqual(read(clean), { signal: SIGNALS.TEAM_ACCESS, status: "clear", detail: "" });
});

test("#3634: a read that could not run, an empty listing and an unreadable declaration are unknown, never clear", () => {
  const refused = read(null, "gh: Not Found (HTTP 404)");
  assert.equal(refused.status, "unknown");
  assert.match(refused.detail, /CANNOT_TELL.*bots \(gh: Not Found \(HTTP 404\)\)/);
  const empty = read([]);
  assert.equal(empty.status, "unknown");
  assert.match(empty.detail, /reaches no repository/);
  assert.equal(teamAccessReading({ access: { unreadable: "the declaration could not be read (CANNOT_TELL)" } }).status, "unknown");
  assert.equal(teamAccessReading({ access: { teams: [] } }).status, "unknown");
  // a trip stands over a team that was not read, and an unread team beside a clean one stays unknown
  const mixed = { teams: [...(access(clean) as { teams: unknown[] }).teams, { team: "ci", layer: "push", declared: DECLARED, reached: null, why: "HTTP 404" }] } as never;
  assert.equal(teamAccessReading({ access: mixed }).status, "unknown");
});

test("#3634: the listing parser reads the highest true level and refuses a partial line", () => {
  assert.deepEqual(parseTeamListing("a/x\ttrue\ttrue\ttrue\ttrue\ttrue\na/y\tfalse\tfalse\ttrue\ttrue\ttrue\na/z\tfalse\tfalse\tfalse\tfalse\ttrue\na/n\tfalse\tfalse\tfalse\tfalse\tfalse\n"),
    [{ repo: "a/x", level: "admin" }, { repo: "a/y", level: "push" }, { repo: "a/z", level: "pull" }, { repo: "a/n", level: "none" }]);
  assert.equal(parseTeamListing("a/x\ttrue\ttrue"), null);
  assert.deepEqual(parseTeamListing(""), []);
});

// #4467: a team deliberately kept below the layer on one repository. `a11ign/.github` is the real case: `bots` stays off it, the declaration lists it, and the exception says so.
const WITH_DOTGITHUB = ["a11ign/.github", ...DECLARED];
const KEPT_OFF = { "a11ign/.github": "none" };
const readKeptOff = (reached: unknown, exceptions: Record<string, string> | null = KEPT_OFF) => teamAccessReading({
  access: { teams: [{ team: "bots", layer: "push", exceptions: exceptions ?? undefined, declared: WITH_DOTGITHUB, reached, why: "" }] } as never });

test("#4467: an exception of none is clear when the team holds none there, and tripped when it holds push", () => {
  assert.deepEqual(readKeptOff(clean), { signal: SIGNALS.TEAM_ACCESS, status: "clear", detail: "" });
  const reaches = readKeptOff([...clean, ...listing({ "a11ign/.github": "push" })]);
  assert.equal(reaches.status, "tripped");
  assert.match(reaches.detail, /a11ign\/\.github: the bots team holds push, declared none/);
  assert.equal(reaches.discriminator, "team-access-drifted@bots:a11ign/.github");
});

test("#4467: without the exception the same listing still trips (the control: the exception is what makes the first case clear)", () => {
  const without = readKeptOff(clean, null);
  assert.equal(without.status, "tripped");
  assert.match(without.detail, /a11ign\/\.github: the bots team holds none, declared push/);
  assert.equal(readKeptOff(clean, {}).status, "tripped");
});

test("#4467: an exception does not loosen the other repositories, nor admin on the excepted one", () => {
  const lowerElsewhere = readKeptOff(clean.map((r) => (r.repo === "a11ign/agent-org" ? { ...r, level: "pull" } : r)));
  assert.match(lowerElsewhere.detail, /a11ign\/agent-org: the bots team holds pull, declared push/);
  const admin = readKeptOff([...clean, ...listing({ "a11ign/.github": "admin" })]);
  assert.equal(admin.status, "tripped");
  assert.match(admin.detail, /a11ign\/\.github: the bots team holds admin, declared none/);
  const atException = readKeptOff([...clean, ...listing({ "a11ign/.github": "pull" })], { "a11ign/.github": "pull" });
  assert.equal(atException.status, "clear");
});

const EXCEPTION_FILES = (exceptions: unknown): Record<string, string> => ({ ...FILES, "/p/docs/access.json": JSON.stringify({ teams: { bots: { layer: "push", exceptions } },
  repositories: { "a11ign/a11ign": {}, "a11ign/agent-org": {}, "a11ign/.github": {} } }) });

test("#4467: the reader carries a declared exception to the comparison", () => {
  // `tsv` above writes `maintain` as true on every row, so these two are written out: admin, maintain, push, triage, pull
  const run = () => "a11ign/a11ign\tfalse\tfalse\ttrue\ttrue\ttrue\na11ign/agent-org\tfalse\tfalse\ttrue\ttrue\ttrue";
  const fact = readTeamAccess(run, { root: "/p", read: fakeRead(EXCEPTION_FILES({ _why: "least privilege", "a11ign/.github": "none" })) });
  assert.equal(teamAccessReading({ access: fact as never }).status, "clear");
  const absent = readTeamAccess(run, { root: "/p", read: fakeRead(EXCEPTION_FILES(undefined)) });
  assert.equal(teamAccessReading({ access: absent as never }).status, "tripped", "a declaration with no exceptions behaves as before");
});

test("#4467: an exception naming an undeclared repository, admin, an unknown level or a non-map is unknown, never believed", () => {
  const nope = () => { throw new Error("must not ask"); };
  const refusals: [unknown, RegExp][] = [
    [{ "a11ign/elsewhere": "none" }, /names a11ign\/elsewhere, which `repositories` does not list/],
    [{ "a11ign/.github": "admin" }, /exceptions\.a11ign\/\.github must be one of none, maintain, push, triage, pull/],
    [{ "a11ign/.github": "write" }, /must be one of/],
    [{ "a11ign/.github": 0 }, /must be one of/],
    [["a11ign/.github"], /must map an owner\/name to a level/],
    ["none", /must map an owner\/name to a level/],
    [null, /must map an owner\/name to a level/],
  ];
  for (const [exceptions, why] of refusals) {
    const fact = readTeamAccess(nope, { root: "/p", read: fakeRead(EXCEPTION_FILES(exceptions)) });
    assert.ok(fact && "unreadable" in fact, JSON.stringify(exceptions));
    assert.match(fact.unreadable, why);
    assert.match(fact.unreadable, /CANNOT_TELL/);
    assert.equal(teamAccessReading({ access: fact }).status, "unknown");
  }
});

const FILES: Record<string, string> = {
  "/p/.agent-org/project.json": JSON.stringify({ teamAccess: { declaration: "docs/access.json" } }),
  "/p/docs/access.json": JSON.stringify({ _prose: "x", teams: { _n: "x", bots: { layer: "push" } }, repositories: { _n: "x", "a11ign/a11ign": {}, "a11ign/agent-org": {} } }),
};
const fakeRead = (files: Record<string, string>) => (path: string) => {
  if (!(path in files)) throw new Error(`ENOENT: ${path}`);
  return files[path];
};
const tsv = (rows: [string, string][]) => rows.map(([repo, level]) => `${repo}\t${level === "admin"}\ttrue\t${level !== "pull"}\ttrue\ttrue`).join("\n");

test("#3634: the reader follows the project's key to the declaration and asks GitHub once per team, for the declared org", () => {
  const asked: string[][] = [];
  const run = (args: string[]) => { asked.push(args); return tsv([["a11ign/a11ign", "push"], ["a11ign/agent-org", "admin"]]); };
  const fact = readTeamAccess(run, { root: "/p", read: fakeRead(FILES) });
  assert.equal(asked.length, 1);
  assert.equal(asked[0][1], "orgs/a11ign/teams/bots/repos?per_page=100");
  assert.ok(asked[0].includes("--paginate"));
  assert.equal(teamAccessReading({ access: fact as never }).status, "tripped");
});

test("#3634: a 404 on the team read is unknown, and a project with no teamAccess key makes no call at all", () => {
  const refused = readTeamAccess(() => { throw new Error("gh: Not Found (HTTP 404)"); }, { root: "/p", read: fakeRead(FILES) });
  const reading = teamAccessReading({ access: refused as never });
  assert.equal(reading.status, "unknown");
  assert.match(reading.detail, /HTTP 404/);

  let calls = 0;
  const none = readTeamAccess(() => { calls += 1; return ""; }, { root: "/p", read: fakeRead({ "/p/.agent-org/project.json": "{}" }) });
  assert.equal(none, undefined);
  assert.equal(calls, 0);
});

test("#3634: a malformed key, a path out of the project, a missing file and a declaration of two orgs are named unknowns, never off", () => {
  const nope = () => { throw new Error("must not ask"); };
  const project = (key: unknown) => ({ ...FILES, "/p/.agent-org/project.json": JSON.stringify({ teamAccess: key }) });
  for (const files of [project("docs/access.json"), project({ declaration: "../../etc/x" }), project({ declaration: "docs/gone.json" }),
    { ...FILES, "/p/docs/access.json": JSON.stringify({ teams: { bots: { layer: "push" } }, repositories: { "a/x": {}, "b/y": {} } }) },
    { ...FILES, "/p/docs/access.json": JSON.stringify({ teams: { bots: {} }, repositories: { "a/x": {} } }) }]) {
    const fact = readTeamAccess(nope, { root: "/p", read: fakeRead(files) });
    assert.ok(fact && "unreadable" in fact, JSON.stringify(fact));
    assert.equal(teamAccessReading({ access: fact }).status, "unknown");
  }
});

test("#3634: the tick carries the reading, omits it when not asked, and the order names the repository", () => {
  const facts = { now: 0, lastMergedAt: 0, work: null, redPrs: [], refusals: {}, drift: null, primarySince: null };
  assert.equal(orgHealthReadings(facts as never).some((r) => r.signal === SIGNALS.TEAM_ACCESS), false);
  assert.equal(orgHealthReadings({ ...facts, teamAccess: access(clean) } as never).find((r) => r.signal === SIGNALS.TEAM_ACCESS)?.status, "clear");

  const NOW = Date.parse("2026-10-05T12:00:00Z");
  const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
  const drifted = access([...clean, ...listing({ "a11ign/auth-capture-check": "admin" })]);
  const tick = (teamAccess: () => unknown) => orgHealthNow({ prsRead: [], readyRead: [], openRowsRead: [], decideArgs, decided: [] } as never,
    { now: NOW, lastMergedAt: () => NOW, readCaptures: () => undefined, readLabJobs: () => [], log: () => {}, teamAccess,
      readWaits: () => ({ facts: new Map(), stale: [], bare: [], manual: 0 }) } as never) as { subject: string; session: string; prompt: string }[];
  const order = tick(() => drifted).find((o) => o.subject === SIGNALS.TEAM_ACCESS);
  assert.deepEqual(tick(() => access(clean)).filter((o) => o.subject === SIGNALS.TEAM_ACCESS), [], "clear offers nothing");
  assert.deepEqual(tick(() => undefined).filter((o) => o.subject === SIGNALS.TEAM_ACCESS), [], "not asked offers nothing");
  assert.ok(order, "the drifted team level is offered");
  assert.equal(order.session, "ceo");
  assert.match(order.prompt, /a11ign\/auth-capture-check/);
});
