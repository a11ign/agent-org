// no-token: gh -- `dora.ts` reaches `gh` and the npm registry only through the readers this file injects; nothing imported here reaches the network (#3591)
/**
 * `src/dora.ts`, a11ign/a11ign#3591: A RELEASE WITH NO `gitHead` AND NO TAG TAKES ITS COMMIT FROM ITS PROVENANCE ATTESTATION, AND A NAME RESERVATION IS NOT A RELEASE.
 *
 * The retro of 2026-10-05 read `unknown -- ancestry of #13 could not be read` every day for three repositories: a package published through CI provenance
 * has no `gitHead` in its registry document and its repository has no tag, so its release had no commit and a recent release that cannot be placed is
 * `unreadable`. The commit IS published, in the version's `slsa.dev/provenance/v1` attestation. The same three packages also carried the placeholder versions
 * `0.0.0-reserved.0` / `0.0.0-stage` that held their names, each counted as a release of its own.
 *
 * THE POPULATION IS DERIVED, NOT LISTED: every `npm` entry of `dora` in the project's declaration (the acceptance command points `AGENT_ORG_HOST` at it) is
 * run through the resolver with a registry document of ITS package name, once per shape. POSITIVE CONTROLS: the `gitHead` shape is the unchanged behaviour and
 * must never ask for an attestation; the population is asserted to hold the three repositories of the retro, so an empty one cannot pass; and the
 * "neither" shape stays `unknown`, so an attestation that cannot be read is never read as `false`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitFromAttestations, isNameReservation, measureRepository, npmReleasesFrom } from "./dora.ts";
import { homeProjectDeclaration } from "./project-config.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const NOW = Date.parse("2026-10-05T12:00:00Z");
const SINCE = "2026-09-21T12:00:00.000Z";
const PUBLISHED = "2026-10-04T09:37:41.806Z";
const MERGED = "2026-10-04T08:00:00Z";
const GIT_HEAD = "1111111111111111111111111111111111111111";
const ATTESTED = "8fa93b1c6ba9d9ccfabe8c39eadc6318c4fd5449";
const PROVENANCE = "https://slsa.dev/provenance/v1";
const PUBLISH_ATTESTATION = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";

const envelope = (statement: object) => ({ bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } });
/** The registry's attestations document for one version: the publish attestation (which names no commit) beside the provenance one, as read for `documents@0.1.0`. */
const attestationsFor = (commit: unknown) => ({ attestations: [
  { predicateType: PUBLISH_ATTESTATION, ...envelope({ predicate: { name: "@a11ign/documents", version: "0.1.0" } }) },
  { predicateType: PROVENANCE, ...envelope({ predicate: { buildDefinition: { resolvedDependencies: [{ uri: "git+https://github.com/a11ign/documents@refs/heads/main", digest: { gitCommit: commit } }] } } }) },
] });

/** A registry document of the shape the registry returns: the real one's versions, reservation and all. `meta` is what the version's entry carries. */
const registryDocument = (meta: Record<string, unknown>) => ({
  versions: { "0.0.0-reserved.0": {}, "0.0.0-stage": {}, "0.1.0": meta },
  time: { "0.0.0-reserved.0": "2026-10-04T09:24:21.667Z", "0.0.0-stage": "2026-10-04T09:30:00.000Z", "0.1.0": PUBLISHED },
});

/** Readers that count their calls, so the cost of the attestation read is a measured number and not a sentence. */
function readers(options: { tags?: Record<string, string>; attestations?: Record<string, unknown> }) {
  const calls = { tag: [] as string[], attestation: [] as string[] };
  return {
    calls,
    commits: {
      commitOf: (_repo: string, ref: string) => { calls.tag.push(ref); return options.tags?.[ref] ?? null; },
      attestedCommit: (pkg: string, version: string) => {
        calls.attestation.push(`${pkg}@${version}`);
        const document = options.attestations?.[version];
        return document === undefined ? null : commitFromAttestations(document);
      },
    },
  };
}

const npmEntries = (): Any[] => (homeProjectDeclaration().dora as Any[]).filter((entry) => entry.release.kind === "npm");

test("the population is derived from the declaration and holds the three repositories of the retro", () => {
  const repos = npmEntries().map((entry) => entry.repo);
  for (const expected of ["a11ign/screenreader-worker", "a11ign/screenreader-fleet", "a11ign/documents"]) assert.ok(repos.includes(expected), `${expected} is declared`);
});

test("(1) CONTROL: a version with a gitHead keeps it, and no tag and no attestation is asked for", () => {
  for (const repository of npmEntries()) {
    const { calls, commits } = readers({});
    const releases = npmReleasesFrom({ document: registryDocument({ gitHead: GIT_HEAD }), repository, since: SINCE, commits });
    assert.deepEqual(releases.map((release: Any) => [release.id, release.commit]), [["0.1.0", GIT_HEAD]], repository.repo);
    assert.deepEqual(calls, { tag: [], attestation: [] }, `${repository.repo}: nothing asked for`);
  }
});

test("(2) a version with no gitHead and no tag takes its commit from the attestation", () => {
  for (const repository of npmEntries()) {
    const { calls, commits } = readers({ attestations: { "0.1.0": attestationsFor(ATTESTED) } });
    const releases = npmReleasesFrom({ document: registryDocument({}), repository, since: SINCE, commits });
    assert.deepEqual(releases.map((release: Any) => [release.id, release.commit]), [["0.1.0", ATTESTED]], repository.repo);
    assert.deepEqual(calls.attestation, [`${repository.release.package}@0.1.0`], `${repository.repo}: the cost is ONE attestation request for the one release`);
  }
});

