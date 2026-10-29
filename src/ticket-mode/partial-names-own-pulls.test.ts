// no-token: gh -- the declaration reading is pure; nothing is spawned
//
// A11-394: a merged pull request's `Partial:` line that only describes the run's own pull requests must not keep the ticket open once they have all merged. A11-370's outcome listed one of its two pull requests, so the
// sibling rule saw a run of one and kept `The ticket completes when both have merged` as a remainder; A11-254's words named step 2 of 2, the plan's last, whose pull requests had all merged. The words below are the
// two bodies' own, from the board's record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KEYWORDS } from "./source.ts";
import { declarationOf, pullsNamedIn, saysCompletesOnMerge } from "./ticket-references.ts";
import { declarationsDue, declare, mergedPullSet, recordDeclared, runPullUrls } from "./queue/queue-declarations.ts";
import type { Entry, Queue } from "./queue/queue-entries-and-outcomes.ts";

const A11_370_WORDS = "this is one of the run's two pull requests; the other is a11ign/agent-org (the board's wait note, start priority and its own `ci.yml`). The ticket completes when both have merged.";
const A11_254_WORDS = "step 2 of 2 is done by one pull request per repository, opened in the same run: a11ign/a11ign, a11ign/control, a11ign/lab, a11ign/documents, a11ign/screenreader-fleet, a11ign/screenreader-worker, a11ign/announcement-emulator (toolchain's was step 1, a11ign/toolchain#59, merged and released as 0.14.0). The ticket completes when all of them have merged; what remains afterwards is the After-merge line of the Done-when, run by the chairman session below.";

const WEB = "https://github.com/a11ign/a11ign/pull/5734";
const BOARD = "https://github.com/a11ign/agent-org/pull/1989";
const TOOLCHAIN_1 = "https://github.com/a11ign/toolchain/pull/59";
const CONTROL = "https://github.com/a11ign/control/pull/150";
const LAB = "https://github.com/a11ign/lab/pull/150";
const body = (words: string): string => `Refs A11-370\n\nPartial: ${words}\n`;
const read = (url: string, words: string) => ({ url, declaration: declarationOf(body(words), "A11-370", DEFAULT_KEYWORDS) });

/** A11-370's run: the outcome lists #5734 only, the tracker links both pull requests. */
const finished = (over: Partial<Entry> = {}): Entry => ({ ticket: { key: "A11-370" }, phase: "finished", outcome: { kind: "reviewed", prs: [{ repo: "a11ign/a11ign", url: WEB }] },
  pullStates: { [WEB]: "merged", [BOARD]: "merged" }, ...over }) as Entry;
const queueOf = (...entries: Entry[]): Queue => ({ entries }) as unknown as Queue;

test("A11-370: the run's pull requests are counted from the tracker's links too, each once", () => {
  assert.deepEqual(runPullUrls(finished()), [WEB, BOARD]);
  assert.deepEqual(runPullUrls(finished({ pullStates: { [WEB]: "merged" } })), [WEB]);
});

test("A11-370: a linked pull request that closed unmerged, and one of an earlier step, are not the run's", () => {
  assert.deepEqual(runPullUrls(finished({ pullStates: { [WEB]: "merged", [BOARD]: "closed" } })), [WEB]);
  assert.deepEqual(runPullUrls(finished({ steps: [{ step: 1, of: 2, prs: [BOARD] }] })), [WEB]);
});

test("A11-370: the declaration is read once every pull request the run has is settled, not while a linked sibling is open", () => {
  assert.deepEqual(declarationsDue(queueOf(finished())).length, 1);
  assert.deepEqual(declarationsDue(queueOf(finished({ pullStates: { [WEB]: "merged", [BOARD]: "open" } }))), []);
});

test("A11-370: #5734's words, read with the run's two pull requests both merged, close the ticket and leave nothing to disagree about", () => {
  const entry = finished();
  const declared = declare([read(WEB, A11_370_WORDS)], runPullUrls(entry).length, mergedPullSet(entry));
  assert.deepEqual(declared, { kind: "closes", urls: [WEB] });
  const [done] = recordDeclared(queueOf(entry), "A11-370", declared, "Closes").entries;
  assert.equal(done.partial, undefined);
  assert.equal(done.partialOverruled, undefined);
});

test("A11-370: the same words, with only the outcome's pull request counted and none recorded merged, stay a remainder as before", () => {
  assert.deepEqual(declare([read(WEB, A11_370_WORDS)], 1), { kind: "partial", remains: A11_370_WORDS, urls: [WEB] });
});

