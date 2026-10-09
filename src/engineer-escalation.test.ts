// #4630: a Haiku start that is not coping restarts on Sonnet. Pure decisions first, then the tick's seam over a fake herdr and a fake `gh`.
// EVERY CLAIM HAS ITS NEGATIVE CONTROL: the cap one count away from it, a Sonnet start beside a Haiku one, a row already escalated beside one that is not.
// DETERMINISTIC AND OFFLINE: no provider, no key, no network (`fetch` is replaced by a throw for the whole file), no corpus -- every transcript here is typed inline.
// no-token: gh -- every `gh` and `herdr` call is an injected seam; nothing imported reaches the real one
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CLAIM_RECORD_MARKER } from "./claim-labels.ts";
import { decisionLogPathFrom } from "./decision-provider.ts";
import {
  CI_FAILING_CAUSE, DEFAULT_CAPS, ESCALATE_CI_FAILURES, ESCALATE_COMPACTIONS, ESCALATE_TURNS, ESCALATION_KIND, ESCALATION_USE, claimFacts, escalationLogLine, escalationNote,
  haikuStarts, isHaiku, shouldEscalate, transcriptCounts,
} from "./engineer-escalation.ts";
import type { Routed } from "./engineer-route.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { startedPanes } from "./packaging/started-pane.ts";
import { MAX_COMPACTIONS } from "./trace/haiku-tier-report.ts";
import { claimOrdersIn, claimOrdersPath, deliver, escalatedRoutes, escalationsNow, instanceCounts, performEscalations, spawnClaimer, spawnedPrompt } from "./wake.ts";
import { HAIKU_AUTOCOMPACT_WINDOW_TOKENS, HAIKU_MODEL_ID } from "./worker-profile.ts";

