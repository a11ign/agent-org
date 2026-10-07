// @ts-check
// THE LIAISON'S CHECKED FACTS (a11ign/a11ign#3420, B3 of #3409): `{{fleet.workers-up}}`, `{{fleet.workers-down}}`, `{{gate.last-tick.age}}` and
// `{{release:OWNER/REPO.latest}}` beside the issue, pull request and run ones. The vocabulary grows by readers and by nothing else, so what is pinned here is
// each new placeholder resolving from a reader and stamped, a reader that fails REFUSING and naming which, a name outside the vocabulary refused, the
// worker's NAME and never its address, and the list of names (the liaison's brief restates it).
//
// **THE POSITIVE CONTROLS:** every "refused" case asserts the provider's `sent` is empty AND the sentence with the same shape and a name that exists is sent
// (`NAMED_FACTS`), so a checker that refuses everything fails the second and one that accepts everything fails the first. The address control is a real
// address in both files that must not appear in what was sent.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { COMPLETION_FILE, writeCompletion } from "../lib/tick-completion.mjs";
import { createFakeProvider } from "./fake-provider.ts";
import { createLedger } from "./ledger.mjs";
import { PLACEHOLDER_NAMES, createGhReaders, parsePlaceholders } from "./placeholders.mjs";
import { createReply } from "./reply.mjs";

const NOW = Date.parse("2026-10-04T14:05:30Z");
const STAMP = "as of 14:05Z";
const MINUTE = 60_000;
const RELEASE_REPO = "a11ign/agent-org";
const NAMED_FACTS = "Up: {{fleet.workers-up}}. Down: {{fleet.workers-down}}. Gate: {{gate.last-tick.age}}. Newest: {{release:a11ign/agent-org.latest}}.";

