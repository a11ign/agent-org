// @ts-check
// THE RELEASE SOURCE, AGAINST FIXTURES (a11ign/a11ign#3413). The six readings the row names are asserted through the REAL core and the in-memory provider
// on a clock the test owns, so "told" means what the chairman would have received, and "recorded" means a line in a real ledger file.
//
// POSITIVE CONTROLS, because "no event" is also what a source that never fires reports. (1) is the non-empty control for (3) and (4): the same
// repository, once it has been read before, yields both the new releases and not the draft. (4)'s own control is the baselined repository that yields
// the same five releases as five events, so a source that never fires fails it and a first-run guard that is removed fails (4).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createFakeProvider } from "../fake-provider.mjs";
import { createLedger } from "../ledger.mjs";
import { RELEASES, assertReadOnlyGh, declaredCodeRepos, runWatch } from "../watch.mjs";
import { baselineKey, firstSentence, observeReleases, releaseKey, seenKeys } from "./releases.mjs";

const REPO = "a11ign/agent-org";
const OTHER = "a11ign/screenreader-worker";
const NOW = Date.parse("2026-10-04T12:00:00Z");
const MINUTE = 60_000;

const scratch = mkdtempSync(join(tmpdir(), "messaging-releases-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let directories = 0;
const freshDirectory = () => mkdtempSync(join(scratch, `d${(directories += 1)}-`));

/** A release as `gh api repos/<r>/releases` returns it, with only the fields the source reads. */
function release(/** @type {string} */ tag, /** @type {Record<string, unknown>} */ fields = {}) {
  const minutes = Number(tag.split(".").pop());
  return {
    tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    published_at: new Date(NOW - 600 * MINUTE + minutes * MINUTE).toISOString(), body: `### Patch Changes\n\n- abc1234: Change in ${tag}. And more.`, ...fields,
  };
}

/** The body the real v0.7.8 release carries: a heading, then a changeset bullet that opens with the commit's hash and wraps. */
const REAL_BODY = "\n### Patch Changes\n\n- 7105923: The isolation gate's copy skips an `@a11ign/*` dependency that has no sibling directory when it is spelled as a caret or tilde range (`^0.1.0`, `~0.1.0`), because that is how a package consumes one published from another repository and npm fetches it from the registry;\n  the copy no longer fails on it.\n";

/** A GET-only GitHub for the source: each repository answers with its list, or throws when its answer is an `Error`. */
function fakeApi(/** @type {Record<string, unknown>} */ answers) {
  const calls = /** @type {string[]} */ ([]);
  return {
    calls,
    async api(/** @type {string} */ path) {
      calls.push(path);
      const answer = answers[path.replace(/^repos\//, "").replace(/\/releases.*$/, "")];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

/** A watcher run on a clock the test owns, over a ledger file that persists between its passes. */
function watcher(/** @type {Record<string, unknown>} */ answers, repos = [REPO]) {
  let at = NOW;
  const provider = createFakeProvider();
  const github = fakeApi(answers);
  const logged = /** @type {string[]} */ ([]);
  const ledger = createLedger({ path: join(freshDirectory(), "ledger.jsonl"), now: () => at });
  return {
    provider, github, logged, ledger,
    set: (/** @type {Record<string, unknown>} */ next) => Object.assign(answers, next),
    pass: async () => {
      at += MINUTE;
      return runWatch({ github, provider, ledger, now: () => at, repo: "a11ign/a11ign", summary: null, releaseRepos: repos, sources: [RELEASES], log: (line) => logged.push(line) });
    },
    ledgerKeys: () => ledger.read().map((line) => `${line.key}|${line.status}`),
  };
}

const baselined = (/** @type {string} */ repo = REPO) => new Set([baselineKey(repo)]);

describe("firstSentence", () => {
  test("the real v0.7.8 notes: the hash, the heading, the list marker and the backticks are gone, and the sentence ends at the first full stop", () => {
    const sentence = firstSentence(REAL_BODY);
    assert.ok(sentence.startsWith("The isolation gate's copy skips an @a11ign/* dependency that has no sibling directory"), sentence);
    assert.ok(sentence.includes("(^0.1.0, ~0.1.0)"), "the version ranges' dots did not end the sentence");
    assert.ok(sentence.length <= 240 && sentence.endsWith("…"), "a long sentence is cut at a word and marked");
    assert.ok(!/[`]|7105923/.test(sentence));
  });

  test("a version number's dots do not end the sentence, and a sentence that is short is not cut or marked", () => {
    assert.equal(firstSentence("### Minor Changes\n\n- deadbeef: Pins `0.1.0` as the floor. Then the second sentence."), "Pins 0.1.0 as the floor.");
  });

  test("empty notes, no notes, and notes that are only headings say nothing, and never a guess", () => {
    for (const notes of ["", "   \n\n", null, undefined, "### Patch Changes\n\n"]) assert.equal(firstSentence(notes), "", JSON.stringify(notes));
  });

  test("a lone asterisk or underscore is a word, and a bold pair is not", () => {
    assert.equal(firstSentence("- Fixes **the** `snake_case` glob `@a11ign/*`."), "Fixes the snake_case glob @a11ign/*.");
  });

  test("a link keeps its words and loses its address", () => {
    assert.equal(firstSentence("- See [the guide](https://example.com/guide) for the new flag."), "See the guide for the new flag.");
  });
});

describe("observeReleases", () => {
  test("(1) two new releases yield two events, the oldest first, each carrying package, version, the first sentence and the release page", async () => {
    const listed = [release("v0.7.2"), release("v0.7.1")];
    const { events, notes, cannotAsk } = await observeReleases({ repos: [REPO], listReleases: () => listed, seen: baselined() });
    assert.deepEqual(events.map((event) => event.key), [releaseKey(REPO, "v0.7.1"), releaseKey(REPO, "v0.7.2")]);
    assert.equal(events[0].text, "agent-org 0.7.1 is out: Change in v0.7.1.");
    assert.equal(events[1].text, "agent-org 0.7.2 is out: Change in v0.7.2.");
    assert.deepEqual(events[0].links, [`https://github.com/${REPO}/releases/tag/v0.7.1`]);
    assert.deepEqual([notes, cannotAsk], [[], []]);
  });

  test("(1) and through the real core: the chairman receives two messages, and a later pass sends nothing more", async () => {
    const run = watcher({ [REPO]: [release("v0.7.1")] });
    await run.pass();
    run.set({ [REPO]: [release("v0.7.2"), release("v0.7.1")] });
    await run.pass();
    run.set({ [REPO]: [release("v0.7.3"), release("v0.7.2"), release("v0.7.1")] });
    await run.pass();
    await run.pass();
    assert.deepEqual(run.provider.sent.map((message) => message.text.split("\n")[0]), ["agent-org 0.7.2 is out: Change in v0.7.2.", "agent-org 0.7.3 is out: Change in v0.7.3."]);
    assert.ok(run.provider.sent.every((message) => message.text.includes("https://github.com/a11ign/agent-org/releases/tag/v0.7")), "the page is in the message");
    assert.ok(run.provider.sent.every((message) => message.silent !== true), "a release is news, not a silent message");
  });

  test("(2) a release with empty notes says no summary was written, and does not invent one", async () => {
    const listed = [release("v0.7.1", { body: "" }), release("v0.7.2", { body: null }), release("v0.7.3", { body: "### Patch Changes\n" })];
    const { events } = await observeReleases({ repos: [REPO], listReleases: () => listed, seen: baselined() });
    assert.deepEqual(events.map((event) => event.text), [
      "agent-org 0.7.1 is out (no summary was written)", "agent-org 0.7.2 is out (no summary was written)", "agent-org 0.7.3 is out (no summary was written)",
    ]);
  });

  test("(3) a draft and a pre-release yield nothing, beside the release that does", async () => {
    const listed = [release("v0.7.3", { draft: true }), release("v0.7.2", { prerelease: true }), release("v0.7.1")];
    const { events } = await observeReleases({ repos: [REPO], listReleases: () => listed, seen: baselined() });
    assert.deepEqual(events.map((event) => event.key), [releaseKey(REPO, "v0.7.1")], "the control: one release in the same list is told");
    const onlyThose = await observeReleases({ repos: [REPO], listReleases: () => listed.slice(0, 2), seen: baselined() });
    assert.deepEqual(onlyThose.events, []);
  });

  test("(3) a pre-release that is promoted later is told then", async () => {
    const run = watcher({ [REPO]: [release("v0.7.1")] });
    await run.pass();
    run.set({ [REPO]: [release("v0.7.2", { prerelease: true }), release("v0.7.1")] });
    await run.pass();
    assert.equal(run.provider.sent.length, 0);
    run.set({ [REPO]: [release("v0.7.2"), release("v0.7.1")] });
    await run.pass();
    assert.equal(run.provider.sent.length, 1);
  });

  test("(4) on the first run with five existing releases NOTHING is sent and all five are recorded, then the marker", async () => {
    const five = ["v0.7.5", "v0.7.4", "v0.7.3", "v0.7.2", "v0.7.1"].map((tag) => release(tag));
    const { events, notes } = await observeReleases({ repos: [REPO], listReleases: () => five, seen: new Set() });
    assert.deepEqual(events, []);
    assert.deepEqual(notes.map((note) => note.key), [..."12345".split("").map((n) => releaseKey(REPO, `v0.7.${n}`)), baselineKey(REPO)]);
    assert.match(notes.at(-1)?.reason ?? "", /5 releases recorded as seen and none told/);

    const control = await observeReleases({ repos: [REPO], listReleases: () => five, seen: baselined() });
    assert.equal(control.events.length, 5, "the control: the same five, once the repository has been read, are five events");
  });

  test("(4) through the real core: nothing is sent, the ledger holds five records and the marker, and the log says so ONCE", async () => {
    const five = ["v0.7.5", "v0.7.4", "v0.7.3", "v0.7.2", "v0.7.1"].map((tag) => release(tag));
    const run = watcher({ [REPO]: five });
    await run.pass();
    await run.pass();
    assert.deepEqual(run.provider.sent, []);
    assert.equal(run.ledgerKeys().length, 6);
    assert.ok(run.ledgerKeys().includes(`${baselineKey(REPO)}|invalid`));
    assert.equal(run.logged.filter((line) => line.startsWith(`${baselineKey(REPO)}:`)).length, 1, "said once, not once per tick");
    assert.equal(seenKeys(run.ledger.read()).size, 6);
  });

  test("(4) a repository with NO release yet is still baselined, so its first real release is told and not mistaken for history", async () => {
    const run = watcher({ [REPO]: [] });
    await run.pass();
    assert.deepEqual(run.ledgerKeys(), [`${baselineKey(REPO)}|invalid`]);
    run.set({ [REPO]: [release("v0.1.1")] });
    await run.pass();
    assert.equal(run.provider.sent.length, 1);
  });

  test("(5) the same release twice yields one message, in one list and across ticks", async () => {
    const run = watcher({ [REPO]: [release("v0.7.1")] });
    await run.pass();
    run.set({ [REPO]: [release("v0.7.2"), release("v0.7.2"), release("v0.7.1")] });
    await run.pass();
    await run.pass();
    assert.equal(run.provider.sent.length, 1);
    assert.equal(run.ledgerKeys().filter((entry) => entry === `${releaseKey(REPO, "v0.7.2")}|sent`).length, 1);
  });

  test("(6) a failed read yields cannot-ask, no event and NO baseline, never a cleared", async () => {
    const down = new Error("gh: HTTP 502");
    const { events, notes, cannotAsk } = await observeReleases({ repos: [REPO], listReleases: () => { throw down; }, seen: new Set() });
    assert.deepEqual([events, notes], [[], []]);
    assert.deepEqual(cannotAsk, [{ source: `release:${REPO}`, reason: "Error: gh: HTTP 502" }]);
    const notAList = await observeReleases({ repos: [REPO], listReleases: () => ({ message: "Not Found" }), seen: new Set() });
    assert.equal(notAList.cannotAsk.length, 1, "an answer that is not a list is a read that failed");
  });

  test("(6) through the watcher: the failure is logged, the other repository is still read, and the failed one is the first run when it comes back", async () => {
    const run = watcher({ [REPO]: new Error("gh: HTTP 502"), [OTHER]: [release("v0.1.1")] }, [REPO, OTHER]);
    await run.pass();
    assert.ok(run.logged.some((line) => line.includes(`cannot-ask release:${REPO}: Error: gh: HTTP 502`)), run.logged.join("\n"));
    assert.deepEqual(run.ledgerKeys().filter((entry) => entry.startsWith("release")), [`${releaseKey(OTHER, "v0.1.1")}|invalid`, `${baselineKey(OTHER)}|invalid`]);
    run.set({ [REPO]: [release("v0.7.1")] });
    await run.pass();
    assert.equal(run.provider.sent.length, 0, "the repository's history is baselined when it is first read, not told");
    assert.ok(run.ledgerKeys().includes(`${baselineKey(REPO)}|invalid`));
  });

  test("the read is one GET of the repository's releases, at the page size that holds a long history", async () => {
    const run = watcher({ [REPO]: [] });
    await run.pass();
    assert.deepEqual(run.github.calls, [`repos/${REPO}/releases?per_page=100`]);
    assert.doesNotThrow(() => assertReadOnlyGh(["api", run.github.calls[0]]));
    assert.throws(() => assertReadOnlyGh(["api", `repos/${REPO}/releases`, "-X", "POST"]), /reads only/);
    assert.throws(() => assertReadOnlyGh(["api", `repos/${REPO}/releases/1`, "-f", "name=x"]), /reads only/);
  });
});

describe("declaredCodeRepos", () => {
  test("is every code repository the project declares, once each, and nothing malformed", () => {
    const root = freshDirectory();
    mkdirSync(join(root, ".agent-org"));
    writeFileSync(join(root, ".agent-org", "project.json"), JSON.stringify({
      code: [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: REPO }, { key: "again", repo: REPO }, { key: "bad", repo: "not-a-repo" }, { key: "none" }],
    }));
    assert.deepEqual(declaredCodeRepos(root), ["a11ign/a11ign", REPO]);
  });
});
