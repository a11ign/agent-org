import { test } from "node:test";
import assert from "node:assert/strict";
import { findingsMiss, findingsRefusal, lineForm, parseFindingsGiven, retriedUrls, retryAsk } from "./blocker-findings-check.ts";

const ONE = "https://github.com/a11ign/agent-org/pull/1841";
const TWO = "https://github.com/a11ign/agent-org/pull/1843";
const SECTION = (...urls: string[]): string => `# Plan\n\n## What the blockers found\n\n${urls.map((url) => `- ${url}: it applies here.`).join("\n")}\n\n## Paths\n\n- \`agent-org:src/a.ts\`\n`;

test("a plan given no pull requests is never asked for the section", () => {
  assert.equal(findingsMiss(["# Plan\n"], []), null);
  assert.equal(findingsMiss([], []), null);
});

test("a plan with no What the blockers found section misses every pull request it was given", () => {
  assert.deepEqual(findingsMiss(["# Plan\n\n## Paths\n"], [ONE, TWO]), { missing: [ONE, TWO], noSection: true });
});

test("a plan whose section leaves one pull request out misses that one, and one that names each misses none", () => {
  assert.deepEqual(findingsMiss([SECTION(ONE)], [ONE, TWO]), { missing: [TWO], noSection: false });
  assert.equal(findingsMiss([SECTION(ONE, TWO)], [ONE, TWO]), null);
});

test("pull/33 is not pull/3, and the punctuation of the sentence around an address is not part of it", () => {
  assert.deepEqual(findingsMiss([SECTION("https://github.com/a11ign/agent-org/pull/18410")], [ONE]), { missing: [ONE], noSection: false });
  assert.equal(findingsMiss([`## What the blockers found\n\n- see ${ONE}.\n`], [ONE]), null);
});

test("the section may be in one plan file and the addresses it names split over several files", () => {
  assert.equal(findingsMiss(["# Plan\n", SECTION(ONE), `## What the blockers found\n\n- ${TWO}: also.\n`], [ONE, TWO]), null);
  assert.deepEqual(findingsMiss(["# Plan\n", SECTION(ONE)], [ONE, TWO]), { missing: [TWO], noSection: false });
});

test("the refusal names what is missing, and says the one automatic retry was made when it was", () => {
  assert.equal(findingsRefusal({ missing: [TWO], noSection: false }, [ONE, TWO]),
    `the plan's "## What the blockers found" section does not name ${TWO}: it must say how each pull request's findings apply or why they do not`);
  assert.equal(findingsRefusal({ missing: [ONE, TWO], noSection: true }, [ONE, TWO]),
    `the plan has no "## What the blockers found" section, though it was given what its blockers' pull requests found (${ONE}, ${TWO}): it must say how each applies or why it does not`);
  assert.equal(findingsRefusal({ missing: [TWO], noSection: false }, [ONE, TWO], [TWO]),
    `the plan's "## What the blockers found" section does not name ${TWO}: it must say how each pull request's findings apply or why they do not. One automatic retry was made, naming ${TWO}, and the plan still misses ${TWO}`);
});

test("the line form is the section heading and one bullet for each address, as the check reads them", () => {
  const form = lineForm([ONE, TWO]);
  assert.equal(form, `\`\`\`markdown\n## What the blockers found\n\n- ${ONE}: <how this pull request's findings apply to this ticket, or why they do not>\n- ${TWO}: <how this pull request's findings apply to this ticket, or why they do not>\n\`\`\``);
  const filled = form.split("\n").slice(1, -1).join("\n").replaceAll(/<[^>]*>/g, "it applies").concat("\n");
  assert.equal(findingsMiss([filled], [ONE, TWO]), null, "a plan that fills in the form passes the check");
});

test("the retry asks for each missing address of each ticket, where its plan is, and for the outcome to be written again last", () => {
  const ask = retryAsk([{ key: "A11-191", planDir: "/state/A11-191/plan", missing: [ONE] }], "/state/A11-191/outcome.json");
  for (const part of [ONE, "A11-191", "/state/A11-191/plan", "the one automatic retry", "write /state/A11-191/outcome.json again as the last thing you do", lineForm([ONE])]) {
    assert.ok(ask.includes(part), `the retry says ${part}`);
  }
  const batch = retryAsk([{ key: "A11-1", planDir: "/p/A11-1", missing: [ONE] }, { key: "A11-2", planDir: "/p/A11-2", missing: [TWO] }], "/o.json");
  assert.ok(batch.includes("For A11-1:") && batch.includes("For A11-2:"), "a batch's ask names each ticket's form");
});

test("findings-given.json is read as a list of tickets with their plan folders and addresses, and anything else is not a list", () => {
  assert.deepEqual(parseFindingsGiven(JSON.stringify([{ key: "A11-1", planDir: "/p", urls: [ONE] }])), [{ key: "A11-1", planDir: "/p", urls: [ONE] }]);
  for (const bad of ["{", "{}", "[1]", JSON.stringify([{ key: "A11-1", planDir: "/p" }]), JSON.stringify([{ key: "A11-1", planDir: "/p", urls: [1] }]), "null"]) {
    assert.equal(parseFindingsGiven(bad), null, bad);
  }
});

test("findings-retried.json is read as the addresses each ticket was asked for, and a mark that is not one names none", () => {
  assert.deepEqual(retriedUrls(JSON.stringify({ at: 1, missing: { "A11-1": [ONE], "A11-2": "no" } })), { "A11-1": [ONE] });
  for (const bad of ["{", "null", "{}", JSON.stringify({ at: 1 })]) assert.deepEqual(retriedUrls(bad), {}, bad);
});