const realFetch = globalThis.fetch;
let fetched = 0;
beforeEach(() => {
  fetched = 0;
  globalThis.fetch = (() => { fetched += 1; throw new Error("the escalation must not touch the network"); }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  assert.equal(fetched, 0, "nothing in the escalation reaches the network");
});

const HAIKU = HAIKU_MODEL_ID;
const SONNET = "claude-sonnet-5-5";
const none = { turns: null, compactions: null };

// --- the pure decision ------------------------------------------------------------------------------------------------------

test("the caps are the row's: two failures, the stop rule's ten compactions, and a measured turn cap -- and the compaction cap IS the report's", () => {
  assert.equal(ESCALATE_CI_FAILURES, 2);
  assert.equal(ESCALATE_COMPACTIONS, MAX_COMPACTIONS, "the stop rule's number, pinned so the two cannot drift apart");
  assert.equal(ESCALATE_TURNS, 300);
  assert.deepEqual({ ...DEFAULT_CAPS }, { ciFailures: 2, turns: 300, compactions: 10 });
});

test("a Haiku start whose pull request failed CI twice escalates; once does not", () => {
  const twice = shouldEscalate({ model: HAIKU, ciFailures: 2, ...none });
  assert.equal(twice.action, "escalate");
  assert.match(twice.action === "escalate" ? twice.reason : "", /failed CI 2 times/);
  assert.equal(shouldEscalate({ model: HAIKU, ciFailures: 1, ...none }).action, "stay", "NEGATIVE CONTROL: one red is still a Haiku row");
});

test("a Haiku start at its compaction cap escalates; one under it does not", () => {
  const verdict = shouldEscalate({ model: HAIKU, ciFailures: 0, turns: 10, compactions: ESCALATE_COMPACTIONS });
  assert.equal(verdict.action, "escalate");
  assert.match(verdict.action === "escalate" ? verdict.reason : "", /compacted 10 times/);
  assert.equal(shouldEscalate({ model: HAIKU, ciFailures: 0, turns: 10, compactions: ESCALATE_COMPACTIONS - 1 }).action, "stay");
});

test("a Haiku start at its turn cap escalates; one under it does not", () => {
  const verdict = shouldEscalate({ model: HAIKU, ciFailures: 0, turns: ESCALATE_TURNS, compactions: 0 });
  assert.equal(verdict.action, "escalate");
  assert.match(verdict.action === "escalate" ? verdict.reason : "", /used 300 turns/);
  assert.equal(shouldEscalate({ model: HAIKU, ciFailures: 0, turns: ESCALATE_TURNS - 1, compactions: 0 }).action, "stay");
});

test("a Sonnet start is NEVER escalated, however far over every cap it is", () => {
  assert.equal(shouldEscalate({ model: SONNET, ciFailures: 9, turns: 9999, compactions: 99 }).action, "stay");
  assert.equal(shouldEscalate({ model: "claude-opus-5-5", ciFailures: 9, turns: 9999, compactions: 99 }).action, "stay");
  assert.equal(shouldEscalate({ model: HAIKU, ciFailures: 9, turns: 9999, compactions: 99 }).action, "escalate", "POSITIVE CONTROL: the same counts on Haiku escalate");
});

test("a model that is not in the record is not known to be Haiku, so it stays", () => {
  const verdict = shouldEscalate({ model: null, ciFailures: 9, turns: 9999, compactions: 99 });
  assert.equal(verdict.action, "stay");
  assert.match(verdict.action === "stay" ? verdict.why : "", /not in the record/);
});

test("ONCE PER ROW: a row already escalated stays, over every cap", () => {
  assert.equal(shouldEscalate({ model: HAIKU, ciFailures: 9, turns: 9999, compactions: 99, escalated: true }).action, "stay");
  assert.equal(shouldEscalate({ model: HAIKU, ciFailures: 9, turns: 9999, compactions: 99, escalated: false }).action, "escalate");
});

test("a count that could not be read never escalates, and the ones that could still do", () => {
  assert.equal(shouldEscalate({ model: HAIKU, ciFailures: null, turns: null, compactions: null }).action, "stay");
  assert.equal(shouldEscalate({ model: HAIKU, ciFailures: null, turns: null, compactions: 10 }).action, "escalate");
});

test("the caps are arguments: a caller may name tighter ones, and the default is untouched by it", () => {
  assert.equal(shouldEscalate({ model: HAIKU, ciFailures: 1, ...none }, { ciFailures: 1, turns: 1, compactions: 1 }).action, "escalate");
  assert.equal(shouldEscalate({ model: HAIKU, ciFailures: 1, ...none }).action, "stay");
});

test("isHaiku reads the model id and the alias, and nothing else", () => {
  assert.equal(isHaiku(HAIKU), true);
  assert.equal(isHaiku("haiku"), true);
  assert.equal(isHaiku(SONNET), false);
  assert.equal(isHaiku(null), false);
});

// --- the claim-orders record ------------------------------------------------------------------------------------------------

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const arm = (session: string, row: number, model: string | null, at = 1) => line({ kind: "arm", at, session, row, ...(model === null ? {} : { model }) });
const red = (row: number, head: string, at = 2) => line({ kind: "continuation", at, claim: `row-${row}`, cause: CI_FAILING_CAUSE, continuation: 1, causeKey: `${CI_FAILING_CAUSE}/${row}/${head}` });

test("CI failures are the DISTINCT red heads since the start: a reminder of one red is not a second failure", () => {
  const text = [arm("worker-9", 9, HAIKU), red(9, "aaa"), red(9, "aaa")].join("\n");
  assert.equal(claimFacts(text, 9).ciFailures, 1);
  assert.equal(claimFacts([text, red(9, "bbb")].join("\n"), 9).ciFailures, 2, "a new head is a new failure");
});

test("a red another row was told of, or another cause, is not this row's", () => {
  const text = [arm("worker-9", 9, HAIKU), red(8, "aaa"), red(8, "bbb"), line({ kind: "continuation", at: 3, claim: "row-9", cause: "something-else", causeKey: "k" })].join("\n");
  assert.equal(claimFacts(text, 9).ciFailures, 0);
});

test("a new start is a fresh count: the reds a previous worker was told of are not the next one's", () => {
  const text = [arm("worker-9", 9, SONNET), red(9, "aaa"), red(9, "bbb"), arm("worker-9", 9, HAIKU)].join("\n");
  assert.equal(claimFacts(text, 9).ciFailures, 0);
  assert.equal(claimFacts(text, 9).model, HAIKU);
});

test("an `escalation` line is the once, and a line that is not JSON is skipped", () => {
  const text = [arm("worker-9", 9, HAIKU), "not json at all", line({ kind: ESCALATION_KIND, at: 5, row: 9, session: "worker-9", reason: "x" })].join("\n");
  assert.equal(claimFacts(text, 9).escalated, true);
  assert.equal(claimFacts(text, 10).escalated, false, "NEGATIVE CONTROL: another row is not escalated by it");
  assert.equal(claimFacts("", 9).model, null);
});

test("haikuStarts: the newest start per session, live ones only, Haiku ones only", () => {
  const text = [
    arm("worker-1", 1, HAIKU), arm("worker-2", 2, SONNET), arm("worker-3", 3, HAIKU), arm("worker-4", 4, null),
    arm("worker-5", 5, HAIKU), arm("worker-5", 6, SONNET), // a reused seat: its newest start is Sonnet
  ].join("\n");
  const live = ["worker-1", "worker-2", "worker-4", "worker-5"];
  assert.deepEqual(haikuStarts(text, live), [{ session: "worker-1", row: 1 }]);
  assert.deepEqual(haikuStarts(text, ["worker-3"]), [{ session: "worker-3", row: 3 }], "POSITIVE CONTROL: a live Haiku start is found");
});

// --- the transcript ---------------------------------------------------------------------------------------------------------

const turn = (id: string) => line({ type: "assistant", timestamp: "2026-10-09T10:00:00Z", message: { id, model: HAIKU, usage: { input_tokens: 1, cache_read_input_tokens: 10, output_tokens: 1 } } });
const compaction = () => line({ type: "user", isCompactSummary: true, message: { role: "user", content: "summary" } });
const head = (label: string) => line({ type: "user", message: { role: "user", content: `You are \`${label}\`, an org session.` } });

test("a transcript's turns and compactions are counted once each", () => {
  const text = [head("worker-9"), turn("a"), turn("a"), turn("b"), compaction(), turn("c"), compaction()].join("\n");
  assert.deepEqual(transcriptCounts(text), { turns: 3, compactions: 2 }, "a repeated message id is one turn");
});

test("a transcript with a line that is not JSON counts nothing: half a file is a lower bound, not a count", () => {
  assert.deepEqual(transcriptCounts([head("worker-9"), turn("a"), "{broken"].join("\n")), { turns: null, compactions: null });
});

test("instanceCounts reads the newest transcript that names the session and no other", () => {
  const root = tmpDir("escalation-transcripts-");
  const project = join(root, "-home-agent-repos-wt-9");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "mine.jsonl"), [head("worker-9"), turn("a"), turn("b"), compaction()].join("\n"));
  writeFileSync(join(project, "other.jsonl"), [head("worker-8"), turn("x"), turn("y"), turn("z")].join("\n"));
  assert.deepEqual(instanceCounts("worker-9", root), { turns: 2, compactions: 1 });
  assert.equal(instanceCounts("worker-7", root), null, "no transcript names it: cannot tell, and cannot tell is not zero");
});