test("(2b) a tag that resolves wins, and the attestation is not asked for", () => {
  const [repository] = npmEntries();
  const { calls, commits } = readers({ tags: { "v0.1.0": GIT_HEAD }, attestations: { "0.1.0": attestationsFor(ATTESTED) } });
  const releases = npmReleasesFrom({ document: registryDocument({}), repository, since: SINCE, commits });
  assert.equal(releases[0].commit, GIT_HEAD);
  assert.deepEqual(calls.attestation, []);
});

test("(3) NEITHER: a version whose attestation cannot be read has no commit, and Lead time is unknown, never false", () => {
  for (const repository of npmEntries()) {
    const { commits } = readers({});
    const releases = npmReleasesFrom({ document: registryDocument({}), repository, since: SINCE, commits });
    assert.equal(releases[0].commit, null, repository.repo);
    const reading = measureRepository(repository, world(releases, repository), NOW) as Any;
    assert.equal(reading.leadTime, null);
    assert.equal(reading.reasons.leadTime, "ancestry of #13 could not be read");
  }
});

test("(4) Lead time prints a number once the commit is placed: the same world as (3) with the attestation readable", () => {
  for (const repository of npmEntries()) {
    const { commits } = readers({ attestations: { "0.1.0": attestationsFor(ATTESTED) } });
    const releases = npmReleasesFrom({ document: registryDocument({}), repository, since: SINCE, commits });
    const reading = measureRepository(repository, world(releases, repository), NOW) as Any;
    assert.equal(reading.status, "read");
    assert.equal(reading.leadTime.changes, 1);
    assert.ok(Math.abs(reading.leadTime.medianMinutes - 97.697) < 0.001, `merge 08:00:00Z to publish 09:37:41.806Z is 97.697 minutes, read ${reading.leadTime.medianMinutes}`);
    assert.equal(reading.reasons.leadTime, undefined, "lead time has no reason to give; this world has no promotions reader, so only the channel readings (#3949) are `unknown`");
  }
});

test("(5) a name reservation is not a release for any metric, and is never looked up", () => {
  const [repository] = npmEntries();
  const { calls, commits } = readers({ attestations: { "0.1.0": attestationsFor(ATTESTED) } });
  const releases = npmReleasesFrom({ document: registryDocument({}), repository, since: SINCE, commits });
  assert.deepEqual(releases.map((release: Any) => release.id), ["0.1.0"], "two reservations and one release read as ONE release");
  assert.deepEqual(calls.tag, ["v0.1.0"]);
  const reading = measureRepository(repository, world(releases, repository), NOW) as Any;
  assert.equal(reading.deploymentFrequency.value, 1);
  assert.deepEqual([isNameReservation("0.0.0-reserved.0"), isNameReservation("0.0.0-stage"), isNameReservation("0.1.0"), isNameReservation("0.0.1"), isNameReservation("1.0.0-rc.1")], [true, true, false, false, false]);
});

test("(5b) a package that holds only reservations is `no release yet`, not a release of nothing", () => {
  const [repository] = npmEntries();
  const document = { versions: { "0.0.0-reserved.0": {} }, time: { "0.0.0-reserved.0": PUBLISHED } };
  const releases = npmReleasesFrom({ document, repository, since: SINCE, commits: readers({}).commits });
  assert.deepEqual(releases, []);
  assert.equal((measureRepository(repository, { ...world(releases, repository), mergedPrs: () => [] }, NOW) as Any).status, "no release yet");
});

test("(6) a release older than the window is not looked up at all", () => {
  const [repository] = npmEntries();
  const { calls, commits } = readers({ attestations: { "0.1.0": attestationsFor(ATTESTED) } });
  const document = { versions: { "0.1.0": {} }, time: { "0.1.0": "2026-08-01T00:00:00.000Z" } };
  assert.equal(npmReleasesFrom({ document, repository, since: SINCE, commits })[0].commit, null);
  assert.deepEqual(calls, { tag: [], attestation: [] });
});

test("(7) the attestation reader takes only a provenance statement's 40-hex gitCommit, and everything else is null", () => {
  assert.equal(commitFromAttestations(attestationsFor(ATTESTED)), ATTESTED, "control: the real shape reads");
  const unreadable: [string, unknown][] = [
    ["a commit that is not 40 hex", attestationsFor("8fa93b1")],
    ["a commit that is not a string", attestationsFor(42)],
    ["only the publish attestation", { attestations: [attestationsFor(ATTESTED).attestations[0]] }],
    ["a payload that is not base64 JSON", { attestations: [{ predicateType: PROVENANCE, bundle: { dsseEnvelope: { payload: "%%%" } } }] }],
    ["no payload", { attestations: [{ predicateType: PROVENANCE }] }],
    ["no attestations", {}],
    ["not an object", null],
  ];
  for (const [name, document] of unreadable) assert.equal(commitFromAttestations(document), null, name);
});

/**
 * One repository's world around a release list: the merged pull request #13 whose merge commit is the one the release was cut from. ITS PATHS ARE DERIVED
 * FROM THE REPOSITORY'S OWN `releasablePaths`, because the population is derived and a fixed list of paths held only the repositories that existed when it
 * was written: `a11ign/toolchain` (a11ign/a11ign#3719) declares `packages/toolchain/`, none of the four paths this listed, so its one change read as not
 * releasable and (3) and (4) failed on a declaration that was right. `docs/notes.md` is under no repository's paths and keeps the filter honest: the change
 * counts because of the releasable path, and not because every path counts.
 */
function world(releases: Any[], repository: Any) {
  return {
    releases: () => releases,
    mergedPrs: () => [{ number: 13, mergedAt: MERGED, mergeCommit: ATTESTED, paths: [...(repository.releasablePaths as string[]).map((path) => `${path}index.ts`), "docs/notes.md"] }],
    regressions: () => [],
    range: () => ({ status: "identical", commits: [] }),
  };
}
