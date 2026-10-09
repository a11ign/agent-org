// @ts-check
// THE REQUEST SOURCE, AGAINST THE REAL CORE (a11ign/a11ign#2903 done-whens 1 and 2). Every "sent" below is what the in-memory provider
// RECEIVED after the events went through `createMessenger` and a real ledger file, because "ONE event however many ticks see it" is a
// property of the source's key AND the core's memory together, and a test of either alone would pass while the pair sent twice.
//
// POSITIVE CONTROLS: a fixture with no `needs:chairman` rows yields no request, and one with the label yields EXACTLY one. Each
// suppression below sits beside the case where the same row IS sent, so "nothing sent" cannot be a source that never emits.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createMessenger } from "../core.mjs";
import { createFakeProvider } from "../fake-provider.ts";
import { createLedger, foldLedger, readLedgerLines } from "../ledger.mjs";
import { READ_METHODS, assertReadOnlyGh, createGhReader, main, runWatch } from "../watch.mjs";
import { defaultLedgerPath } from "../state.mjs";
import { observeRequests, parseChairmanOptions, parseRequestKey, readRequests, requestKey } from "./requests.mjs";

const REPO = "a11ign/a11ign";
const START = Date.parse("2026-10-02T09:00:00Z");
const MINUTE = 60_000;

