// no-token: gh -- no `gh` call is made here; `addressed` is handed an order and a model, and the flag is read from a host file this test writes (a11ign/a11ign#5113)
// #5113 (the wake half of a11ign#5111): with `workers.haikuBrief` on, a spawned Haiku seat's first order carries the stop-early and run-the-check text, and no other seat's does.
//
// POSITIVE CONTROL: the Haiku-seat, flag-on case carries the three strings. NEGATIVE CONTROL: the Sonnet-seat, flag-on case does not. Every "byte-identical" claim is an `assert.equal` of
// two orders built by the real `addressed` and the real flag reader (a temp host.json named by `$AGENT_ORG_HOST`), so a tail that fires for the wrong seat or with the flag off fails the
// test that names it. THE MUTATIONS (the PR lists them): make `haikuBriefTail` return "" -> the positive control and the fires-once tests go red; drop its `isHaiku` test -> the
// Sonnet, standing, reviewer and follow-up tests go red; drop its flag test -> the flag-off tests go red; make the reader accept any truthy value -> the "not true" test goes red.
import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { HAIKU_BRIEF_FLAG, haikuBriefEnabled, haikuBriefTail, PUBLISHED_TEXT_SHA256, QUOTE_LINE, STOP_EARLY_TEXT, VERIFY_TEXT } from "./haiku-brief.ts";
import { HOST_CONFIG_ENV, parseHostConfig } from "./host-config.ts";
import { SUPPORTED_SCHEMA } from "./project-config.ts";
import { startedPanes } from "./packaging/started-pane.ts";
import { addressed, deliver } from "./wake/fyi-queue.ts";
import { type SpawnClaimer } from "./wake/pull-request-spawn-orders.ts";
import { HAIKU_MODEL_ID, type TierProfile } from "./worker-profile.ts";
import { testEach } from "./lib/test-each.ts";

const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
const ROW = 5113;
const spawned = { row: ROW, branch: "agent/x-5113", worktree: "../wt-5113", launchDir: "/tmp/wt-5113" };
const order = { session: "worker-5113", prompt: "Build the row." };
const HOST = {
  schema: SUPPORTED_SCHEMA, home: "/home/h", binDir: "/home/h/bin", primary: "p", projects: [{ id: "p", checkout: "/home/h/p" }],
  gh: { workers: "/home/h/workers", leads: "/home/h/leads", leadsHeader: [], leadsWorkspaces: [] },
};
const PUBLISHED = [STOP_EARLY_TEXT, VERIFY_TEXT, QUOTE_LINE];

// ONE directory and one file for the whole test file, removed entry by entry in `after` (the run's private TMPDIR reports whatever a file leaves).
const DIR = mkdtempSync(join(tmpdir(), "haiku-brief-"));
const HOST_FILE = join(DIR, "host.json");
const ABSENT_FILE = join(DIR, "absent.json");
after(() => {
  unlinkSync(HOST_FILE);
  rmdirSync(DIR);
});

/** Runs `body` with `$AGENT_ORG_HOST` naming a host file that says `declaration` (a string is written as is, `undefined` is a path with no file). */
function withHost<T>(declaration: unknown, body: () => T): T {
  const previous = process.env[HOST_CONFIG_ENV];
  const path = declaration === undefined ? ABSENT_FILE : HOST_FILE;
  if (declaration !== undefined) writeFileSync(path, typeof declaration === "string" ? declaration : JSON.stringify(declaration));
  process.env[HOST_CONFIG_ENV] = path;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env[HOST_CONFIG_ENV];
    else process.env[HOST_CONFIG_ENV] = previous;
  }
}
const flagOn = { ...HOST, workers: { haikuBrief: true } };
const flagOff = { ...HOST, workers: { haikuBrief: false } };
const carriesText = (text: string) => PUBLISHED.every((paragraph) => text.includes(paragraph));
const carriesNone = (text: string) => PUBLISHED.every((paragraph) => !text.includes(paragraph)) && !text.includes("Haiku 5.5");