// --- the words --------------------------------------------------------------------------------------------------------------

test("the brief says why, that nothing was released, that the label stays, and that it is not escalated again", () => {
  const note = escalationNote({ session: "worker-9", reason: "its pull request has failed CI 2 times (the cap is 2)" });
  assert.match(note, /RESTART ON SONNET/);
  assert.match(note, /`worker-9` started this row on Haiku and its pull request has failed CI 2 times/);
  assert.match(note, /unchanged and nothing was released/);
  assert.match(note, /keeps its `tier:haiku` label/);
  assert.match(note, /not escalated again/);
});

test("the decision-log line is `model-escalation`, via none, and never a fall-back", () => {
  assert.deepEqual(escalationLogLine({ row: 9, reason: "r", at: 7 }), { use: "model-escalation", id: "row-9", via: "none", fellBack: false, outcome: "escalate", reason: "r", at: 7 });
  assert.equal(ESCALATION_USE, "model-escalation");
});

// --- the tick's seam --------------------------------------------------------------------------------------------------------

const ROW = 4999;
const SESSION = `worker-${ROW}`;
const WORKTREE = `/h/repos/wt-${ROW}`;
const BRANCH = `agent/a-haiku-start-${ROW}`;

/** A host: herdr (recording), `gh` (a row with a claim record) and the ledger's directory. `closeFails` and `unreadable` break one half each. */
function rig(opts: { records?: string[]; closeFails?: boolean; unreadable?: boolean; createFails?: boolean; neverReady?: boolean; counts?: { turns: number | null; compactions: number | null } | null; live?: string[] } = {}) {
  const dir = tmpDir("escalation-tick-");
  const ledgerPath = join(dir, "state", "wake-ledger");
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(claimOrdersPath(ledgerPath), `${(opts.records ?? [arm(SESSION, ROW, HAIKU), red(ROW, "aaa"), red(ROW, "bbb")]).join("\n")}\n`);
  const herdr: string[][] = [];
  const posted: string[][] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    herdr.push(args);
    const verb = args.slice(2, 4).join(" ");
    if (verb === "workspace list") return JSON.stringify({ result: { workspaces: [{ label: SESSION, workspace_id: "wOLD" }] } });
    if (verb === "workspace close" && opts.closeFails) throw new Error("herdr: close refused");
    if (verb === "workspace create") {
      if (opts.createFails) throw new Error("herdr: create refused");
      return JSON.stringify({ result: { root_pane: { pane_id: "wNEW:p1" }, workspace: { workspace_id: "wNEW" } } });
    }
    if (opts.neverReady && verb === "agent get") return JSON.stringify({ result: { agent: { agent_status: "idle", interactive_ready: false } } });
    return pane(args) ?? "{}";
  };
  const gh = (args: string[]) => {
    if (opts.unreadable) throw new Error("gh: HTTP 502");
    return JSON.stringify({ title: "A Haiku start that fails CI twice restarts on Sonnet", comments: [
      { body: `${CLAIM_RECORD_MARKER}\n**Claim record** -- claimed by \`${SESSION}\`.\nClaimed-branch: ${BRANCH}\nClaimed-worktree: ${WORKTREE}\n`, createdAt: "2026-10-09T09:00:00Z", author: { login: "a11ign-ai-workers" } },
    ] });
  };
  const deps = { run, gh, post: (args: string[]) => { posted.push(args); return ""; }, ledgerPath, worktreesDir: "/h/repos", env: { GH_CONFIG_DIR: "/h/w" },
    now: () => 1_700_000_000_000, sleep: () => {}, warn: () => {}, counts: () => (opts.counts === undefined ? { turns: 10, compactions: 0 } : opts.counts) };
  const verbs = () => herdr.map((a) => a.slice(2, 4).join(" "));
  const decisionLog = () => {
    const path = decisionLogPathFrom(ledgerPath);
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const record = () => readFileSync(claimOrdersPath(ledgerPath), "utf8");
  return { deps, herdr, posted, verbs, decisionLog, record, ledgerPath, live: opts.live ?? [SESSION] };
}

