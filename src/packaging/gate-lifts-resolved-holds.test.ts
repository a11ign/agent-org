// no-token: gh -- importing `work-gate.mjs` reaches `defaultRun`, and this file never lets it run: the tick is handed a fake `run` and a fake `release`, and the one test that runs `pr-hold.mjs` puts a fake `gh` first on its PATH.
/**
 * `src/wait-condition.mjs`'s `liftableHolds` and `src/work-gate/org-health.mjs`'s `liftResolvedHolds`, #3364: THE GATE LIFTS A HOLD WHOSE `Waiting-for: merged|closed` IS TRUE, instead of
 * waking a busy session to remove one label.
 *
 * THE INCIDENT (retro 2026-10-04): on 2026-10-03 `staleWaitOrders` woke a session eight times to remove one `hold:*` label from a pull request whose blocker had closed, and the
 * hold came off 6 min 32 s to 21 min 12 s later, because the setter was `working` and the order was deferred tick after tick. The positive control below is that shape: `hold:ceo`,
 * `Waiting-for: closed #3220`, #3220 closed.
 *
 * WHAT THE GATE MUST NOT DO is most of the file: an absence of a reading is never "true", an `answer:*` label's removal IS the answer, and `blocked` has no referent. Every one of
 * those is a case that must NOT lift, beside a positive control that DOES, so the negatives are not all passing because nothing ever lifts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WAIT_FIELDS, WAIT_MARKER, waitItemOf, staleWaits, liftableHolds } from "../wait-condition.mjs";
import { decide, withPrOwners, staleWaitOrders, waitTickFacts, orgHealthNow } from "../work-gate.mjs";
import { liftResolvedHolds } from "../work-gate/org-health.mjs";

const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-10-03T16:00:00Z");
const ISO = (ms: number) => new Date(ms).toISOString();

type Fact = { state: "open" | "closed" | "merged"; labels: string[]; resolvedAt: number | null; changedAt: number | null };
const resolved = (state: "closed" | "merged"): Fact => ({ state, labels: [], resolvedAt: NOW - HOUR_MS, changedAt: NOW - HOUR_MS });
const OPEN: Fact = { state: "open", labels: [], resolvedAt: null, changedAt: NOW - HOUR_MS };

const marker = (lines: string) => ({ author: { login: "a11ign-ai-workers" }, createdAt: ISO(NOW - 3 * HOUR_MS), body: `${WAIT_MARKER}\nHeld by \`ceo\`.\n${lines}` });

/** A pull request held by `labels`, declaring `waits` in its hold marker (or none). */
function heldPr(labels: string[], waits: string[], extra: Record<string, unknown> = {}) {
  return { number: 3155, labels: labels.map((name) => ({ name })), body: "", comments: waits.length ? [marker(waits.map((w) => `Waiting-for: ${w}`).join("\n"))] : [],
    updatedAt: ISO(NOW - 2 * HOUR_MS), ...extra };
}

/** What the gate would find stale for `raw`, with `facts` as the referenced items. */
function staleOf(raw: Record<string, unknown>, facts: Record<string, Fact>, kind: "pr" | "row" = "pr") {
  const item = waitItemOf(raw, kind);
  return staleWaits({ items: [item], facts: { items: facts }, now: NOW });
}

/** The gate's lift over `raw`, with a release that records who it was asked to release and answers `ok`. */
function lift(raw: Record<string, unknown>, facts: Record<string, Fact>, { kind = "pr", ok = true }: { kind?: "pr" | "row"; ok?: boolean } = {}) {
  const asked: [number, string][] = [];
  const said: string[] = [];
  const remaining = liftResolvedHolds(staleOf(raw, facts, kind), { now: NOW, release: (n: number, s: string) => { asked.push([n, s]); return ok; }, log: (l: string) => said.push(l) });
  return { asked, said, remaining };
}

// --- (1) the population: every wait field that does not clear itself has a verdict and a reason ----------------------------------