test("POSITIVE CONTROL: a spawned Haiku seat with the flag on carries the text, after every other tail", () => {
  const text = withHost(flagOn, () => addressed(order, "worker-5113", { spawned, model: HAIKU, engineers: [] }));
  assert.ok(carriesText(text), "the stop-early text, the verify text and the quote line are all in the first order");
  assert.ok(text.endsWith(QUOTE_LINE), "the tail is last, so a tail added by an earlier row keeps its place");
  assert.equal(text.split(STOP_EARLY_TEXT).length, 2, "said once");
});

test("the same seat with the flag off is byte-identical to today's order", () => {
  const today = addressed(order, "worker-5113", { spawned, engineers: [] });
  for (const declaration of [flagOff, HOST, undefined]) {
    assert.equal(withHost(declaration, () => addressed(order, "worker-5113", { spawned, model: HAIKU, engineers: [] })), today);
  }
  assert.ok(carriesNone(today));
});

test("NEGATIVE CONTROL: a spawned Sonnet seat with the flag on is byte-identical to today's order", () => {
  const today = addressed(order, "worker-5113", { spawned, engineers: [] });
  const text = withHost(flagOn, () => addressed(order, "worker-5113", { spawned, model: SONNET, engineers: [] }));
  assert.equal(text, today);
  assert.ok(carriesNone(text));
});

test("a spawned seat with no profile (a resume into its worktree) gets nothing", () => {
  const text = withHost(flagOn, () => addressed(order, "worker-5113", { spawned, engineers: [] }));
  assert.ok(carriesNone(text));
});

const HAIKU_SEATS = [
  { name: "a standing seat", order: { session: "orchestrator", prompt: "Read the tick." }, label: "orchestrator" },
  { name: "a reviewer", order: { session: "reviewer-5113", prompt: "Review the pull request.", cause: "draft-awaiting-verdict" }, label: "reviewer-5113" },
];

testEach("a seat on Haiku with the flag on is byte-identical to the flag off", HAIKU_SEATS, (c) => {
  const off = withHost(flagOff, () => addressed(c.order, c.label, { model: HAIKU, engineers: [] }));
  const on = withHost(flagOn, () => addressed(c.order, c.label, { model: HAIKU, engineers: [] }));
  assert.equal(on, off);
  assert.ok(carriesNone(on));
});

test("a follow-up on Haiku with the flag on is byte-identical to the flag off, and never carries the text", () => {
  const off = withHost(flagOff, () => addressed(order, "worker-5113", { followUp: true, model: HAIKU, orderId: "w1" }));
  const on = withHost(flagOn, () => addressed(order, "worker-5113", { followUp: true, model: HAIKU, orderId: "w1" }));
  assert.equal(on, off);
  assert.ok(carriesNone(on));
});

test("the flag is exactly `true`: a string, a number and a malformed file are all off, and the unreadable ones are said once", () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const read = (declaration: unknown) => withHost(declaration, () => haikuBriefEnabled({ log }));
  assert.equal(read({ ...HOST, workers: { haikuBrief: true } }), true);
  assert.equal(read({ ...HOST, workers: { haikuBrief: "true" } }), false);
  assert.equal(read({ ...HOST, workers: { haikuBrief: 1 } }), false);
  assert.equal(read({ ...HOST, workers: { haikuBrief: "true" } }), false);
  assert.equal(read("{ not json"), false);
  assert.equal(read(undefined), false, "an absent file is the ordinary case and says nothing");
  assert.equal(read({ ...HOST, workers: null }), false);
  assert.equal(lines.filter((line) => /is "true", not true or false/.test(line)).length, 1, "the string is said once although it was read twice");
  assert.equal(lines.filter((line) => /is 1, not true or false/.test(line)).length, 1);
  assert.equal(lines.filter((line) => /could not be read/.test(line)).length, 1, "the malformed file; the absent one says nothing");
  assert.equal(lines.length, 3);
});