const scratch = mkdtempSync(join(tmpdir(), "messaging-requests-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextLedger = 0;

/**
 * The lines a request alert is built from (a11ign/a11ign#3335, #3412). A brief with no `chairman-options` block carries NO_OPTION_LINES, and
 * one with a block carries OPTION_LINES instead of the last line: `brief()` picks by the body, so every fixture below is complete unless it
 * says `lines: ""`.
 */
const WHAT = "What is happening: worker 4 is switched off and a capture is waiting on it";
const ACT = "Ask: switch worker 4 on";
const ONLY_YOU = "Only you because: the switch is behind your account";
const CHECKED = "Checked: 20:03Z, gh api repos/x/y printed false";
const HOW_LONG = "How long: two minutes";
const UNBLOCKS = "Unblocks: the 20:30 capture";
const NOT_HIS_CLAUDE = "Not the chairman's Claude session because: the switch is a button on a box in his house";
const RECOMMEND = "Recommend: A, switch it on";
const TRADE_OFF = "Trade-off: A costs a capture slot tonight";
const COMMON = [WHAT, ACT, ONLY_YOU, CHECKED, HOW_LONG, UNBLOCKS];
const LINES = [...COMMON, NOT_HIS_CLAUDE].join("\n");
const OPTION_LINES = [...COMMON, RECOMMEND, TRADE_OFF].join("\n");

/** @param {string} body @param {{ lines?: string } & Record<string, unknown>} [more] `lines` replaces the required lines; `""` writes a brief with none */
function brief(body: string, { lines = /chairman-options/.test(body) ? OPTION_LINES : LINES, ...more }: { lines?: string; } & Record<string, unknown> = {}) {
  return { body: lines === "" ? body : `${body}\n${lines}`, createdAt: "2026-10-01T18:00:00Z", authorAssociation: "MEMBER", ...more };
}

/** @param {number} number @param {Record<string, unknown>} [more] a labelled row whose newest brief is complete, unless `comments` says otherwise */
function row(number: number, more: Record<string, unknown> = {}) {
  return { number, title: `Row ${number} needs a decision`, url: `https://github.com/${REPO}/issues/${number}`, comments: [brief("**ceo — BRIEF for the chairman: decide.**")], ...more };
}

/**
 * A world: a clock, a ledger file, a provider, and a `tick(rows)` that does what the watcher does for requests. `restart()` is a new
 * process over the same ledger. `labelled` is what the fixture reader says carries the label.
 */
function world() {
  let at = START;
  const path = join(scratch, `ledger-${nextLedger += 1}.jsonl`);
  const provider = createFakeProvider();
  const ledger = () => createLedger({ path, now: () => at });
  let messenger = createMessenger({ provider, ledger: ledger(), now: () => at });
  return {
    provider,
    path,
    advance: (/** @type {number} */ ms: number) => { at += ms; },
    restart() { messenger = createMessenger({ provider, ledger: ledger(), now: () => at }); },
    /** @param {any[]} rows @returns {Promise<{ decisions: any[], observed: ReturnType<typeof observeRequests> }>} */
    async tick(rows: any[]): Promise<{ decisions: any[]; observed: ReturnType<typeof observeRequests>; }> {
      const state = foldLedger(ledger().read());
      const openKeys = [...state].filter(([key, record]) => record.open && parseRequestKey(key)).map(([key]) => key);
      const observed = observeRequests({ repo: REPO, rows, openKeys, now: at });
      return { decisions: await messenger.tick(observed.events), observed };
    },
  };
}

describe("a row that gains needs:chairman yields ONE request however many ticks see it (done-when 1)", () => {
  test("POSITIVE CONTROL: no labelled rows yields no request, and one labelled row yields exactly one message", async () => {
    const empty = world();
    const quiet = await empty.tick([]);
    assert.deepEqual(quiet.observed.events, []);
    assert.equal(empty.provider.sent.length, 0);

    const one = world();
    await one.tick([row(2885)]);
    assert.equal(one.provider.sent.length, 1);
    assert.ok(one.provider.sent[0].text.startsWith("What is happening: "), "the message opens with what is happening");
    assert.match(one.provider.sent[0].text, /https:\/\/github\.com\/a11ign\/a11ign\/issues\/2885$/);
    assert.equal(one.provider.sent[0].silent, false, "a request is the one thing that must be heard");
  });

  test("twenty ticks, and a restart in the middle, send one message", async () => {
    const w = world();
    for (let tick = 0; tick < 10; tick += 1) { await w.tick([row(2885)]); w.advance(5 * MINUTE); }
    w.restart();
    for (let tick = 0; tick < 10; tick += 1) { await w.tick([row(2885)]); w.advance(5 * MINUTE); }
    assert.equal(w.provider.sent.length, 1);
  });

  test("two rows are two requests, each once", async () => {
    const w = world();
    await w.tick([row(2885), row(2887)]);
    await w.tick([row(2885), row(2887)]);
    assert.equal(w.provider.sent.length, 2);
    assert.notEqual(w.provider.sent[0].text, w.provider.sent[1].text);
  });

  test("adding a label that is not needs:chairman is not a change in what is asked, so it is not sent again", async () => {
    const w = world();
    const brief1 = brief("**ceo — BRIEF for the chairman: one choice.**\nDetail.");
    await w.tick([row(2885, { comments: [brief1], labels: ["needs:chairman"] })]);
    await w.tick([row(2885, { comments: [brief1], labels: ["needs:chairman", "in-progress", "was-ready"] })]);
    assert.equal(w.provider.sent.length, 1);
  });

  test("a re-briefed ask IS a change, and is sent once more with the new line", async () => {
    const w = world();
    const first = brief("**ceo — BRIEF for the chairman: decide.**", { lines: LINES });
    await w.tick([row(2885, { comments: [first] })]);
    const later = brief("**ceo — BRIEF for the chairman: decide.**", { createdAt: "2026-10-02T08:00:00Z", lines: LINES.replace(ACT, "Ask: switch worker 5 on instead") });
    await w.tick([row(2885, { comments: [first, later] })]);
    assert.equal(w.provider.sent.length, 2);
    assert.match(w.provider.sent[1].text, /worker 5 on instead/);
  });

  test("a request the chairman has not answered is reminded, up to three times and then left alone (the core's rule, seen from here)", async () => {
    const w = world();
    for (let day = 0; day < 6; day += 1) { await w.tick([row(2885)]); w.advance(24 * 60 * MINUTE); }
    assert.equal(w.provider.sent.length, 4, "one request and three reminders");
    assert.match(w.provider.sent[3].text, /^Reminder 3 of 3: /);
  });
});

describe("a row that loses the label yields ONE resolved event (done-when 1)", () => {
  test("the label going sends one 'Cleared', and the ticks after it send nothing", async () => {
    const w = world();
    await w.tick([row(2885)]);
    w.advance(5 * MINUTE);
    const gone = await w.tick([]);
    assert.deepEqual(gone.observed.events.map((event) => event.resolved), [true]);
    assert.equal(w.provider.sent.length, 2);
    assert.match(w.provider.sent[1].text, /^Cleared: a11ign\/a11ign#2885 no longer needs you/);
    for (let tick = 0; tick < 5; tick += 1) { w.advance(5 * MINUTE); await w.tick([]); }
    assert.equal(w.provider.sent.length, 2, "five more ticks with the label still gone");
  });

  test("the cleared message replies to the request it clears", async () => {
    const w = world();
    await w.tick([row(2885)]);
    await w.tick([]);
    assert.equal(w.provider.sent[1].replyTo, w.provider.sent[0].messageRef);
  });

  test("a row that never reached the chairman and loses the label sends nothing at all", async () => {
    const w = world();
    const gone = await w.tick([]);
    assert.deepEqual(gone.observed.events, []);
    assert.equal(w.provider.sent.length, 0);
  });

  test("a row that regains the label after it cleared is a NEW request", async () => {
    const w = world();
    await w.tick([row(2885)]);
    w.advance(5 * MINUTE);
    await w.tick([]);
    w.advance(5 * MINUTE);
    await w.tick([row(2885)]);
    assert.equal(w.provider.sent.length, 3, "request, cleared, request again");
    assert.match(w.provider.sent[2].text, /^What is happening: /);
  });

  test("one open request among several resolves alone", async () => {
    const w = world();
    await w.tick([row(2885), row(2887)]);
    await w.tick([row(2887)]);
    assert.equal(w.provider.sent.length, 3);
    assert.match(w.provider.sent[2].text, /^Cleared: a11ign\/a11ign#2885/);
  });

  test("another repository's open request is not resolved by this repository's list", () => {
    const { events } = observeRequests({ repo: REPO, rows: [], openKeys: [requestKey("a11ign/agent-org", 3), "incident:trunk-red", requestKey(REPO, 9)], now: START });
    assert.deepEqual(events.map((event) => event.key), [requestKey(REPO, 9)]);
  });
});

describe("a read that cannot be trusted is not a loss (the false-resolution hazard)", () => {
  // These rows sit under the comment window, so the full-comments half of the port is never reached and the fake leaves it out.
  /** @param {{ issuesLabelled: (query: any) => Promise<any> }} listOnly @returns {Parameters<typeof readRequests>[0]["github"]} */
  const asPort = (listOnly: { issuesLabelled: (query: any) => Promise<any>; }): Parameters<typeof readRequests>[0]["github"] => /** @type {Parameters<typeof readRequests>[0]["github"]} */ (/** @type {unknown} */ (listOnly));

  test("a reader that throws makes the source throw, so no 'resolved' event can be built from the failure", async () => {
    const github = { issuesLabelled: async () => { throw new Error("HTTP 502"); } };
    await assert.rejects(() => readRequests({ github: asPort(github), repo: REPO, openKeys: [requestKey(REPO, 2885)], now: START }), /HTTP 502/);
  });

  test("a list as long as the limit is refused: it may have been cut, and the rows past the cut would be reported cleared", async () => {
    const full = Array.from({ length: 200 }, (_, index) => row(index + 1));
    const github = { issuesLabelled: async () => full };
    await assert.rejects(() => readRequests({ github: asPort(github), repo: REPO, openKeys: [], now: START }), /may be cut/);
    const justUnder = { issuesLabelled: async () => full.slice(1) };
    assert.equal((await readRequests({ github: asPort(justUnder), repo: REPO, openKeys: [], now: START })).events.length, 199, "POSITIVE CONTROL: one fewer is read");
  });

  test("the query asks for the comments, the label, and a limit", async () => {
    /** @type {any} */
    let asked: any;
    await readRequests({ github: asPort({ issuesLabelled: async (query: any) => { asked = query; return []; } }), repo: REPO, openKeys: [], now: START });
    assert.deepEqual(asked, { repo: REPO, label: "needs:chairman", comments: true, limit: 200 });
  });

  describe("a row whose comment list is at the window of 100", () => {
    const askedFor = (/** @type {string} */ ask: string) => LINES.replace(ACT, `Ask: ${ask}`);
    const old = brief("**ceo — BRIEF for the chairman:**", { createdAt: "2026-09-20T10:00:00Z", lines: askedFor("the OLD ask") });
    const fresh = brief("**ceo — BRIEF for the chairman:**", { createdAt: "2026-10-02T07:00:00Z", lines: askedFor("the NEW ask") });
    const filler = (/** @type {number} */ n: number) => Array.from({ length: n }, (_, i) => brief(`chatter ${i}`, { createdAt: "2026-09-21T10:00:00Z", lines: "" }));
    const cut = [old, ...filler(99)];
    const whole = [...cut, ...filler(10), fresh];

    test("quotes the NEWEST brief, read from the full comments, not the older one in the cut list", async () => {
      const asked: unknown = /** @type {any[]} */ ([]);
      const github = {
        issuesLabelled: async () => [row(2623, { comments: cut })],
        issueComments: async (query: any) => { asked.push(query); return whole; },
      };
      const { events } = await readRequests({ github, repo: REPO, openKeys: [], now: START });
      assert.deepEqual(asked, [{ repo: REPO, number: 2623 }]);
      assert.match(String(events[0].text), /the NEW ask/);
      assert.doesNotMatch(String(events[0].text), /OLD/);
    });

    test("a re-brief past the window changes the state, so the core sends the update", async () => {
      const w = world();
      assert.equal((await w.tick([row(2623, { comments: cut })])).decisions.map((entry) => entry.action).join(), "sent", "the cut list quotes the old brief");
      const { decisions } = await w.tick([row(2623, { comments: whole })]);
      assert.equal(decisions.map((entry) => entry.action).join(), "updated");
    });

    test("one at 99 comments is not re-read, and one at exactly 100 is (POSITIVE CONTROL for the threshold)", async () => {
      let reads = 0;
      const github = (/** @type {any[]} */ comments: any[]) => ({ issuesLabelled: async () => [row(7, { comments })], issueComments: async () => { reads += 1; return comments; } });
      await readRequests({ github: github([old, ...filler(98)]), repo: REPO, openKeys: [], now: START });
      assert.equal(reads, 0);
      await readRequests({ github: github(cut), repo: REPO, openKeys: [], now: START });
      assert.equal(reads, 1);
    });

    test("a failed full read throws rather than quoting the stale brief or resolving anything", async () => {
      const github = { issuesLabelled: async () => [row(2623, { comments: cut })], issueComments: async () => { throw new Error("502 Bad Gateway"); } };
      await assert.rejects(() => readRequests({ github, repo: REPO, openKeys: ["request:a11ign/a11ign#9"], now: START }), /502/);
      const shorter = { issuesLabelled: async () => [row(2623, { comments: cut })], issueComments: async () => filler(3) };
      await assert.rejects(() => readRequests({ github: shorter, repo: REPO, openKeys: [], now: START }), /did not return at least that many/);
    });
  });
});

describe("the options block (done-when 2)", () => {
  test("a well-formed block is parsed into ids and labels", () => {
    const parsed = parseChairmanOptions("**BRIEF for the chairman.**\n<!-- chairman-options: A=first-publish token; B=publish by hand -->");
    assert.deepEqual(parsed, { options: [{ id: "A", label: "first-publish token" }, { id: "B", label: "publish by hand" }], problem: null });
  });

  test("a comment with no block has no options and no problem: most briefs offer no choice", () => {
    assert.deepEqual(parseChairmanOptions("**BRIEF for the chairman.** Nothing to choose."), { options: [], problem: null });
  });

  for (const [name, body, reason] of /** @type {[string, string, RegExp][]} */ ([
    ["an entry with no equals sign", "<!-- chairman-options: A first; B=second -->", /no id/],
    ["an empty id", "<!-- chairman-options: =first -->", /no id/],
    ["an id with a space", "<!-- chairman-options: not an id=first -->", /no id/],
    ["an id over sixteen characters", `<!-- chairman-options: ${"x".repeat(17)}=first -->`, /no id/],
    ["an empty label", "<!-- chairman-options: A= -->", /needs a label/],
    ["a label over sixty-four characters", `<!-- chairman-options: A=${"y".repeat(65)} -->`, /needs a label/],
    ["a repeated id", "<!-- chairman-options: A=first; A=second -->", /twice/],
    ["an empty block", "<!-- chairman-options: -->", /empty/],
    ["two blocks", "<!-- chairman-options: A=x --> <!-- chairman-options: B=y -->", /2 chairman-options blocks/],
  ])) {
    test(`malformed (${name}): no options at all, and a reason`, () => {
      const parsed = parseChairmanOptions(body);
      assert.deepEqual(parsed.options, [], "all or nothing: one bad entry must not leave its neighbours as buttons");
      assert.match(String(parsed.problem), reason);
    });
  }

  test("a request with a malformed block is still SENT, with no options and the reason returned for the log (not a refusal)", async () => {
    const w = world();
    const bad = brief("**ceo — BRIEF for the chairman: choose.**\n<!-- chairman-options: A first -->");
    const { observed } = await w.tick([row(2885, { comments: [bad] })]);
    assert.equal(w.provider.sent.length, 1, "the chairman is still asked");
    assert.deepEqual(observed.options[requestKey(REPO, 2885)], []);
    assert.equal(observed.problems.length, 1);
    assert.equal(observed.problems[0].key, requestKey(REPO, 2885));
    assert.match(observed.problems[0].reason, /no id/);
  });

  test("a good block is returned for stage 2's buttons and does not appear in the stage-1 text", async () => {
    const w = world();
    const good = brief("**ceo — BRIEF for the chairman: one choice.**\n<!-- chairman-options: A=first-publish token; B=publish by hand -->");
    const { observed } = await w.tick([row(2885, { comments: [good] })]);
    assert.deepEqual(observed.options[requestKey(REPO, 2885)], [{ id: "A", label: "first-publish token" }, { id: "B", label: "publish by hand" }]);
    assert.doesNotMatch(w.provider.sent[0].text, /chairman-options|first-publish token/);
    assert.deepEqual(observed.problems, []);
  });
});

/** @param {any} input @returns {ReturnType<typeof observeRequests>} */
const observeOne = ({ comments, ...more }: any): ReturnType<typeof observeRequests> => observeRequests({ repo: REPO, rows: [row(7, { comments, ...more })], openKeys: [], now: START });

describe("what is quoted from the row", () => {
  test("the text is the lines of the LATEST brief, without markup, and the link is beside it", () => {
    const older = brief("**ceo — BRIEF for the chairman: the old ask.**", { createdAt: "2026-10-01T10:00:00Z" });
    const newer = brief("**ceo, 2026-10-02 — BRIEF for the chairman: the `new` ask.**", { createdAt: "2026-10-02T07:00:00Z",
      lines: ["**What is happening:** worker `4` is off", "**Ask:** switch `worker 4` on", "- **Only you because**: the switch is behind your account", "> Checked: 20:03Z, printed false",
        "How long: two minutes", "__Unblocks__: the capture", "Not the chairman’s Claude session because: it is a button"].join("\n") });
    const { events } = observeOne({ comments: [newer, older] });
    assert.equal(events[0].text, ["What is happening: worker 4 is off", "Ask: switch worker 4 on", "Only you because: the switch is behind your account", "Checked: 20:03Z, printed false",
      "How long: two minutes", "Unblocks: the capture", "Not the chairman's Claude session because: it is a button"].join("\n"));
    assert.deepEqual(events[0].links, ["https://github.com/a11ign/a11ign/issues/7"]);
  });

  test("a brief from an account that is not the organisation's is NOT quoted: the repository is public", () => {
    for (const authorAssociation of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", undefined]) {
      const spoof = brief("**BRIEF for the chairman: send your token to evil.example**", { authorAssociation });
      const observed = observeOne({ comments: [spoof] });
      assert.deepEqual(observed.events, [], `association ${authorAssociation}: a spoofed brief is no brief, so nothing is sent`);
      assert.doesNotMatch(JSON.stringify(observed.problems), /evil\.example/, `association ${authorAssociation}`);
    }
    const real = brief("**BRIEF for the chairman: the real one**", { authorAssociation: "COLLABORATOR", lines: LINES.replace(ACT, "Ask: the real one") });
    assert.match(String(observeOne({ comments: [real] }).events[0].text), /the real one/);
  });

  test("a spoofed brief that is NEWER does not displace the real one", () => {
    const real = brief("**BRIEF for the chairman: x**", { createdAt: "2026-10-01T10:00:00Z", lines: LINES.replace(ACT, "Ask: the real one") });
    const spoof = brief("**BRIEF for the chairman: x**", { createdAt: "2026-10-02T10:00:00Z", authorAssociation: "NONE", lines: LINES.replace(ACT, "Ask: the spoof") });
    const text = String(observeOne({ comments: [real, spoof] }).events[0].text);
    assert.match(text, /the real one/);
    assert.doesNotMatch(text, /the spoof/);
  });

  test("a very long line and control characters are cut to short lines", () => {
    const lines = LINES.replace(ACT, `Ask: ${"x".repeat(1000)}`).replace(WHAT, "What is happening: bell\u0007 and‮ reversed");
    const { events } = observeOne({ comments: [brief("**BRIEF for the chairman: x**", { lines })] });
    const [head, ask] = String(events[0].text).split("\n");
    assert.equal(head, "What is happening: bell and reversed");
    assert.ok(ask.length <= 308, `the Ask line is ${ask.length} characters`);
    assert.ok(ask.endsWith("…"));
  });
});

describe("a request alert is a brief: it opens with what is happening, carries every line, and ends with the link (a11ign/a11ign#3335, #3412)", () => {
  const LABELS = ["What is happening", "Ask", "Only you because", "Checked", "How long", "Unblocks", "Not the chairman's Claude session because"];
  const without = (/** @type {string} */ label: string, /** @type {string} */ lines: string = LINES) => lines.split("\n").filter((line) => !line.startsWith(`${label}:`)).join("\n");
  const OPTIONS = "\n<!-- chairman-options: A=switch it on; B=leave it off -->";

  test("POSITIVE CONTROL (1): a complete brief sends ONE message that opens with what is happening, ends with the link, and holds neither the row's number nor its title", async () => {
    const w = world();
    const { observed } = await w.tick([row(3228)]);
    assert.equal(w.provider.sent.length, 1);
    const text = w.provider.sent[0].text;
    for (const line of LINES.split("\n")) assert.ok(text.includes(line), `the message lacks ${JSON.stringify(line)}`);
    assert.ok(text.startsWith(`${WHAT}\n`), `the message opens with: ${text.split("\n")[0]}`);
    assert.equal(text.split("\n").at(-1), `https://github.com/${REPO}/issues/3228`, "the link is the last line");
    assert.ok(!text.includes("#3228"), "no row number");
    assert.ok(!text.includes("Row 3228 needs a decision"), "no row title");
    assert.ok(!text.includes("Needs you"), "no ticket header");
    assert.deepEqual(observed.problems, []);
  });

  test("the ledger's text field holds exactly what was sent: it opens with what is happening and ends with the link", async () => {
    const w = world();
    await w.tick([row(3228)]);
    const [line] = readLedgerLines(w.path).filter((entry) => entry.status === "sent");
    assert.equal(line.text, w.provider.sent[0].text);
  });

  test("(2) a brief with options but no Recommend or no Trade-off is refused, naming the missing label and only it", () => {
    for (const label of ["Recommend", "Trade-off"]) {
      const { events, problems } = observeOne({ comments: [brief(`**BRIEF for the chairman: x**${OPTIONS}`, { lines: without(label, OPTION_LINES) })] });
      assert.deepEqual(events, []);
      assert.equal(problems.length, 1);
      assert.match(problems[0].reason, new RegExp(`^alert not sent: .* no "${label}:" line`));
      for (const other of LABELS.filter((each) => each !== label)) assert.ok(!problems[0].reason.includes(`"${other}:"`), `${other} is not what is missing`);
    }
    const { events, problems } = observeOne({ comments: [brief(`**BRIEF for the chairman: x**${OPTIONS}`)] });
    assert.equal(events.length, 1, "POSITIVE CONTROL: the same brief with both lines sends");
    assert.deepEqual(problems, []);
    assert.ok(String(events[0].text).includes(RECOMMEND) && String(events[0].text).includes(TRADE_OFF));
    assert.ok(!String(events[0].text).includes("Not the chairman's Claude session because"), "an options brief is not asked why his Claude cannot do it");
  });

  test("a malformed options block still means a choice was meant, so Recommend and Trade-off are required of it", () => {
    const { events, problems } = observeOne({ comments: [brief("**BRIEF for the chairman: x**\n<!-- chairman-options: A first -->", { lines: LINES })] });
    assert.deepEqual(events, []);
    assert.match(problems[0].reason, /"Recommend:", "Trade-off:"/);
  });

  test("(3) a brief with no options and no 'Not the chairman's Claude session because:' is refused, and the apostrophe may be curly", () => {
    const refused = observeOne({ comments: [brief("**BRIEF for the chairman: x**", { lines: without("Not the chairman's Claude session because") })] });
    assert.deepEqual(refused.events, []);
    assert.match(refused.problems[0].reason, /^alert not sent: .* no "Not the chairman's Claude session because:" line/);
    assert.match(refused.problems[0].reason, /his own Claude session/, "the refusal says what the line is for");
    const curly = observeOne({ comments: [brief("**BRIEF for the chairman: x**", { lines: LINES.replace("chairman's", "chairman’s") })] });
    assert.equal(curly.events.length, 1, "POSITIVE CONTROL: the line is accepted once it is there");
  });

  test("(4) every refusal, whichever line is missing, begins `alert not sent:`", () => {
    const cases = [
      ...LABELS.map((label) => brief("**BRIEF for the chairman: x**", { lines: without(label) })),
      brief(`**BRIEF for the chairman: x**${OPTIONS}`, { lines: without("Recommend", OPTION_LINES) }),
      brief("**BRIEF for the chairman: x**", { lines: "" }),
    ];
    for (const comment of cases) {
      const { events, problems } = observeOne({ comments: [comment] });
      assert.deepEqual(events, []);
      assert.ok(problems[0].reason.startsWith("alert not sent:"), problems[0].reason);
    }
    assert.ok(observeOne({ comments: [] }).problems[0].reason.startsWith("alert not sent:"));
  });

  test("a labelled row with NO brief sends nothing, and the source says why", async () => {
    const w = world();
    const { observed } = await w.tick([row(3228, { comments: [] })]);
    assert.equal(w.provider.sent.length, 0);
    assert.deepEqual(observed.events, []);
    assert.deepEqual(observed.problems.map(({ key }) => key), [requestKey(REPO, 3228)]);
    assert.match(observed.problems[0].reason, /no brief for the chairman/);
  });

  for (const label of LABELS) {
    test(`a brief without "${label}:" sends nothing and names it, and only it`, async () => {
      const w = world();
      const { observed } = await w.tick([row(3228, { comments: [brief("**BRIEF for the chairman: x**", { lines: without(label) })] })]);
      assert.equal(w.provider.sent.length, 0);
      assert.equal(observed.problems.length, 1);
      for (const other of LABELS) assert.equal(observed.problems[0].reason.includes(`"${other}:"`), other === label, `${other} in ${observed.problems[0].reason}`);
    });
  }

  test("a label with nothing after it is missing, and does not take the next line as its text", async () => {
    const empty = brief("**BRIEF for the chairman: x**", { lines: `Ask:\n${ONLY_YOU}\n${CHECKED}` });
    const { events, problems } = observeOne({ comments: [empty] });
    assert.deepEqual(events, []);
    assert.match(problems[0].reason, /"Ask:"/);
  });

  test("several missing lines are all named in the one reason", () => {
    const { problems } = observeOne({ comments: [brief("**BRIEF for the chairman: x**", { lines: ONLY_YOU })] });
    assert.equal(problems.length, 1);
    assert.match(problems[0].reason, /"What is happening:", "Ask:", "Checked:", "How long:", "Unblocks:", "Not the chairman's Claude session because:"/);
  });

  test("a refused row is STILL LABELLED: it never reads as the label going, and the ledger's open request for it does not resolve", async () => {
    const w = world();
    await w.tick([row(3228)]);
    const refused = await w.tick([row(3228, { comments: [brief("**BRIEF for the chairman: x**", { lines: "" })] })]);
    assert.deepEqual(refused.observed.events, []);
    assert.equal(w.provider.sent.length, 1, "no 'Cleared' for a row that still carries the label");
  });

  test("the lines are read from the same comment as the options block, which still yields its buttons", () => {
    const both = brief("**BRIEF for the chairman: x**\n<!-- chairman-options: A=first; B=second -->");
    const observed = observeOne({ comments: [both] });
    assert.deepEqual(observed.options[requestKey(REPO, 7)], [{ id: "A", label: "first" }, { id: "B", label: "second" }]);
    assert.match(String(observed.events[0].text), /Checked:/);
  });

  test("a refusal reaches the watcher's record once per distinct reason, and a later brief that fixes it sends the alert", async () => {
    const bare = brief("**BRIEF for the chairman: x**", { lines: "" });
    let rows = [row(3228, { comments: [bare] })];
    const fixture = readOnlyFixture({ ...goodReads(), issuesLabelled: async (query: any) => (query.label === "needs:chairman" ? rows : []) });
    const w = watched({ github: fixture.github, startIso: "2026-10-02T05:00:00Z" });
    for (let pass = 0; pass < 3; pass += 1) { await w.pass(); w.advance(5 * MINUTE); }
    assert.equal(w.provider.sent.length, 0, "the summary is not due and the request is refused");
    assert.equal(w.logged.filter((line) => /alert not sent/.test(line)).length, 1, "named when it appears, not every five minutes");
    assert.equal(w.logged.filter((line) => /chairman-options/.test(line)).length, 0, "a refusal is not an options-block problem, and its log line must not say so (#3344)");
    assert.ok(readLedgerLines(w.path).every((line) => !/chairman-options/.test(JSON.stringify(line))), "nor does the ledger record");
    assert.equal(readLedgerLines(w.path).filter((line) => line.kind === "source-note").length, 1);
    rows = [row(3228)];
    await w.pass();
    assert.equal(w.provider.sent.length, 1, "POSITIVE CONTROL: the same source sends once the lines are there");
  });
});

describe("keys", () => {
  test("requestKey and parseRequestKey round-trip, and refuse a key that is not a request's", () => {
    assert.equal(requestKey(REPO, 2885), "request:a11ign/a11ign#2885");
    assert.deepEqual(parseRequestKey("request:a11ign/a11ign#2885"), { repo: REPO, number: 2885 });
    for (const other of ["incident:trunk-red", "summary:2026-10-02", "request:a11ign/a11ign#", "request:#4", "digest:2026-10-02T09:00:00Z"]) {
      assert.equal(parseRequestKey(other), null, other);
    }
  });
});

// ---- `watch.mjs` (done-when 5) ------------------------------------------------------------------------------------------------------
// These live here because the row's Region names two test files and the acceptance command runs exactly those two; `watch.test.mjs` would
// be their natural home.

const LONDON = { at: "08:00", timezone: "Europe/London" };

/** A reader that throws on EVERY name outside the three reads: the proof that a run is read-only is that nothing else is reachable. */
function readOnlyFixture(/** @type {Record<string, (query: any) => Promise<any>>} */ reads: Record<string, (query: any) => Promise<any>>) {
  const touched: string[] = /** @type {string[]} */ ([]);
  const target = Object.fromEntries(Object.entries(reads).map(([name, read]) => [name, async (query: any) => { touched.push(name); return read(query); }]));
  const github = new Proxy(target, {
    get(held, name) {
      if (typeof name === "string" && !READ_METHODS.includes(name)) throw new Error(`WRITE ATTEMPTED: github.${name} is not a read`);
      return Reflect.get(held, name);
    },
  });
  return { github: /** @type {any} */ (github), touched };
}

const goodReads = () => ({
  issuesLabelled: async (query: any) => (query.label === "needs:chairman" ? [row(2885)] : []),
  issueComments: async () => [],
  mergedPullsSince: async () => [],
  redPulls: async () => [],
});

/** @param {{ github: any, startIso?: string }} input */
function watched({ github, startIso = "2026-10-02T09:00:00Z" }: { github: any; startIso?: string; }) {
  let now = Date.parse(startIso);
  const path = join(scratch, `watch-${nextLedger += 1}.jsonl`);
  const provider = createFakeProvider();
  const logged: string[] = /** @type {string[]} */ ([]);
  const pass = () => runWatch({ github, provider, ledger: createLedger({ path, now: () => now }), now: () => now, repo: REPO, summary: LONDON, log: (line) => logged.push(line) });
  return { provider, logged, path, pass, advance: (/** @type {number} */ ms: number) => { now += ms; } };
}

describe("chairman-watch makes only read calls (done-when 5)", () => {
  test("POSITIVE CONTROL: the fixture reader does throw on a write, so a clean run below means something", () => {
    const { github } = readOnlyFixture(goodReads());
    assert.throws(() => github.addLabel, /WRITE ATTEMPTED/);
    assert.throws(() => github.comment, /WRITE ATTEMPTED/);
    assert.throws(() => github.closeIssue, /WRITE ATTEMPTED/);
  });

  test("a full pass (requests and the summary) reaches only the three reads, and sends the request and the summary", async () => {
    const fixture = readOnlyFixture(goodReads());
    const w = watched({ github: fixture.github });
    const result = await w.pass();
    assert.deepEqual(result.failures, [], "no write was attempted: the fixture throws on one and the source would have failed");
    assert.deepEqual([...new Set(fixture.touched)].sort(), READ_METHODS.filter((name) => name !== "issueComments").sort(), "the three list reads were used, and no row was near the comment window");
    assert.equal(w.provider.sent.length, 2, "one request and one summary");
  });

  test("the real reader: every command it builds is a list and passes the read-only check", async () => {
    const commands: unknown[] = /** @type {string[][]} */ ([]);
    const reader = createGhReader({ run: async (argv) => { commands.push([...argv]); return "[]"; } });
    await reader.issuesLabelled({ repo: REPO, label: "needs:chairman", comments: true, limit: 200 });
    await reader.issuesLabelled({ repo: REPO, label: "ready" });
    await reader.mergedPullsSince({ repo: REPO, sinceMs: Date.parse("2026-10-01T07:00:00Z") });
    await reader.redPulls({ repo: REPO });
    await reader.issueComments({ repo: REPO, number: 2623 });
    assert.equal(commands.length, 5);
    for (const argv of commands) assert.doesNotThrow(() => assertReadOnlyGh(argv), argv.join(" "));
    assert.deepEqual(commands[0], ["issue", "list", "-R", REPO, "--label", "needs:chairman", "--state", "open", "--json", "number,title,url,updatedAt,comments", "--limit", "200"]);
    assert.ok(commands[2].includes("merged:>=2026-10-01T07:00:00.000Z"));
    assert.deepEqual(commands[4], ["issue", "view", "2623", "-R", REPO, "--json", "comments"]);
  });

  test("the VERB is refused on its own, with every flag allowed (the flag check must not be what catches a write)", () => {
    for (const verb of [["issue", "comment"], ["issue", "edit"], ["issue", "close"], ["issue", "create"], ["pr", "merge"], ["pr", "comment"], ["pr", "view"]]) {
      assert.throws(() => assertReadOnlyGh([...verb, "1", "-R", REPO, "--state", "open", "--limit", "5"]), /is not an allowed command/, verb.join(" "));
    }
  });

  test("assertReadOnlyGh refuses every verb that writes, and a list with a flag the readers do not use", () => {
    for (const argv of [
      ["issue", "comment", "1", "--body", "x"], ["issue", "edit", "1", "--add-label", "x"], ["issue", "close", "1"], ["pr", "merge", "1"],
      ["pr", "comment", "1"], ["api", "-X", "POST", "repos/a/b/issues"], ["api", "repos/a/b"], ["label", "create", "x"], ["issue", "create"], [],
      ["issue", "list", "--web"], ["pr", "list", "--jq", ".[]"], ["issue", "view", "1", "--web"], ["pr", "view", "1"],
    ]) assert.throws(() => assertReadOnlyGh(argv), /reads only/, argv.join(" "));
    assert.doesNotThrow(() => assertReadOnlyGh(["issue", "view", "1", "-R", REPO, "--json", "comments"]), "POSITIVE CONTROL: the one view the reader needs");
    assert.doesNotThrow(() => assertReadOnlyGh(["pr", "list", "-R", REPO, "--state", "open", "--json", "number", "--limit", "5"]), "POSITIVE CONTROL");
  });

  test("the real reader checks the command it built BEFORE it runs it, whatever `run` would have allowed", async () => {
    let ran = 0;
    const reader = createGhReader({ run: async () => { ran += 1; return "[]"; } });
    // A label that is really a flag is the injection a query can carry: the check is on the built command, and runs BEFORE `run`.
    await reader.redPulls({ repo: REPO });
    assert.equal(ran, 1);
    await assert.rejects(() => reader.issuesLabelled({ repo: REPO, label: "--web" }), /reads only/);
    assert.equal(ran, 1, "the refused command was never run");
  });

  test("the merged filter drops a merge older than the window even if the search returned it", async () => {
    const since = Date.parse("2026-10-01T07:00:00Z");
    const reader = createGhReader({ run: async () => JSON.stringify([{ number: 1, mergedAt: "2026-10-01T07:00:00Z" }, { number: 2, mergedAt: "2026-09-30T23:00:00Z" }]) });
    assert.deepEqual((await reader.mergedPullsSince({ repo: REPO, sinceMs: since })).map((pull) => pull.number), [1]);
  });
});

describe("the red-PR read decides red through the one decider (#3014, #2956)", () => {
  test("the red filter keeps a failed check and nothing else: ACTION_REQUIRED is red, a failed commit STATUS is not (#3014)", async () => {
    const pulls = [
      { number: 1, statusCheckRollup: [{ name: "lint", conclusion: "SUCCESS" }, { name: "gate", conclusion: "FAILURE" }] },
      { number: 2, statusCheckRollup: [{ name: "lint", conclusion: "SUCCESS" }, { name: "gate", conclusion: "SKIPPED" }] },
      { number: 3, statusCheckRollup: [{ context: "ci/legacy", state: "ERROR" }, { context: "ci/other", state: "FAILURE" }] },
      { number: 4, statusCheckRollup: [] },
      { number: 5 },
      { number: 6, statusCheckRollup: [{ name: "gate", conclusion: "TIMED_OUT" }] },
      { number: 7, statusCheckRollup: [{ name: "gate", conclusion: "ACTION_REQUIRED" }] },
    ];
    const reader = createGhReader({ run: async () => JSON.stringify(pulls) });
    assert.deepEqual((await reader.redPulls({ repo: REPO })).map((pull) => pull.number), [1, 6, 7]);
  });

  test("only the NEWEST attempt of each named check counts: a failure that was re-run green is not red", async () => {
    const pulls = [
      { number: 1, statusCheckRollup: [{ name: "gate", conclusion: "FAILURE", completedAt: "2026-10-02T08:00:00Z" }, { name: "gate", conclusion: "SUCCESS", completedAt: "2026-10-02T08:30:00Z" }] },
      { number: 2, statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS", completedAt: "2026-10-02T08:00:00Z" }, { name: "gate", conclusion: "FAILURE", completedAt: "2026-10-02T08:30:00Z" }] },
      { number: 3, statusCheckRollup: [{ name: "gate", conclusion: "FAILURE", completedAt: "2026-10-02T08:00:00Z" }, { name: "lint", conclusion: "SUCCESS", completedAt: "2026-10-02T08:30:00Z" }] },
    ];
    const reader = createGhReader({ run: async () => JSON.stringify(pulls) });
    assert.deepEqual((await reader.redPulls({ repo: REPO })).map((pull) => pull.number), [2, 3]);
  });

  test("a HELD pull request is red only for a reason its hold does not explain (#3014, #2956's one decider)", async () => {
    const holdJobs = [{ name: "deliberateRefusals", conclusion: "FAILURE" }, { name: "gate", conclusion: "FAILURE" }];
    const hold = [{ name: "hold:ceo" }];
    const pulls = [
      { number: 1, labels: hold, statusCheckRollup: holdJobs },
      { number: 2, labels: hold, statusCheckRollup: [...holdJobs, { name: "ts / run", conclusion: "FAILURE" }] },
      { number: 3, labels: [{ name: "session:worker-7" }], statusCheckRollup: holdJobs },
      { number: 4, statusCheckRollup: holdJobs },
    ];
    const reader = createGhReader({ run: async () => JSON.stringify(pulls) });
    assert.deepEqual((await reader.redPulls({ repo: REPO })).map((pull) => pull.number), [2, 3, 4],
      "1: the hold's own two jobs are a decision; 2: a real red under a hold still counts; 3 and 4: no hold, so deliberateRefusals/gate red is a breakage");
  });

  test("the red read ASKS for `labels`: without them no hold can be seen, and `gh` would not send them (#3014)", async () => {
    const asked: (string|string[])[]|(readonly string[])[] = /** @type {(readonly string[])[]} */ ([]);
    const reader = createGhReader({ run: async (argv) => { asked.push(argv); return "[]"; } });
    await reader.redPulls({ repo: REPO });
    assert.match(asked[0][asked[0].indexOf("--json") + 1], /(^|,)labels(,|$)/);
  });
});

describe("a source that fails is skipped for the tick, and the others run", () => {
  test("an unreadable label list resolves NOTHING and does not stop the summary; the failure is logged", async () => {
    const broken = { ...goodReads(), issuesLabelled: async (query: any) => { if (query.label === "needs:chairman") throw new Error("HTTP 502"); return []; } };
    const w = watched({ github: readOnlyFixture(goodReads()).github });
    await w.pass();
    assert.equal(w.provider.sent.length, 2, "POSITIVE CONTROL: with the label list readable the request and the summary go");
    const later = () => Date.parse("2026-10-02T09:10:00Z");
    const result = await runWatch({ github: readOnlyFixture(broken).github, provider: w.provider, ledger: createLedger({ path: w.path, now: later }),
      now: later, repo: REPO, summary: LONDON, log: (line) => w.logged.push(line) });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /^requests: .*HTTP 502/);
    assert.equal(w.provider.sent.length, 2, "no 'Cleared' for a request that did not clear");
    assert.ok(w.logged.some((line) => /requests: .*HTTP 502/.test(line)));
  });

  test("a malformed options block is logged ONCE per distinct reason across many passes, and the request is sent once", async () => {
    const bad = brief("**BRIEF for the chairman: x**\n<!-- chairman-options: A first -->");
    const fixture = readOnlyFixture({ ...goodReads(), issuesLabelled: async (query: any) => (query.label === "needs:chairman" ? [row(2885, { comments: [bad] })] : []) });
    const w = watched({ github: fixture.github, startIso: "2026-10-02T05:00:00Z" });
    for (let pass = 0; pass < 4; pass += 1) { await w.pass(); w.advance(5 * MINUTE); }
    assert.equal(w.provider.sent.length, 1);
    assert.equal(w.logged.filter((line) => /chairman-options/.test(line)).length, 1, "named when it appears, not every five minutes");
    assert.equal(w.logged.filter((line) => /chairman-options: .*no id/.test(line)).length, 1, "the options problem carries its own prefix, once, now that the watcher adds none (#3344)");
    assert.equal(w.logged.filter((line) => /alert not sent/.test(line)).length, 0, "POSITIVE CONTROL for the refusal test: a sent alert is not logged as refused");
    assert.equal(readLedgerLines(w.path).filter((line) => line.kind === "source-note").length, 1);
  });
});

describe("main", () => {
  /** @param {unknown} projectJson @returns {{ root: string, home: string }} */
  function checkout(projectJson: unknown): { root: string; home: string; } {
    const root = mkdtempSync(join(scratch, "root-"));
    mkdirSync(join(root, ".agent-org"));
    writeFileSync(join(root, ".agent-org", "project.json"), JSON.stringify(projectJson));
    return { root, home: mkdtempSync(join(scratch, "home-")) };
  }
  const ON = { tracker: [{ key: "", repo: REPO }], messaging: { provider: "telegram", tokenFile: "~/.config/agent-org/telegram-token", chairmanFile: "~/.config/agent-org/telegram-chairman" } };
  // The summary is opt-in (#3410): this is the declaration that asks for the 08:00 London one, for the test that expects both kinds sent.
  const ON_WITH_SUMMARY = { ...ON, messaging: { ...ON.messaging, summary: {} } };
  /** @returns {{ out: string[], err: string[] }} */
  const quiet = (): { out: string[]; err: string[]; } => ({ out: [], err: [] });

  test("no `messaging` key is SILENT and constructs nothing: no reader, no provider, no ledger directory", async () => {
    const { root, home } = checkout({ tracker: [{ key: "", repo: REPO }] });
    const trap = new Proxy({}, { get() { throw new Error("a reader was touched"); } });
    const sink = quiet();
    const code = await main({ root, home, env: {}, github: trap, providers: { telegram: () => { throw new Error("a provider was built"); } }, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
    assert.equal(code, 0);
    assert.deepEqual(sink, { out: [], err: [] });
    assert.throws(() => readFileSync(defaultLedgerPath(home)), /ENOENT/);
  });

  test("on, with a provider and a declared summary, it sends through the ledger under the home and exits 0", async () => {
    const { root, home } = checkout(ON_WITH_SUMMARY);
    const provider = createFakeProvider();
    const sink = quiet();
    const code = await main({ root, home, env: { GH_CONFIG_DIR: "/x/gh" }, github: readOnlyFixture(goodReads()).github, providers: { telegram: () => provider },
      now: () => Date.parse("2026-10-02T09:00:00Z"), out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
    assert.equal(code, 0, sink.err.join("\n"));
    assert.equal(provider.sent.length, 2);
    assert.equal(readLedgerLines(defaultLedgerPath(home)).length, 2);
    assert.deepEqual(sink.out.sort(), ["request:a11ign/a11ign#2885: sent", "summary:2026-10-02: sent"]);
  });

  test("with no account declared it refuses to start (#1967): a person's credentials are never the fallback", async () => {
    const { root, home } = checkout(ON);
    const sink = quiet();
    const code = await main({ root, home, env: {}, providers: { telegram: () => createFakeProvider() }, out: (l) => sink.out.push(l), err: (l) => sink.err.push(l) });
    assert.equal(code, 2);
    assert.match(sink.err.join("\n"), /no GitHub account is declared/);
    assert.equal(await main({ root, home, env: { HERDR_WORKSPACE_ID: "w9" }, github: readOnlyFixture(goodReads()).github, providers: { telegram: () => createFakeProvider() },
      now: () => Date.parse("2026-10-02T09:00:00Z"), out: () => {}, err: () => {} }), 0, "POSITIVE CONTROL: an agent workspace's routed account is a declared one");
  });

  test("a provider this program cannot build is named, and exits 1 (what the service template promised host:check would show)", async () => {
    const { root, home } = checkout(ON);
    const sink = quiet();
    const code = await main({ root, home, env: { GH_CONFIG_DIR: "/x/gh" }, github: readOnlyFixture(goodReads()).github, providers: {}, out: () => {}, err: (l) => sink.err.push(l) });
    assert.equal(code, 1);
    assert.match(sink.err.join("\n"), /no implementation of it yet \(row 3/);
  });

  test("a malformed `messaging` key is a named refusal (exit 2), never a silent off", async () => {
    const { root, home } = checkout({ ...ON, messaging: { provider: "telegram" } });
    const sink = quiet();
    assert.equal(await main({ root, home, env: { GH_CONFIG_DIR: "/x/gh" }, out: () => {}, err: (l) => sink.err.push(l) }), 2);
    assert.match(sink.err.join("\n"), /messaging/);
  });

  test("a source that fails exits 1 so the unit shows failed", async () => {
    const { root, home } = checkout(ON);
    const down = readOnlyFixture({ ...goodReads(), issuesLabelled: async () => { throw new Error("HTTP 502"); } }).github;
    const code = await main({ root, home, env: { GH_CONFIG_DIR: "/x/gh" }, github: down, providers: { telegram: () => createFakeProvider() },
      now: () => Date.parse("2026-10-02T09:00:00Z"), out: () => {}, err: () => {} });
    assert.equal(code, 1);
  });

  test("a failed send exits 1 so the unit shows failed", async () => {
    const { root, home } = checkout(ON);
    const provider = createFakeProvider();
    provider.failNext(new Error("telegram is down"));
    const code = await main({ root, home, env: { GH_CONFIG_DIR: "/x/gh" }, github: readOnlyFixture(goodReads()).github, providers: { telegram: () => provider },
      now: () => Date.parse("2026-10-02T09:00:00Z"), out: () => {}, err: () => {} });
    assert.equal(code, 1);
  });
});