const VERDICT: Record<string, [verdict: "gate lifts" | "a session lifts", reason: string]> = {
  "hold:*": ["gate lifts", "removing the label IS the whole remedy once the declared merged/closed condition is true, and `pr-hold.mjs --release` re-arms what the hold disarmed"],
  "answer:*": ["a session lifts", "removing the label IS the answer: the session it is addressed to must give it, whatever the condition says"],
  "blocked": ["a session lifts", "`blocked` has no referent, so only a human can say what would clear it; a condition beside it does not make the gate's reading the human's"],
  "parked": ["a session lifts", "`parked` is a row's label and the gate only ever releases a pull request's hold; a true condition on a parked row is `unpark-satisfied`'s to act on, not `pr-hold.mjs`'s"],
};

test("every wait field kind that does not clear itself has a verdict and a reason, and a kind added without one is red", () => {
  const needing = WAIT_FIELDS.filter((f) => !f.selfClears).map((f) => f.kind).sort();
  assert.ok(needing.length >= 3, "the population is not empty, so the loop below runs");
  assert.deepEqual(Object.keys(VERDICT).sort(), needing, "add a verdict and a reason to VERDICT for the new kind");
  for (const kind of needing) {
    assert.ok(["gate lifts", "a session lifts"].includes(VERDICT[kind][0]), kind);
    assert.ok(VERDICT[kind][1].length > 20, `${kind} states why`);
  }
  assert.deepEqual(needing.filter((k) => VERDICT[k][0] === "gate lifts"), ["hold:*"], "exactly one kind is lifted by the gate");
});

for (const kind of Object.keys(VERDICT)) {
  test(`the verdict for \`${kind}\` is what the gate DOES on a pull request whose condition is true`, () => {
    const label = kind === "hold:*" ? "hold:ceo" : kind === "blocked" || kind === "parked" ? kind : "answer:ceo";
    const { asked, remaining } = lift(heldPr([label], ["merged #3278"]), { "#3278": resolved("merged") });
    assert.equal(asked.length > 0, VERDICT[kind][0] === "gate lifts", `${label}: ${VERDICT[kind][1]}`);
    assert.equal(remaining.length, VERDICT[kind][0] === "gate lifts" ? 0 : 1, "what the gate does not lift is still ordered to a session");
  });
}

// --- (2) the lift, and the positive control (4) ---------------------------------------------------------------------------------

test("POSITIVE CONTROL, THE INCIDENT: hold:ceo + `Waiting-for: closed #3220` with #3220 closed is released BY THE GATE, once, for the session whose label it is", () => {
  const { asked, said, remaining } = lift(heldPr(["hold:ceo"], ["closed #3220"]), { "#3220": resolved("closed") });
  assert.deepEqual(asked, [[3155, "ceo"]]);
  assert.deepEqual(remaining, [], "nothing is left to order a session");
  assert.match(said.join(""), /DID lift-hold pr-3155 \(ceo\)/);
});

test("`merged` and `closed` both lift; every holder of a multiply held pull request is released", () => {
  assert.deepEqual(lift(heldPr(["hold:ceo"], ["merged #3278"]), { "#3278": resolved("merged") }).asked, [[3155, "ceo"]]);
  const two = lift(heldPr(["hold:ceo", "hold:orchestrator"], ["closed #3220"]), { "#3220": resolved("closed") });
  assert.deepEqual(two.asked, [[3155, "ceo"], [3155, "orchestrator"]]);
  assert.deepEqual(two.remaining, []);
});

test("a release that FAILS leaves the stale wait ordered to its setter, and says nothing was lifted", () => {
  const failed = lift(heldPr(["hold:ceo"], ["closed #3220"]), { "#3220": resolved("closed") }, { ok: false });
  assert.equal(failed.remaining.length, 1);
  assert.equal(failed.remaining[0].setter, "ceo");
  assert.equal(failed.said.join(""), "", "no DID line for a lift that did not happen");
});

// --- (3) negative controls: each must NOT lift ---------------------------------------------------------------------------------

