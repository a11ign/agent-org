/**
 * #2619 (child 3d of #69): THE PROJECT'S VOCABULARY -- the row template's field names and the
 * label/milestone/lane-prefix/shared-resource words the machinery reads (ADR 0040, decision 1, surface 2),
 * read from `.agent-org/project.json`'s `vocabulary` key by `project-vocabulary.mjs`.
 *
 * Four claims, each with its control in this file:
 *   1. a11ign's declaration, read through the reader, gives EXACTLY today's values for every label,
 *      milestone, lane/session/answer prefix, template field, the `Fleet` question and every shared-resource
 *      pattern -- one assertion per constant, including each of the row's own nine labels.
 *   2. a walk of `packages/agent-org/src` finds NO quoted status word, `lane:`/`session:`/`answer:` prefix
 *      or milestone title as a real CODE literal outside the vocabulary module -- the ratchet ADR 0040
 *      measured at 43 files and this row promised to end at 0. Comments are stripped first, this repo's own
 *      convention (`local-import-closure.mjs`'s `stripComments`): a comment MENTIONING a word is not the
 *      same defect as CODE reading it. A handful of exact, counted, reasoned collisions remain and are
 *      named below, never silently absorbed.
 *   3. a SECOND project's vocabulary, run through the same reader, changes what `row-file.mjs` refuses (a
 *      milestone it does not have, a label outside its set), what `row-claim/runner-rule.mjs`'s lane rule
 *      reads, and, with an empty `resources` list, what `acceptance-commands.mjs` would let an Acceptance
 *      run -- through the injectable seams those three files now carry for exactly this reason, mirroring
 *      `row-claim/file-overlap-rule.mjs`'s own `deps` pattern. This is what "project-agnostic" means and the
 *      only thing that shows the reader is not a11ign's constants in a trench coat.
 *   4. each field is REFUSED naming it when missing or mistyped, never answered with a11ign's value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { stripComments } from "../lib/local-import-closure.mjs";
import {
  ACCEPTANCE_FIELD, ANSWER_PREFIX, BACKLOG_LABEL, BLOCKED_LABEL, CLAIM_LABEL, CLOSES_FIELD, FLEET_FIELD,
  FLEET_QUESTION, LANES_FILE_PATH, LANE_ANY_LABEL, LANE_PREFIX, NEEDS_CHAIRMAN_LABEL, OUT_OF_RELEASE_LABEL,
  OUT_OF_RELEASE_MILESTONE, READY_LABEL, RESOURCES, ROAD_TO_VERSION_ONE_MILESTONE, SESSION_PREFIX,
  STARTED_LABEL, WAS_READY_LABEL, parseVocabulary,
} from "../project-vocabulary.mjs";
import { HOME_CHECKOUT, ProjectDeclarationRefusal } from "../project-config.mjs";
import { labelsOutOfRelease, saysOutOfRelease } from "../row-file.mjs";
import { laneReason } from "../row-claim/runner-rule.mjs";
import { resourcePatternsFrom } from "../acceptance-commands.mjs";

// A mutation reaches into fields the fixture's own type would have to pretend are optional and mistyped,
// which is the point of it -- the same tradeoff `project-config.test.ts` accepts for the identical reason.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

// --- 1. a11ign's own values, one assertion per constant ---

test("a11ign's vocabulary holds each of the nine labels the row names", () => {
  assert.equal(READY_LABEL, "ready");
  assert.equal(BACKLOG_LABEL, "backlog");
  assert.equal(CLAIM_LABEL, "in-progress");
  assert.equal(STARTED_LABEL, "started");
  assert.equal(NEEDS_CHAIRMAN_LABEL, "needs:chairman");
  assert.equal(LANE_PREFIX, "lane:");
  assert.equal(SESSION_PREFIX, "session:");
  assert.equal(ANSWER_PREFIX, "answer:");
  assert.equal(OUT_OF_RELEASE_LABEL, "out-of-release");
});

test("a11ign's vocabulary holds today's remaining label, milestone, lane-file and template-field values", () => {
  assert.equal(WAS_READY_LABEL, "was-ready");
  assert.equal(BLOCKED_LABEL, "blocked");
  assert.equal(LANE_ANY_LABEL, "lane:any");
  assert.equal(ROAD_TO_VERSION_ONE_MILESTONE, "Road to version one");
  assert.equal(OUT_OF_RELEASE_MILESTONE, "Out of release");
  assert.equal(LANES_FILE_PATH, "docs/lane-ownership.json");
  assert.equal(ACCEPTANCE_FIELD, "Acceptance");
  assert.equal(CLOSES_FIELD, "Closes");
  assert.equal(FLEET_FIELD, "Fleet");
  assert.equal(FLEET_QUESTION, "Does the acceptance need the fleet or the lab");
});

test("a11ign's vocabulary holds all 15 shared-resource patterns, each with its reason and its `named` flag", () => {
  assert.equal(RESOURCES.length, 15);
  assert.equal(RESOURCES.filter((r) => r.named).length, 5,
    "systemctl, systemd, the Proxmox key, the corpus remote and \"on the lab\" are NAMED, not invoked");
  assert.ok(RESOURCES.some((r) => r.pattern.test("fleet:status")), "the invocation ban still matches fleet:");
  assert.ok(RESOURCES.some((r) => r.pattern.test("systemctl restart x")), "the named ban still matches systemctl");
});

test("POSITIVE CONTROL: a11ign's declaration file on disk carries the vocabulary key, not a constant read into the test", () => {
  const text = readFileSync(join(HOME_CHECKOUT, ".agent-org/project.json"), "utf8");
  assert.ok(text.includes("\"vocabulary\""));
  assert.ok(text.includes("\"needs:chairman\""));
});

// --- 2. the ratchet: no vocabulary literal in CODE outside the vocabulary module ---

const VOCAB_HIT_PATTERN =
  /["'`](ready|backlog|in-progress|started|was-ready|needs:chairman|out-of-release|blocked)["'`]|["'`](lane|session|answer):|Road to version one|Out of release/g;

/** Every CODE (never comment) hit of the scan pattern in one file's text. */
function vocabularyHitsIn(text: string): string[] {
  return [...stripComments(text).matchAll(VOCAB_HIT_PATTERN)].map((m) => m[0]);
}