test("A11-254: step 2 of 2 with every pull request of the run merged closes the ticket, and the earlier step's pull request is not the run's", () => {
  const entry = finished({ ticket: { key: "A11-254" } as Entry["ticket"], steps: [{ step: 1, of: 2, prs: [TOOLCHAIN_1] }], pullStates: { [WEB]: "merged", [CONTROL]: "merged", [TOOLCHAIN_1]: "merged" },
    outcome: { kind: "reviewed", prs: [{ repo: "a11ign/a11ign", url: WEB }, { repo: "a11ign/control", url: CONTROL }] } });
  assert.deepEqual(runPullUrls(entry), [WEB, CONTROL]);
  assert.deepEqual(declare([read(WEB, A11_254_WORDS)], 2, mergedPullSet(entry)), { kind: "closes", urls: [WEB] });
  const declared = declare([read(WEB, A11_254_WORDS)], 2, mergedPullSet(entry));
  const [done] = recordDeclared(queueOf({ ...entry, partial: A11_254_WORDS }), "A11-254", declared, "Closes").entries;
  assert.equal(done.partial, undefined);
  assert.equal(done.partialOverruled, undefined);
});

test("what still remains stays a remainder", () => {
  const merged = new Set([WEB, BOARD, LAB].map((url) => url.toLowerCase()));
  const remainders: [string, number][] = [["step 1 of 3: x", 1], ["step 2 of 2: the docs", 1], ["the docs remain. The ticket completes when step 3 has merged", 1], ["step 2 of 2: the rest", 2], ["step 2 of 3: the view; the ticket completes when step 3 has merged", 1], ["the docs", 1],
    ["step 1 of 3: x; the ticket completes when both have merged", 2], ["the ticket completes when a11ign/control#150 has merged", 1], ["the ticket completes when #150 has merged", 1]];
  for (const [words, count] of remainders) assert.equal(declare([read(WEB, words)], count, merged).kind, "partial", words);
  assert.equal(declare([read(WEB, "the ticket completes when a11ign/lab#150 has merged")], 1, new Set()).kind, "partial");
  assert.equal(declare([read(WEB, "the ticket completes when a11ign/lab#150 has merged")], 1, merged).kind, "closes");
  assert.equal(declare([read(WEB, `the ticket completes when ${LAB} has merged`)], 1, merged).kind, "closes");
});

test("A11-394: the earlier readings keep their answers when no merged set is passed", () => {
  assert.equal(declare([read(WEB, A11_254_WORDS)], 2).kind, "partial");
  assert.equal(declare([read(WEB, A11_370_WORDS)], 2).kind, "none");
});

test("A11-394: an outcome that says the ticket completes on merge agrees with a `Closes`; one that names work does not", () => {
  const closes = { kind: "closes" as const, urls: [WEB] };
  const [same] = recordDeclared(queueOf(finished({ partial: A11_370_WORDS })), "A11-370", closes, "Closes").entries;
  assert.equal(same.partialOverruled, undefined);
  const [later] = recordDeclared(queueOf(finished({ partial: "step 1 of 3: x. The ticket completes when step 3 has merged" })), "A11-370", closes, "Closes").entries;
  assert.notEqual(later.partialOverruled, undefined, "an outcome that still names an earlier step disagrees with `Closes`");
  const [other] = recordDeclared(queueOf(finished({ partial: "the docs" })), "A11-370", closes, "Closes").entries;
  assert.equal(other.partialOverruled?.outcome, "the docs");
});

test("A11-394: `saysCompletesOnMerge` reads a clause of the line that says the ticket completes once pull requests have merged", () => {
  const says = ["the ticket completes when both have merged", "The ticket is done once all of them are merged", "**The ticket completes when all of them have merged**; the rest is the After-merge line",
    "one of two. The ticket closes when a11ign/lab#150 has merged", `the ticket is complete once ${LAB} has merged`, `${LAB}, the ticket is complete once ${CONTROL} has merged`];
  const not = ["the ticket completes when step 3 has merged", "the ticket completes later", "the docs remain", "none of it has merged", "the ticket completes when the docs are written", "", "this has merged, and the ticket remains open"];
  assert.deepEqual(says.map(saysCompletesOnMerge), says.map(() => true));
  assert.deepEqual(not.map(saysCompletesOnMerge), not.map(() => false));
});

test("A11-394: `pullsNamedIn` finds a web address, an `<owner>/<repo>#<n>` and a bare `#<n>`", () => {
  assert.deepEqual(pullsNamedIn(`${LAB} and A11ign/Control#150, then #7; a11ign/agent-org has none`), [LAB.toLowerCase(), CONTROL.toLowerCase(), "#7"]);
});