const NEGATIVES: { name: string; raw: Record<string, unknown>; facts: Record<string, Fact>; kind?: "pr" | "row" }[] = [
  { name: "no Waiting-for: line at all", raw: heldPr(["hold:ceo"], []), facts: {} },
  { name: "`Waiting-for: manual`", raw: heldPr(["hold:ceo"], ["manual"]), facts: {} },
  { name: "a referent absent from the facts (unreadable)", raw: heldPr(["hold:ceo"], ["closed #404"]), facts: { "#3220": resolved("closed") } },
  { name: "a referent still open", raw: heldPr(["hold:ceo"], ["closed #3220"]), facts: { "#3220": OPEN } },
  { name: "`merged` on a referent that closed UNMERGED", raw: heldPr(["hold:ceo"], ["merged #3220"]), facts: { "#3220": resolved("closed") } },
  { name: "a line outside the grammar", raw: heldPr(["hold:ceo"], ["soon"]), facts: {} },
  { name: "an `answer:*` label whose condition is true", raw: heldPr(["answer:ceo"], ["closed #3220"]), facts: { "#3220": resolved("closed") } },
  { name: "a `blocked` label whose condition is true", raw: heldPr(["blocked"], ["closed #3220"]), facts: { "#3220": resolved("closed") } },
  { name: "a hold beside an `answer:*` (the answer is not the gate's to give)", raw: heldPr(["hold:ceo", "answer:ceo"], ["closed #3220"]), facts: { "#3220": resolved("closed") } },
  { name: "one true wait and one still open (the hold may be waiting for that one)", raw: heldPr(["hold:ceo"], ["closed #3220", "closed #3221"]), facts: { "#3220": resolved("closed"), "#3221": OPEN } },
  { name: "a label condition, which is not a merged/closed one", raw: heldPr(["hold:ceo"], ["unlabelled needs:chairman #7"]), facts: { "#7": OPEN } },
  { name: "a ROW carrying hold:* (`pr-hold.mjs` releases pull requests)", raw: heldPr(["hold:ceo"], ["closed #3220"]), facts: { "#3220": resolved("closed") }, kind: "row" },
  { name: "a pull request of a repository the project does NOT declare (`pr-hold.mjs` refuses its key, #3479)", raw: heldPr(["hold:ceo"], ["closed #3220"], { repoKey: "other/repo" }), facts: { "#3220": resolved("closed") } },
];

for (const { name, raw, facts, kind } of NEGATIVES) {
  test(`NEGATIVE CONTROL, no lift: ${name}`, () => {
    const stale = staleOf(raw, facts, kind);
    const { asked } = lift(raw, facts, { kind });
    assert.deepEqual(asked, [], "the gate released nothing");
    assert.deepEqual(liftableHolds(stale, NOW).lifts, []);
    assert.equal(liftableHolds(stale, NOW).remaining.length, stale.length, "every stale wait there is still goes to a session, exactly as before");
  });
}

// --- the release is the hold module's, and it re-arms ---------------------------------------------------------------------------