test("the model is asked before the flag, so a Sonnet seat never reads the host file", () => {
  let reads = 0;
  assert.equal(haikuBriefTail(SONNET, { enabled: () => (reads += 1, true) }), "");
  assert.equal(haikuBriefTail(null, { enabled: () => (reads += 1, true) }), "");
  assert.equal(reads, 0);
  assert.ok(carriesText(haikuBriefTail(HAIKU, { enabled: () => true })));
});

test("a host declaration that carries `workers` still parses as a host (the flag is invisible to host-config.ts)", () => {
  const host = parseHostConfig(JSON.stringify(flagOn), "host.json");
  assert.equal(host.primary, "p");
  assert.equal("workers" in host, false);
});

test("the text is the page's: the three published strings hash to the digest read off the page", () => {
  assert.equal(createHash("sha256").update([STOP_EARLY_TEXT, VERIFY_TEXT].join("\n")).digest("hex"), PUBLISHED_TEXT_SHA256);
  assert.match(STOP_EARLY_TEXT, /^Keep working until everything the user asked for is done/);
  assert.match(VERIFY_TEXT, /^When you change code that can be run, built, or type-checked, run a real check/);
});

// ---- the call site: `deliver` -> `promptTarget` is what hands `addressed` the model the seat was STARTED on -----------------------------------------------------------------

const ROW_ORDER = {
  session: "engineers", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2131",
  prompt: "Ready row #2131 is unclaimed. Claim it with `--session=<you>`.",
};
const HAIKU_TIER: TierProfile = { kind: "claude", model: HAIKU_MODEL_ID, effort: "high", why: "test", autocompactWindow: 95_000 };

/** One tick that STARTS an engineer for the row (on `tier`, or the ordinary profile when `null`) and what herdr was told to prompt it with. */
function firstOrder(tier: TierProfile | null, declaration: unknown) {
  const calls: string[][] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    calls.push(args);
    const answered = pane(args);
    if (answered !== null) return answered;
    return args.join(" ").includes("workspace create") ? JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } }) : "{}";
  };
  const claimer: SpawnClaimer = { claim: () => ({ row: 2131, branch: "agent/x-2131", worktree: "../wt-2131", launchDir: "/tmp/wt-2131" }), release: () => "", tier: () => tier };
  const got = withHost(declaration, () => deliver([ROW_ORDER], [{ label: "ceo", status: "working" }], ["worker-capture"], { run, claimer, record: () => {}, sleep: () => {} }));
  const prompts = calls.filter((args) => args.slice(2, 4).join(" ") === "agent prompt");
  assert.equal(prompts.length, 1, `the started seat is prompted once (sent: ${JSON.stringify(got.sent)}, refused: ${JSON.stringify(got.refused)})`);
  return { sent: got.sent, text: prompts[0][5] };
}

test("deliver: a STARTED Haiku seat's first order carries the text with the flag on, and the same tick's Sonnet start does not", () => {
  const haiku = firstOrder(HAIKU_TIER, flagOn);
  assert.match(haiku.sent[0], new RegExp(`STARTED ${HAIKU_MODEL_ID}/high`), "the start really was a Haiku one");
  assert.ok(carriesText(haiku.text), "POSITIVE CONTROL: the order herdr was told to deliver carries the three strings");

  const sonnet = firstOrder(null, flagOn);
  assert.match(sonnet.sent[0], /STARTED sonnet\//);
  assert.ok(carriesNone(sonnet.text), "NEGATIVE CONTROL: the Sonnet start's order carries none of them");
  assert.equal(haiku.text, `${sonnet.text}${haikuBriefTail(HAIKU, { enabled: () => true })}`, "the Haiku order is the Sonnet order plus the tail and nothing else");
});

test("deliver: a STARTED Haiku seat's first order with the flag off is byte-identical to the start before the flag existed", () => {
  const off = firstOrder(HAIKU_TIER, flagOff);
  assert.ok(carriesNone(off.text));
  assert.equal(off.text, firstOrder(HAIKU_TIER, HOST).text, "a declaration with no `workers` block is the same order");
});