const scratch = mkdtempSync(join(tmpdir(), "messaging-placeholders-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let directories = 0;
const freshDirectory = () => mkdtempSync(join(scratch, `d${(directories += 1)}-`));

/** @param {string} name @returns {never} */
function unreadable(name) {
  throw new Error(`${name} could not be read`);
}

/** Fixture readers for the kinds this row is not about, so only the new ones vary. @param {Partial<import("./placeholders.mjs").Readers>} overrides @returns {import("./placeholders.mjs").Readers} */
function fixtureReaders(overrides) {
  return {
    issue: async (number) => ({ number, state: "open", labels: [] }),
    pr: async (number) => ({ number, state: "open", review: "none" }),
    run: async () => ({ status: "completed", conclusion: "success" }),
    ready: async () => ({ count: 0 }),
    open: async () => ({ count: 0 }),
    lastMerge: async () => ({ at: NOW }),
    unit: async () => ({ state: "active" }),
    comment: async () => ({ body: "x", url: "https://example.test/c" }),
    fleet: async () => ({ up: ["worker-a", "worker-c"], down: ["worker-b"], polledAt: NOW - 10 * MINUTE }),
    gate: async () => ({ at: NOW - 4 * MINUTE }),
    release: async () => ({ tag: "v1.4.0" }),
    ...overrides,
  };
}

/** @param {import("./placeholders.mjs").Readers} readers */
function replyOver(readers) {
  const provider = createFakeProvider();
  const ledger = createLedger({ path: join(freshDirectory(), "ledger.jsonl"), now: () => NOW });
  return { provider, reply: createReply({ send: (message) => provider.send(message), ledger, readers, now: () => NOW }) };
}

describe("(1) each new placeholder resolves from a reader, and the message is stamped as of the send", () => {
  test("all four in one message: what the fixture readers say, then the stamp as the last line", async () => {
    const { reply, provider } = replyOver(fixtureReaders({}));
    assert.equal((await reply.send(NAMED_FACTS)).outcome, "sent");
    assert.deepEqual(provider.sent.map((message) => message.text), [
      `Up: worker-a, worker-c (fleet-watch poll 10m ago). Down: worker-b (fleet-watch poll 10m ago). Gate: 4m. Newest: v1.4.0.\n\n${STAMP}`,
    ]);
  });

  test("a READ and not a memory: other answers make other words, and an empty list says 'none' rather than rendering as nothing", async () => {
    const { reply, provider } = replyOver(fixtureReaders({
      fleet: async () => ({ up: [], down: ["worker-a"], polledAt: NOW - 61 * MINUTE }),
      gate: async () => ({ at: NOW - 3 * 60 * MINUTE }), release: async () => ({ tag: "v2.0.0-rc.1" }),
    }));
    await reply.send(NAMED_FACTS);
    assert.match(provider.sent[0].text, /^Up: none \(fleet-watch poll 1h 1m ago\)\. Down: worker-a .*Gate: 3h 0m\. Newest: v2\.0\.0-rc\.1\./);
  });

  test("the release is asked for the repository NAMED, once however many fields are used", async () => {
    /** @type {string[]} */
    const asked = [];
    const { reply } = replyOver(fixtureReaders({ release: async (repo) => { asked.push(repo); return { tag: "v1.0.0" }; } }));
    await reply.send("{{release:a11ign/agent-org.latest}} and {{release:a11ign/agent-org.latest}}, {{release:a11ign/a11ign.latest}}");
    assert.deepEqual(asked.sort(), ["a11ign/a11ign", "a11ign/agent-org"]);
  });
});

describe("(2) a reader that fails REFUSES the send and names which", () => {
  for (const [placeholder, reader] of /** @type {[string, "fleet" | "gate" | "release"][]} */ ([
    ["{{fleet.workers-up}}", "fleet"], ["{{fleet.workers-down}}", "fleet"], ["{{gate.last-tick.age}}", "gate"], ["{{release:a11ign/agent-org.latest}}", "release"],
  ])) {
    test(`${placeholder}: the refusal names it and the reason, nothing is sent, and the one failing is the only one named`, async () => {
      const { reply, provider } = replyOver(fixtureReaders({ [reader]: () => unreadable(reader) }));
      const result = /** @type {any} */ (await reply.send(NAMED_FACTS));
      assert.equal(result.outcome, "refused");
      assert.ok(result.problems.some((/** @type {any} */ problem) => problem.placeholder === placeholder && new RegExp(`${reader} could not be read`).test(problem.reason)));
      assert.ok(result.problems.every((/** @type {any} */ problem) => NAMED_FACTS.includes(problem.placeholder)));
      assert.deepEqual(provider.sent, []);
    });
  }

  test("the refusal's own text passes the checker that refused (`unchecked:` takes the new names too)", async () => {
    const { reply, provider } = replyOver(fixtureReaders({ fleet: () => unreadable("fleet") }));
    const refusal = /** @type {any} */ (await reply.send("{{fleet.workers-up}}"));
    assert.match(refusal.sendable, /\{\{unchecked:fleet\.workers-up\}\}/);
    assert.equal((await reply.send(refusal.sendable)).outcome, "sent");
    assert.match(provider.sent[0].text, /not stated: \[fleet\.workers-up\]\./);
  });

  test("a host that named no fleet files or no gate record refuses with that, rather than guessing a path", async () => {
    const { reply, provider } = replyOver(createGhReaders({ gh: async () => "{}", systemctl: async () => "", repo: "a11ign/a11ign", now: () => NOW }));
    const result = /** @type {any} */ (await reply.send("{{fleet.workers-up}} {{gate.last-tick.age}}"));
    assert.equal(result.outcome, "refused");
    assert.deepEqual(result.problems.map((/** @type {any} */ problem) => problem.placeholder), ["{{fleet.workers-up}}", "{{gate.last-tick.age}}"]);
    assert.match(result.problems[0].reason, /named no fleet-watch state files/);
    assert.match(result.problems[1].reason, /named no work-tick completion record/);
    assert.deepEqual(provider.sent, []);
  });
});

describe("(3) a placeholder outside the vocabulary is refused; (1)'s success is the control that not everything resolves", () => {
  for (const [wrong, why] of /** @type {[string, RegExp][]} */ ([
    ["{{fleet.workers-sideways}}", /"fleet" has no field "workers-sideways"/],
    ["{{fleet:3.workers-up}}", /"fleet" takes no id/],
    ["{{gate.age}}", /"gate" has no field "age"/],
    ["{{gate.last-tick.state}}", /"gate" has no field "last-tick\.state"/],
    ["{{release.latest}}", /"release" needs an id of the right shape/],
    ["{{release:agent-org.latest}}", /"release" needs an id of the right shape/],
    ["{{release:a11ign/agent-org/extra.latest}}", /"release" needs an id of the right shape/],
    ["{{release:../../orgs/a11ign.latest}}", /"release" needs an id of the right shape/],
    ["{{release:-x/y.latest}}", /"release" needs an id of the right shape/],
    ["{{release:a11ign/agent-org.draft}}", /"release" has no field "draft"/],
    ["{{releases:a11ign/agent-org.latest}}", /"releases" is not a kind of fact/],
  ])) {
    test(`${wrong} is refused, nothing is sent, and no reader is asked`, async () => {
      let asked = 0;
      const count = () => { asked += 1; return unreadable("anything"); };
      const { reply, provider } = replyOver(fixtureReaders({ fleet: count, gate: count, release: count }));
      const result = /** @type {any} */ (await reply.send(`Checked: ${wrong}`));
      assert.equal(result.outcome, "refused");
      assert.match(result.problems[0].reason, why);
      assert.deepEqual([provider.sent, asked], [[], 0]);
    });
  }

  test("CONTROL: the same sentences with names that exist resolve (a vocabulary that refused everything would pass the cases above)", () => {
    assert.deepEqual(parsePlaceholders(NAMED_FACTS).problems, []);
    assert.equal(parsePlaceholders(NAMED_FACTS).placeholders.length, 4);
  });

  test("the grammar that admits a hyphenated and a dotted field still reads the older kinds as it did", () => {
    const { placeholders, problems } = parsePlaceholders("{{unit:a11ign-work-tick.service.state}} {{last-merge.age}} {{pr:7.review}}");
    assert.deepEqual(problems, []);
    assert.deepEqual(placeholders.map(({ kind, id, field }) => [kind, id, field]), [["unit", "a11ign-work-tick.service", "state"], ["last-merge", null, "age"], ["pr", "7", "review"]]);
  });
});

describe("(4) through the REAL readers: the worker's NAME and never its address, and a gate and a release read from where they live", () => {
  const ADDRESS = "host-z.example:8765";

  /** The two files `fleet-watch` writes, naming workers by `<name>  <address>` as the non-ready one really does, written 10 minutes ago. */
  function fleetFiles() {
    const directory = freshDirectory();
    const wroteAt = NOW - 10 * MINUTE;
    const statePath = join(directory, "fleet-watch-state.json");
    const capturesPath = join(directory, "fleet-captures-state.json");
    writeFileSync(statePath, JSON.stringify({ [`worker-b  ${ADDRESS}`]: NOW - 30 * MINUTE }));
    const stamp = (/** @type {number} */ behind) => ({ captures: 0, seenAt: wroteAt - behind, lastRoseAt: null, rises: [] });
    writeFileSync(capturesPath, JSON.stringify({ since: 1, workers: { [`worker-a  ${ADDRESS}`]: stamp(0), [`worker-b  ${ADDRESS}`]: stamp(0), "worker-c": stamp(0), "worker-d": stamp(60 * MINUTE) } }));
    for (const path of [statePath, capturesPath]) utimesSync(path, wroteAt / 1000, wroteAt / 1000);
    return { statePath, capturesPath };
  }

  test("{{fleet.workers-up}} and {{fleet.workers-down}} say names over files that carry an address; the address is in neither the message nor the ledger", async () => {
    const gateRecordPath = join(freshDirectory(), COMPLETION_FILE);
    writeCompletion(gateRecordPath, { at: NOW - 4 * MINUTE, exit: 0 });
    const gh = async (/** @type {string[]} */ argv) => {
      assert.deepEqual(argv, ["api", `repos/${RELEASE_REPO}/releases/latest`], "the one read the release makes: a GET of the repository's latest release");
      return JSON.stringify({ tag_name: "v1.4.0", draft: false });
    };
    const readers = createGhReaders({ gh, systemctl: async () => "", repo: "a11ign/a11ign", fleet: fleetFiles(), gateRecordPath, now: () => NOW });
    const ledgerPath = join(freshDirectory(), "ledger.jsonl");
    const provider = createFakeProvider();
    const reply = createReply({ send: (message) => provider.send(message), ledger: createLedger({ path: ledgerPath, now: () => NOW }), readers, now: () => NOW });
    assert.equal((await reply.send(NAMED_FACTS)).outcome, "sent");
    assert.equal(provider.sent[0].text, `Up: worker-a, worker-c (fleet-watch poll 10m ago). Down: worker-b, worker-d (fleet-watch poll 10m ago). Gate: 4m. Newest: v1.4.0.\n\n${STAMP}`);
    assert.doesNotMatch(provider.sent[0].text, /host-z|8765/);
    const ledger = readFileSync(ledgerPath, "utf8");
    assert.match(ledger, /worker-a/, "CONTROL: the ledger holds what was said, so its having no address is a finding");
    assert.doesNotMatch(ledger, /host-z|8765/);
  });

  test("a watcher that stopped, and a gate that has completed nothing, REFUSE: the real readers throw, they do not say 'none'", async () => {
    const stale = fleetFiles();
    const readers = createGhReaders({
      gh: async () => "{}", systemctl: async () => "", repo: "a11ign/a11ign", fleet: stale, gateRecordPath: join(freshDirectory(), COMPLETION_FILE), now: () => NOW + 3 * 60 * MINUTE,
    });
    const { reply, provider } = replyOver(readers);
    const result = /** @type {any} */ (await reply.send("{{fleet.workers-down}} {{gate.last-tick.age}}"));
    assert.equal(result.outcome, "refused");
    assert.match(result.problems[0].reason, /fleet-watch last wrote its state \d+ minutes ago/);
    assert.match(result.problems[1].reason, /no tick is known to have completed/);
    assert.deepEqual(provider.sent, []);
  });

  test("a repository with no release refuses with what GitHub said (a 404 is not 'no release')", async () => {
    const readers = createGhReaders({ gh: async () => { throw new Error("HTTP 404: Not Found"); }, systemctl: async () => "", repo: "a11ign/a11ign", now: () => NOW });
    const { reply, provider } = replyOver(readers);
    const result = /** @type {any} */ (await reply.send("{{release:a11ign/agent-org.latest}}"));
    assert.equal(result.outcome, "refused");
    assert.match(result.problems[0].reason, /404/);
    assert.deepEqual(provider.sent, []);
  });
});

describe("(5) the list of placeholder names is pinned, because the liaison's brief restates it", () => {
  test("PLACEHOLDER_NAMES is exactly this list: a name added or dropped is a name the brief must learn or forget", () => {
    assert.deepEqual([...PLACEHOLDER_NAMES], [
      "issue:<number>.number", "issue:<number>.state", "issue:<number>.labels",
      "pr:<number>.number", "pr:<number>.state", "pr:<number>.review",
      "run:<id>.status", "run:<id>.conclusion",
      "ready.count",
      "open.count",
      "last-merge.age",
      "unit:<unit>.state",
      "comment:<id>.quote",
      "fleet.workers-up", "fleet.workers-down",
      "gate.last-tick.age",
      "release:<repo>.latest",
    ]);
  });

  test("every name in it PARSES once its id is filled in, and the four new ones are in it (the list is the table, not a second copy of it)", () => {
    const filled = [...PLACEHOLDER_NAMES].map((name) => `{{${name.replace("<number>", "7").replace("<id>", "7").replace("<unit>", "a.service").replace("<repo>", RELEASE_REPO)}}}`);
    assert.deepEqual(parsePlaceholders(filled.join(" ")).problems, []);
    for (const added of ["fleet.workers-up", "fleet.workers-down", "gate.last-tick.age", "release:<repo>.latest", "open.count"]) assert.ok(PLACEHOLDER_NAMES.includes(added), added);
  });
});

describe("(6) a run is read by `.status` while it runs and by its conclusion once it has one", () => {
  /** @param {{status: string, conclusion: string | null}} run the REAL run reader over the one GET it makes, so what GitHub says is what is read */
  function readerOver(run) {
    const gh = async (/** @type {string[]} */ argv) => {
      assert.deepEqual(argv, ["api", "repos/a11ign/a11ign/actions/runs/7"], "the one read a run makes: a GET of the run");
      return JSON.stringify({ id: 7, ...run });
    };
    return replyOver(createGhReaders({ gh, systemctl: async () => "", repo: "a11ign/a11ign", now: () => NOW }));
  }

  test("`.status` of a run in progress says where it is; once concluded it says the conclusion, and the same field serves both", async () => {
    for (const [run, said] of /** @type {const} */ ([
      [{ status: "queued", conclusion: null }, "queued"],
      [{ status: "in_progress", conclusion: null }, "in_progress"],
      [{ status: "completed", conclusion: "failure" }, "failure"],
      [{ status: "completed", conclusion: "success" }, "success"],
    ])) {
      const { reply, provider } = readerOver(run);
      assert.equal((await reply.send("{{run:7.status}}")).outcome, "sent", said);
      assert.match(provider.sent[0].text, new RegExp(`^${said}\\n`));
    }
  });

  test("`.conclusion` still refuses a run that has not concluded, and says what its status is; `.status` of the same run does not refuse", async () => {
    const running = readerOver({ status: "in_progress", conclusion: null });
    const refused = /** @type {any} */ (await running.reply.send("{{run:7.conclusion}}"));
    assert.equal(refused.outcome, "refused");
    assert.match(refused.problems[0].reason, /has not concluded \(status in_progress\)/);
    assert.deepEqual(running.provider.sent, []);
    assert.equal((await readerOver({ status: "in_progress", conclusion: null }).reply.send("{{run:7.status}}")).outcome, "sent", "the control: the same run through the other field");
    assert.equal((await readerOver({ status: "completed", conclusion: "success" }).reply.send("{{run:7.conclusion}}")).outcome, "sent", "the control: a concluded run through `.conclusion`");
  });

  test("a run GitHub calls `completed` with no conclusion refuses and does not say \"completed\", which is a status and never a final state", async () => {
    const { reply, provider } = readerOver({ status: "completed", conclusion: null });
    const refused = /** @type {any} */ (await reply.send("{{run:7.status}}"));
    assert.equal(refused.outcome, "refused");
    assert.match(refused.problems[0].reason, /the run's status came back empty/);
    assert.deepEqual(provider.sent, []);
  });
});

describe("(7) how many rows are open is a placeholder, so the figure is read and never typed (a11ign/a11ign#3909)", () => {
  const ROW = (/** @type {number} */ number) => ({ number, labels: [] });
  const PULL = (/** @type {number} */ number) => ({ number, labels: [], pull_request: {} });
  /** @param {unknown[][]} pages what GitHub lists, page by page, with pull requests among the issues as it does @param {string[]} asked collects each path read */
  function ghOver(pages, asked) {
    return async (/** @type {string[]} */ argv) => {
      assert.equal(argv[0], "api");
      asked.push(argv[1]);
      const page = Number(/[?&]page=(\d+)/.exec(argv[1])?.[1]);
      return JSON.stringify(pages[page - 1] ?? []);
    };
  }
  /** @param {unknown[][]} pages */
  function readerOver(pages, asked = /** @type {string[]} */ ([])) {
    return replyOver(createGhReaders({ gh: ghOver(pages, asked), systemctl: async () => "", repo: "a11ign/a11ign", now: () => NOW }));
  }

  test("`{{open.count}}` is the number of open ROWS: pull requests the issues endpoint lists are not counted", async () => {
    const { reply, provider } = readerOver([[ROW(1), PULL(2), ROW(3), PULL(4), ROW(5)]]);
    assert.equal((await reply.send("{{open.count}} rows are open")).outcome, "sent");
    assert.match(provider.sent[0].text, /^3 rows are open\n/);
  });

  test("a list longer than a page is counted to its end, and the read stops at the first short page", async () => {
    const full = Array.from({ length: 100 }, (_, index) => (index % 2 === 0 ? ROW(index + 1) : PULL(index + 1)));
    const asked = /** @type {string[]} */ ([]);
    const { reply, provider } = readerOver([full, full, [ROW(201), ROW(202)]], asked);
    assert.equal((await reply.send("{{open.count}} rows are open")).outcome, "sent");
    assert.match(provider.sent[0].text, /^102 rows are open\n/);
    assert.equal(asked.length, 3, "three pages read, and no fourth after the short one");
  });

  test("the count is read ONCE however often the text uses it", async () => {
    const asked = /** @type {string[]} */ ([]);
    const { reply } = readerOver([[ROW(1), ROW(2)]], asked);
    assert.equal((await reply.send("{{open.count}} and {{open.count}}")).outcome, "sent");
    assert.equal(asked.length, 1);
  });

  test("a figure the reader did not return is still REFUSED, and so is the very figure it did: the filter is on free text, not on what was read", async () => {
    const readers = fixtureReaders({ open: async () => ({ count: 55 }) });
    for (const text of ["56 rows are open", "55 rows are open"]) {
      const { reply, provider } = replyOver(readers);
      const refused = /** @type {any} */ (await reply.send(text));
      assert.equal(refused.outcome, "refused", text);
      assert.match(refused.problems[0].reason, /is a number outside a placeholder \(a count of ready rows is \{\{ready\.count\}\}, of open rows \{\{open\.count\}\}/, "the refusal names the road to the fact");
      assert.deepEqual(provider.sent, [], text);
    }
    const { reply, provider } = replyOver(readers);
    assert.equal((await reply.send("{{open.count}} rows are open")).outcome, "sent", "the control: the same sentence built from the placeholder");
    assert.match(provider.sent[0].text, /^55 rows are open\n/);
  });

  test("a page that is not a list refuses with that, and a failed read refuses and sends nothing", async () => {
    for (const gh of [async () => JSON.stringify({ message: "Bad credentials" }), async () => { throw new Error("HTTP 502"); }]) {
      const { reply, provider } = replyOver(createGhReaders({ gh, systemctl: async () => "", repo: "a11ign/a11ign", now: () => NOW }));
      const refused = /** @type {any} */ (await reply.send("{{open.count}} rows are open"));
      assert.equal(refused.outcome, "refused");
      assert.equal(refused.problems[0].placeholder, "{{open.count}}");
      assert.match(refused.problems[0].reason, /not a list|HTTP 502/);
      assert.deepEqual(provider.sent, []);
    }
  });

  test("`{{open.count}}` takes no id, as `{{ready.count}}` does not", () => {
    assert.match(parsePlaceholders("{{open:7.count}}").problems[0].reason, /takes no id/);
    assert.deepEqual(parsePlaceholders("{{open.count}}").problems, []);
  });
});