/** A `gh` that answers `pr-hold.mjs`'s calls from a JSON file, and writes its changes back to it. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const number = args.find((a) => /^\\d+$/.test(a));
const pr = state.prs[number];
const flag = (name) => args[args.indexOf(name) + 1];
state.calls.push(args.join(" "));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
if (args[0] === "pr" && args[1] === "view") {
  const json = flag("--json");
  process.stdout.write(JSON.stringify(json === "labels" ? { labels: pr.labels.map((name) => ({ name })) } : { autoMergeRequest: pr.armed ? { enabledAt: "now" } : null, state: "OPEN" }));
} else if (args[0] === "pr" && args[1] === "edit") {
  if (args.includes("--remove-label")) pr.labels = pr.labels.filter((l) => l !== flag("--remove-label"));
  if (args.includes("--add-label")) pr.labels.push(flag("--add-label"));
} else if (args[0] === "pr" && args[1] === "merge" && args.includes("--auto")) {
  pr.armed = true;
} else if (args[0] === "pr" && args[1] === "merge" && args.includes("--disable-auto")) {
  pr.armed = false;
} else { save(); process.stderr.write("fake gh: unexpected " + args.join(" ")); process.exit(1); }
save();
`;

test("THROUGH THE HOLD MODULE'S RELEASE: a pull request that carried `rearm-on-release` is re-armed in the same act, and one that did not is left unarmed", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-lifts-"));
  const state = join(dir, "state.json");
  const previous = { PATH: process.env.PATH, FAKE_GH_STATE: process.env.FAKE_GH_STATE };
  try {
    writeFileSync(join(dir, "gh"), FAKE_GH);
    chmodSync(join(dir, "gh"), 0o755);
    writeFileSync(state, JSON.stringify({ calls: [], prs: { 3155: { labels: ["hold:ceo", "rearm-on-release"], armed: false }, 3156: { labels: ["hold:ceo"], armed: false } } }));
    process.env.PATH = `${dir}:${process.env.PATH}`;
    process.env.FAKE_GH_STATE = state;
    const stale = ["3155", "3156"].flatMap((n) => staleOf(heldPr(["hold:ceo"], ["closed #3220"], { number: Number(n) }), { "#3220": resolved("closed") }));
    assert.equal(stale.length, 2);
    const remaining = liftResolvedHolds(stale, { now: NOW, log: () => {} });
    const after = JSON.parse(readFileSync(state, "utf8"));
    assert.deepEqual(remaining, [], `both released; calls: ${after.calls.join(" | ")}`);
    assert.deepEqual(after.prs["3155"], { labels: [], armed: true }, "the PR that carried rearm-on-release is re-armed and the marker is spent");
    assert.deepEqual(after.prs["3156"], { labels: [], armed: false }, "the PR that did not is left unarmed: putting auto-merge on it would arm something nobody armed");
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (5) the next tick --------------------------------------------------------------------------------------------------------

function tick(prRaw: Record<string, unknown>, release: (n: number, s: string) => boolean) {
  const run = (args: string[]) => {
    if (!args[1].endsWith("/issues/3220")) throw new Error("refused");
    return JSON.stringify({ state: "closed", closed_at: ISO(NOW - HOUR_MS), updated_at: ISO(NOW - HOUR_MS), merged_at: null, labels: [] });
  };
  const rows = [{ number: 11, labels: [{ name: "in-progress" }, { name: "session:worker-11" }] }];
  const prs = withPrOwners([prRaw] as never, rows as never, () => null);
  const decideArgs = { prs, required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
  const decided = decide({ prs, readyRows: [], openRows: rows } as never);
  const orders = orgHealthNow({ prsRead: [prRaw], readyRead: [], openRowsRead: [], decideArgs, decided } as never,
    { now: NOW, lastMergedAt: () => NOW - HOUR_MS, log: () => {}, readCopies: (() => []) as never, readCaptures: (() => undefined) as never,
      readWaits: ((args: never) => waitTickFacts({ ...(args as Parameters<typeof waitTickFacts>[0]), run })) as never, release: release as never,
      // #3672: no remote: a project that declares `teamAccess` would otherwise make the live `gh api` read here (this file's `gh` is the fake above)
      teamAccess: () => undefined });
  return orders as { session: string; subject: string; cause: string }[];
}

test("a gate-lifted hold is no longer ordered to its setter: not this tick, and not the next, when the label is gone", () => {
  const asked: [number, string][] = [];
  const release = (n: number, s: string) => { asked.push([n, s]); return true; };
  const held = heldPr(["hold:ceo"], ["closed #3220"]);
  const first = tick(held, release);
  assert.deepEqual(asked, [[3155, "ceo"]], "the gate lifted it");
  assert.deepEqual(first.filter((o) => o.subject.startsWith("stale-wait")), [], "and no order wakes the setter to do it again");
  const second = tick({ ...held, labels: [] }, release);
  assert.equal(asked.length, 1, "the next tick finds no hold to lift");
  assert.deepEqual(second.filter((o) => o.subject.startsWith("stale-wait")), []);
  assert.deepEqual(staleOf({ ...held, labels: [] }, { "#3220": resolved("closed") }), [], "the stale-wait detector itself reads the lifted hold as nothing");
});

test("CONTROL for the tick above: when the release fails, the same tick still orders the setter, so the empty order set is the lift's doing", () => {
  const orders = tick(heldPr(["hold:ceo"], ["closed #3220"]), () => false);
  assert.deepEqual(orders.filter((o) => o.subject === "stale-wait-3155").map((o) => o.session), ["ceo"]);
  assert.equal(staleWaitOrders(staleOf(heldPr(["hold:ceo"], ["closed #3220"]), { "#3220": resolved("closed") })).length, 1);
});