/** Walk `dir` for `.mjs` files (never `.test.`), absolute path -> its hits; `exclude`d filenames are skipped whole. */
function walkForVocabularyHits(dir: string, exclude: Set<string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (entry.name.endsWith(".mjs") && !/\.test\./.test(entry.name) && !exclude.has(entry.name)) {
        const hits = vocabularyHitsIn(readFileSync(path, "utf8"));
        if (hits.length > 0) found[path] = hits;
      }
    }
  };
  walk(dir);
  return found;
}

test("POSITIVE CONTROL: the walk finds a planted literal in a fixture file", () => {
  const dir = mkdtempSync(join(tmpdir(), "project-vocabulary-walk-"));
  try {
    writeFileSync(join(dir, "planted.mjs"), "export const LABEL = \"needs:chairman\";\n");
    assert.deepEqual(walkForVocabularyHits(dir, new Set()), { [join(dir, "planted.mjs")]: ["\"needs:chairman\""] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POSITIVE CONTROL: a comment MENTIONING a vocabulary word is not a CODE hit", () => {
  const dir = mkdtempSync(join(tmpdir(), "project-vocabulary-walk-comment-"));
  try {
    writeFileSync(join(dir, "commented.mjs"), "// the \"ready\" label, mentioned, never read\nexport const X = 1;\n");
    assert.deepEqual(walkForVocabularyHits(dir, new Set()), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Real collisions with the scan pattern that are NOT this project's vocabulary -- named here, not silently
 * absorbed, the same shape `project-config.test.ts`'s `RECORDED_CARRIERS` takes for surface 1. Each count is
 * EXACT, so a NEW collision is caught the moment it lands and an old one's removal is caught too (shrink the
 * count with it, so the ceiling follows it down).
 */
const KNOWN_NON_VOCABULARY_HITS: Record<string, number> = {
  // The four claim-lifecycle labels: `claim-labels.mjs` is a pinned, import-free LEAF (#804,
  // `ready-label-audit.test.ts`) -- the one file this row does NOT move them out of. See this file's own
  // header and `project-vocabulary.mjs`'s header for why: moving them would either break that leaf's
  // no-import contract or state the same four facts twice, and `project-vocabulary.mjs` imports them from
  // here instead (assertion 1, above, pins the values equal).
  "packages/agent-org/src/claim-labels.mjs": 4,
  // `claim-stall.mjs`'s own `why: "stalled" | "blocked" | "merged"` release-reading enum: a native
  // `blockedBy` GRAPH EDGE outcome (`blockedReading`), never the `blocked` GitHub LABEL -- the same word,
  // an unrelated fact this module invented for its own return type.
  "packages/agent-org/src/claim-stall.mjs": 2,
  // `wake.mjs`: an agent's own `herdr` STATUS (`blockedSessions`, unrelated to the `blocked` label) and
  // `claim-stall.mjs`'s `why: "blocked"` consumed here (`releaseHeadline`) -- both the same non-vocabulary
  // fact as above; plus prose that happens to start a string segment with the English word "answer:"
  // (`REFUSED_CLAIM_IS_AN_ANSWER`: "...that is an answer: report it and stop...").
  "packages/agent-org/src/wake.mjs": 3,
  // `work-gate.mjs`: the same `herdr` STATUS mentioned in a report string, and `run(["pr", "ready", ...])`
  // -- GitHub's own `gh pr ready` CLI verb, not the row `ready` label.
  "packages/agent-org/src/work-gate.mjs": 2,
  // `work-gate/pr-orders.mjs`: `{ kind: "ready", ... }` is the action kind for `gh pr ready` (GitHub's own
  // draft -> ready-for-review CLI verb), not the row `ready` label.
  "packages/agent-org/src/work-gate/pr-orders.mjs": 1,
};

test("#2619 ACCEPTANCE, MUTATION TARGET: a walk of packages/agent-org/src finds no vocabulary literal in "
  + "CODE outside project-vocabulary.mjs and the exact, reasoned exceptions above", () => {
  const found = walkForVocabularyHits(join(HOME_CHECKOUT, "packages/agent-org/src"), new Set(["project-vocabulary.mjs"]));
  const byRelativePath: Record<string, string[]> = {};
  for (const [path, hits] of Object.entries(found)) byRelativePath[relative(HOME_CHECKOUT, path)] = hits;

  const unexpected = Object.fromEntries(Object.entries(byRelativePath)
    .filter(([file, hits]) => hits.length !== (KNOWN_NON_VOCABULARY_HITS[file] ?? 0)));
  assert.deepEqual(unexpected, {},
    "a file carries a vocabulary literal in code this test does not expect -- read it from the vocabulary "
    + "module, or add it to KNOWN_NON_VOCABULARY_HITS with the reason it is not vocabulary");

  // The complement: every DECLARED exception must still be there, so a fixed one is caught by hand rather
  // than the ceiling quietly drifting into slack (the same reciprocal check `RECORDED_CARRIERS` makes).
  for (const [file, count] of Object.entries(KNOWN_NON_VOCABULARY_HITS)) {
    assert.equal((byRelativePath[file] ?? []).length, count, `${file}: expected exactly ${count} known non-vocabulary hit(s)`);
  }
});

// --- 3. a SECOND project's vocabulary changes what row-file refuses, what the lane rule reads, and what an Acceptance may run ---

const SECOND_VOCABULARY = {
  vocabulary: {
    labels: { backlog: "queued", needsChairman: "needs:owner", outOfRelease: "shelved", blocked: "stuck" },
    prefixes: { lane: "team:", session: "handle:", answer: "reply:" },
    milestones: { roadToVersionOne: "Launch", outOfRelease: "Shelved" },
    lanesFile: "config/teams.json",
    templateFields: { acceptance: "DoD", closes: "Fixes", fleet: "Hardware" },
    fleetQuestion: "Does this need real hardware",
    resources: [] as unknown[],
  },
};

test("a SECOND project's vocabulary resolves through the same reader to ITS values, and none of a11ign's", () => {
  const second = parseVocabulary(SECOND_VOCABULARY);
  assert.equal(second.labels.outOfRelease, "shelved");
  assert.equal(second.milestones.outOfRelease, "Shelved");
  assert.equal(second.prefixes.lane, "team:");
  assert.deepEqual(second.resources, []);
  assert.ok(!JSON.stringify(second).includes(OUT_OF_RELEASE_MILESTONE), "the second project's answer must carry nothing of a11ign's");
});

test("a fixture project's DIFFERENT milestone and label change what row-file's release check accepts: a11ign's "
  + "milestone/label mean nothing to the fixture's rule, the fixture's mean nothing to a11ign's (unchanged "
  + "default), and each accepts its own", () => {
  const second = parseVocabulary(SECOND_VOCABULARY);
  assert.equal(saysOutOfRelease(OUT_OF_RELEASE_MILESTONE, second.milestones.outOfRelease), false,
    "a11ign's milestone title is not the milestone a fixture project without it declares");
  assert.equal(saysOutOfRelease(second.milestones.outOfRelease), false,
    "the fixture's milestone title means nothing to a11ign's own (unchanged, default) rule");
  assert.equal(saysOutOfRelease(OUT_OF_RELEASE_MILESTONE), true, "a11ign's rule still accepts its own milestone");
  assert.equal(saysOutOfRelease(second.milestones.outOfRelease, second.milestones.outOfRelease), true,
    "the SAME comparison, given the fixture's own milestone on both sides, accepts it");

  assert.equal(labelsOutOfRelease(["--label", OUT_OF_RELEASE_LABEL], second.labels.outOfRelease), false,
    "a11ign's label is outside the fixture project's set");
  assert.equal(labelsOutOfRelease(["--label", second.labels.outOfRelease], second.labels.outOfRelease), true,
    "the fixture project's own label is accepted by the same check");
});

test("a fixture project's DIFFERENT lane prefix changes what the lane rule reads: a11ign's `lane:` label is "
  + "invisible to it, and its OWN prefix reserves exactly as `lane:` does for a11ign", () => {
  const second = parseVocabulary(SECOND_VOCABULARY);
  assert.equal(laneReason(["lane:ceo"], "worker-1", { liveSessions: ["ceo"], lanePrefix: second.prefixes.lane }), null,
    "a11ign's lane label means nothing to a rule reading the fixture's own prefix");
  const reason = laneReason(["team:ceo"], "worker-1", { liveSessions: ["ceo"], lanePrefix: second.prefixes.lane });
  assert.match(String(reason), /team:/);
  assert.match(String(reason), /ceo/);
  // and a11ign's OWN prefix, unchanged (the default), still reads a11ign's OWN labels:
  const own = String(laneReason(["lane:ceo"], "worker-1", { liveSessions: ["ceo"] }));
  assert.match(own, /lane:/);
  assert.match(own, /ceo/);
});

test("with an EMPTY resources list, an Acceptance may run a `fleet:` command a11ign's declaration refuses", () => {
  const home = resourcePatternsFrom(RESOURCES);
  const second = resourcePatternsFrom(parseVocabulary(SECOND_VOCABULARY).resources);
  assert.ok(home.patterns.some(([pattern]) => pattern.test("fleet:status")), "a11ign's declaration refuses fleet:status");
  assert.equal(second.patterns.length, 0, "the fixture project's empty resources list bans nothing");
  assert.equal(second.namedNotInvoked.size, 0);
});

// --- 4. a missing or mistyped field is REFUSED naming it ---

/** A VALID `vocabulary` document, mutated one field at a time below. */
const VALID_VOCABULARY = {
  vocabulary: {
    labels: { backlog: "backlog", needsChairman: "needs:chairman", outOfRelease: "out-of-release", blocked: "blocked" },
    prefixes: { lane: "lane:", session: "session:", answer: "answer:" },
    milestones: { roadToVersionOne: "Road to version one", outOfRelease: "Out of release" },
    lanesFile: "docs/lane-ownership.json",
    templateFields: { acceptance: "Acceptance", closes: "Closes", fleet: "Fleet" },
    fleetQuestion: "Does the acceptance need the fleet or the lab",
    resources: [{ pattern: "\\bfleet:", reason: "reaches the fleet", named: false }],
  },
};

/** @param mutate the ONE change that makes the document invalid */
function mutated(mutate: (document: Loose) => void): Loose {
  const copy = JSON.parse(JSON.stringify(VALID_VOCABULARY));
  mutate(copy);
  return copy;
}

/** Run `parsed` through `parseVocabulary` and return the refusal it must produce. */
function refusalOf(parsed: unknown): ProjectDeclarationRefusal {
  try {
    parseVocabulary(parsed);
  } catch (error) {
    assert.ok(error instanceof ProjectDeclarationRefusal, `expected a ProjectDeclarationRefusal, got ${String(error)}`);
    return error as ProjectDeclarationRefusal;
  }
  return assert.fail("the declaration was ACCEPTED where a refusal was required");
}

/** @param field the field the refusal must name, and the message must repeat it */
function assertRefusedFor(parsed: unknown, field: string): void {
  const refusal = refusalOf(parsed);
  assert.equal(refusal.field, field, refusal.message);
  assert.ok(refusal.message.includes(`\`${field}\``), `the message must name the field: ${refusal.message}`);
}

test("POSITIVE CONTROL: the unmutated base of every refusal below is ACCEPTED", () => {
  const v = parseVocabulary(VALID_VOCABULARY);
  assert.equal(v.labels.backlog, "backlog");
});

test("a MISSING field is refused naming that field", () => {
  assertRefusedFor(mutated((d) => delete d.vocabulary), "vocabulary");
  assertRefusedFor(mutated((d) => delete d.vocabulary.labels), "vocabulary.labels");
  assertRefusedFor(mutated((d) => delete d.vocabulary.labels.backlog), "vocabulary.labels.backlog");
  assertRefusedFor(mutated((d) => delete d.vocabulary.labels.needsChairman), "vocabulary.labels.needsChairman");
  assertRefusedFor(mutated((d) => delete d.vocabulary.labels.outOfRelease), "vocabulary.labels.outOfRelease");
  assertRefusedFor(mutated((d) => delete d.vocabulary.labels.blocked), "vocabulary.labels.blocked");
  assertRefusedFor(mutated((d) => delete d.vocabulary.prefixes), "vocabulary.prefixes");
  assertRefusedFor(mutated((d) => delete d.vocabulary.prefixes.lane), "vocabulary.prefixes.lane");
  assertRefusedFor(mutated((d) => delete d.vocabulary.prefixes.session), "vocabulary.prefixes.session");
  assertRefusedFor(mutated((d) => delete d.vocabulary.prefixes.answer), "vocabulary.prefixes.answer");
  assertRefusedFor(mutated((d) => delete d.vocabulary.milestones), "vocabulary.milestones");
  assertRefusedFor(mutated((d) => delete d.vocabulary.milestones.roadToVersionOne), "vocabulary.milestones.roadToVersionOne");
  assertRefusedFor(mutated((d) => delete d.vocabulary.milestones.outOfRelease), "vocabulary.milestones.outOfRelease");
  assertRefusedFor(mutated((d) => delete d.vocabulary.lanesFile), "vocabulary.lanesFile");
  assertRefusedFor(mutated((d) => delete d.vocabulary.templateFields), "vocabulary.templateFields");
  assertRefusedFor(mutated((d) => delete d.vocabulary.templateFields.acceptance), "vocabulary.templateFields.acceptance");
  assertRefusedFor(mutated((d) => delete d.vocabulary.templateFields.closes), "vocabulary.templateFields.closes");
  assertRefusedFor(mutated((d) => delete d.vocabulary.templateFields.fleet), "vocabulary.templateFields.fleet");
  assertRefusedFor(mutated((d) => delete d.vocabulary.fleetQuestion), "vocabulary.fleetQuestion");
});

test("`resources` is OPTIONAL and an ABSENT list reads as empty -- a project with no fleet or lab has none of its own", () => {
  const v = parseVocabulary(mutated((d) => delete d.vocabulary.resources));
  assert.deepEqual(v.resources, []);
});

test("a MISTYPED field is refused naming that field", () => {
  assertRefusedFor(mutated((d) => (d.vocabulary.labels.backlog = 7)), "vocabulary.labels.backlog");
  assertRefusedFor(mutated((d) => (d.vocabulary.labels.backlog = "")), "vocabulary.labels.backlog");
  assertRefusedFor(mutated((d) => (d.vocabulary.resources = "no")), "vocabulary.resources");
  assertRefusedFor(mutated((d) => (d.vocabulary.resources = [{ reason: "x" }])), "vocabulary.resources[0].pattern");
  assertRefusedFor(mutated((d) => (d.vocabulary.resources = [{ pattern: "(", reason: "x" }])), "vocabulary.resources[0].pattern");
  assertRefusedFor(mutated((d) => (d.vocabulary.resources = [{ pattern: "x", reason: "y", named: "no" }])), "vocabulary.resources[0].named");
});

test("a refusal for one field is not a refusal for another (each mutation fires exactly its own rule)", () => {
  const fields = [
    mutated((d) => delete d.vocabulary.labels.blocked),
    mutated((d) => delete d.vocabulary.prefixes.answer),
    mutated((d) => delete d.vocabulary.fleetQuestion),
  ].map((doc) => refusalOf(doc).field);
  assert.deepEqual(fields, ["vocabulary.labels.blocked", "vocabulary.prefixes.answer", "vocabulary.fleetQuestion"]);
  assert.equal(new Set(fields).size, fields.length);
});