test("SEAM: a Haiku worker whose pull request failed CI twice is ended, restarted on Sonnet in its own worktree, and told why", () => {
  const h = rig();
  const got = performEscalations(h.live, h.deps);

  assert.equal(got.lines.length, 1, got.lines.join("\n"));
  assert.match(got.lines[0], /^ESCALATED #4999: `worker-4999` started #4999 on Haiku and its pull request has failed CI 2 times/);
  assert.deepEqual(got.busied, [SESSION], "it is working now, so no order of this tick is routed to it");

  assert.ok(h.verbs().indexOf("workspace close") >= 0 && h.verbs().indexOf("workspace create") > h.verbs().indexOf("workspace close"), `the old pane goes before the new one opens: ${h.verbs().join(" | ")}`);
  const close = h.herdr.find((a) => a.slice(2, 4).join(" ") === "workspace close");
  assert.equal(close?.at(-1), "wOLD");
  const create = h.herdr.find((a) => a.slice(2, 4).join(" ") === "workspace create")?.join(" ") ?? "";
  assert.match(create, new RegExp(`--label ${SESSION}( |$)`), "the same address");
  assert.match(create, new RegExp(`--cwd ${WORKTREE}( |$)`), "the same worktree: nothing is re-claimed, so nothing is re-created");
  const start = h.herdr.find((a) => a.slice(2, 4).join(" ") === "agent start")?.join(" ") ?? "";
  assert.match(start, /sonnet/i, `started on Sonnet: ${start}`);
  assert.doesNotMatch(start, /haiku/i);
  assert.match(start, /high/, "at high effort");

  const prompt = h.herdr.find((a) => a.slice(2, 4).join(" ") === "agent prompt");
  assert.equal(prompt?.[4], SESSION);
  assert.match(String(prompt?.[5]), /RESTART ON SONNET/);
  assert.match(String(prompt?.[5]), new RegExp(`worktree \`${WORKTREE}\` on branch \`${BRANCH}\``));
});

test("SEAM: the claim is neither released nor re-won -- no `row-claim`, no label edit, no `decline`", () => {
  const h = rig();
  performEscalations(h.live, h.deps);
  const everything = JSON.stringify([...h.herdr, ...h.posted]);
  assert.doesNotMatch(everything, /row-claim|decline|--remove-label|--add-label/);
  assert.deepEqual(h.posted.map((a) => a.slice(0, 2)), [["issue", "comment"]], "one thing was written to the row: a comment");
});

test("SEAM: the escalation is a decision-log line (`model-escalation`, `via: none`) and a row comment, not an order", () => {
  const h = rig();
  performEscalations(h.live, h.deps);
  const logged = h.decisionLog();
  assert.equal(logged.length, 1);
  assert.deepEqual({ use: logged[0].use, id: logged[0].id, via: logged[0].via, outcome: logged[0].outcome }, { use: "model-escalation", id: `row-${ROW}`, via: "none", outcome: "escalate" });
  const comment = h.posted[0];
  assert.deepEqual(comment.slice(0, 3), ["issue", "comment", String(ROW)]);
  assert.match(comment.at(-1) ?? "", /restarted on Sonnet\/high/);
  assert.match(comment.at(-1) ?? "", /via: none/);
  assert.equal(claimFacts(h.record(), ROW).escalated, true, "and the record holds the once");
});

test("SEAM: ONCE PER ROW -- the next tick finds the escalation in the record and does nothing", () => {
  const h = rig();
  performEscalations(h.live, h.deps);
  const before = h.herdr.length;
  const again = performEscalations(h.live, h.deps);
  assert.deepEqual(again, { lines: [], busied: [] });
  assert.equal(h.herdr.length, before, "no herdr call the second time");
  assert.equal(h.decisionLog().length, 1);
});

test("SEAM: a Sonnet start over every cap is left alone -- no call, no line, no record", () => {
  const h = rig({ records: [arm(SESSION, ROW, SONNET), red(ROW, "a"), red(ROW, "b"), red(ROW, "c")], counts: { turns: 9999, compactions: 99 } });
  const got = performEscalations(h.live, h.deps);
  assert.deepEqual(got, { lines: [], busied: [] });
  assert.equal(h.herdr.length, 0);
  assert.equal(h.posted.length, 0);
  assert.deepEqual(h.decisionLog(), []);
});

test("SEAM: a Haiku worker under every cap is left alone", () => {
  const h = rig({ records: [arm(SESSION, ROW, HAIKU), red(ROW, "a")] });
  assert.deepEqual(performEscalations(h.live, h.deps), { lines: [], busied: [] });
  assert.equal(h.herdr.length, 0);
});

test("SEAM: the turn cap and the compaction cap each restart a worker with no red at all", () => {
  for (const counts of [{ turns: ESCALATE_TURNS, compactions: 0 }, { turns: 5, compactions: ESCALATE_COMPACTIONS }]) {
    const h = rig({ records: [arm(SESSION, ROW, HAIKU)], counts });
    assert.match(performEscalations(h.live, h.deps).lines[0], /^ESCALATED #4999/);
  }
});

test("SEAM: a worker that is not live is not escalated, whatever its record says", () => {
  const h = rig({ live: ["worker-1"] });
  assert.deepEqual(performEscalations(h.live, h.deps), { lines: [], busied: [] });
});

test("SEAM: a pane that will not close writes NOTHING, so the escalation is still unspent next tick", () => {
  const h = rig({ closeFails: true });
  const got = performEscalations(h.live, h.deps);
  assert.match(got.lines[0], /^NOT ESCALATED #4999/);
  assert.deepEqual(got.busied, []);
  assert.equal(claimFacts(h.record(), ROW).escalated, false);
  assert.deepEqual(h.decisionLog(), []);
  assert.equal(h.posted.length, 0);
  assert.equal(h.verbs().includes("workspace create"), false, "no second process beside the first");
});

test("SEAM: a restart the host refuses AFTER the old pane closed leaves the escalation recorded, so the next start of the row is Sonnet", () => {
  const h = rig({ createFails: true });
  const got = performEscalations(h.live, h.deps);
  assert.match(got.lines[0], /^ESCALATED #4999: .*NOT RESTARTED/);
  assert.deepEqual(got.busied, [], "nothing is running under the label, so it is not marked working");
  assert.equal(claimFacts(h.record(), ROW).escalated, true);
  assert.equal(escalatedRoutes(h.record(), new Map()).get(ROW)?.profile, null, "and the gate's respawn reads the ordinary profile, never the label's Haiku");
});

test("SEAM: a new pane that never becomes ready is closed and the CLAIM IS STILL NOT RELEASED (the abandon path's release is a no-op)", () => {
  const h = rig({ neverReady: true });
  const got = performEscalations(h.live, h.deps);
  assert.match(got.lines[0], /^ESCALATED #4999: .*NOT PROMPTED -- .*interactive-ready/);
  const closes = h.herdr.filter((a) => a.slice(2, 4).join(" ") === "workspace close").map((a) => a.at(-1));
  assert.deepEqual(closes, ["wOLD", "wNEW"], "the Haiku pane, then the replacement that could not be used");
  assert.doesNotMatch(JSON.stringify([...h.herdr, ...h.posted]), /row-claim|decline/);
  assert.equal(claimFacts(h.record(), ROW).escalated, true, "and the gate's respawn will be Sonnet");
});

test("SEAM: a claim record that cannot be read still records the escalation and says the gate restarts it", () => {
  const h = rig({ unreadable: true });
  const got = performEscalations(h.live, h.deps);
  assert.match(got.lines[0], /NOT RESTARTED -- the claim record is unreadable/);
  assert.equal(claimFacts(h.record(), ROW).escalated, true);
  assert.equal(h.verbs().includes("workspace create"), false);
});

test("SEAM: no transcript to read is a count that was not read, and it escalates nothing", () => {
  const h = rig({ records: [arm(SESSION, ROW, HAIKU)], counts: null });
  assert.deepEqual(performEscalations(h.live, h.deps), { lines: [], busied: [] });
});

test("escalationsNow is pure: the same record and reads give the same answer, and it names the reason", () => {
  const record = [arm(SESSION, ROW, HAIKU), red(ROW, "a"), red(ROW, "b")].join("\n");
  const first = escalationsNow(record, [SESSION], () => null);
  assert.deepEqual(first, escalationsNow(record, [SESSION], () => null));
  assert.equal(first.length, 1);
  assert.match(first[0].reason, /failed CI 2 times/);
});

// --- a later start of an escalated row ---------------------------------------------------------------------------------------

test("an escalated row's later start is the ordinary profile although its label still says tier:haiku; an unescalated one is still Haiku", () => {
  const dir = tmpDir("escalation-route-");
  const switchPath = join(dir, "haiku-tier.json");
  writeFileSync(switchPath, '{ "enabled": true }');
  const body = "## Region\n\n```\nsrc/a.ts\nsrc/a.test.ts\n```\n\n## Acceptance\n\n```bash\npnpm test\n```\n\n## Done-when\n\n1. The Acceptance passes.\n";
  const record = line({ kind: ESCALATION_KIND, at: 1, row: ROW, session: SESSION, reason: "r" });
  const claimed = { row: ROW, branch: "b", worktree: "/w", launchDir: "/l" };
  const exec = () => ({ status: 0, output: "" });
  const tierOf = (routes: ReadonlyMap<number, Routed>) => spawnClaimer({ exec, exists: () => true, switchPath, routes, readRow: () => ({ labels: ["tier:haiku", "ready"], body, title: "t" }) }).tier?.(claimed);

  const unlayered = tierOf(new Map());
  assert.ok(unlayered !== null && unlayered !== undefined && isHaiku(unlayered.model), "NEGATIVE CONTROL: without the escalation line the label's Haiku profile is what the row gets");
  assert.equal(tierOf(escalatedRoutes(record, new Map())), null, "escalated: ordinary Sonnet/high");
  assert.equal(escalatedRoutes(record, new Map()).has(ROW + 1), false, "another row is not rerouted");
  assert.equal(escalatedRoutes("", new Map()).size, 0);
});

test("a restarted worker's brief is spawnedPrompt plus the note, and an ordinary spawn's brief has no note", () => {
  const base = { row: ROW, branch: BRANCH, worktree: WORKTREE, launchDir: "/l" };
  const plain = spawnedPrompt({ title: "t" }, base);
  const restarted = spawnedPrompt({ title: "t" }, { ...base, restart: { from: SESSION, reason: "it has compacted 10 times (the cap is 10)" } });
  assert.doesNotMatch(plain, /RESTART ON SONNET/);
  assert.ok(restarted.startsWith(plain), "the restart's brief is the ordinary brief with the note after it");
  assert.match(restarted, /compacted 10 times/);
});

// --- the start writes the model the escalation later reads -------------------------------------------------------------------

test("through deliver: a Haiku start's arm line carries the model, and haikuStarts reads the live worker from it", () => {
  const dir = tmpDir("escalation-arm-");
  const path = join(dir, "claim-orders");
  const pane = startedPanes();
  const run = (args: string[]) => {
    if (args.slice(2, 4).join(" ") === "workspace create") return JSON.stringify({ result: { root_pane: { pane_id: "w:p1" }, workspace: { workspace_id: "w" } } });
    return pane(args) ?? "{}";
  };
  const haiku = { kind: "claude" as const, model: HAIKU_MODEL_ID, effort: "high", why: "tier:haiku", autocompactWindow: HAIKU_AUTOCOMPACT_WINDOW_TOKENS };
  const claimer = { claim: () => ({ row: ROW, branch: BRANCH, worktree: WORKTREE, launchDir: "/l" }), release: () => "", tier: () => haiku };
  const order = { session: "engineers", cause: "ready-row-unclaimed", causeKey: `engineers/ready-row-unclaimed/${ROW}`, title: "t", prompt: "p" };
  const got = deliver([order], [], [SESSION], { run, claimer, claimOrders: claimOrdersIn(path), now: () => 5, sleep: () => {}, contextRoot: join(dir, "none"), record: () => {} });

  assert.deepEqual(got.refused, []);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].model, HAIKU_MODEL_ID);
  assert.deepEqual(haikuStarts(readFileSync(path, "utf8"), [SESSION]), [{ session: SESSION, row: ROW }], "POSITIVE CONTROL: the live Haiku start is a candidate");
  assert.deepEqual(haikuStarts(readFileSync(path, "utf8"), []), [], "NEGATIVE CONTROL: one that is not live is not");
});
