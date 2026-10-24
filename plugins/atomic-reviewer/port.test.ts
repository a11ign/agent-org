// no-token: none -- herdr, git and the clock are all injected; nothing is spawned
//
// THE ATOMIC REVIEWER'S PORT, as it was tested when it lived in `src/ticket-mode/reviewer-port.ts` (A11-161): the same tests, over the same fakes (herdr, `gh`, the code host), with the gate's own
// modules loaded for real, since the gate stays core's and reaches the port through `deps.reviewing`. `atomicReviewerPort` below makes the port the way the board does, from the helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../src/lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../../src/plugins/fakes/code-host.ts";
import type { CodeHost } from "../../src/plugins/contracts/code-host.ts";
import type { ReviewerPort, ReviewerRef } from "../../src/plugins/contracts/reviewer.ts";
import { reviewingHelpers } from "../../src/plugins/reviewing-helpers.ts";
import { INSIDE, type DoorRun } from "../../src/review-trust.ts";
import { REPO } from "../../src/project-identity.ts";
import { loadReviewerGate } from "../../src/ticket-mode/reviewer-port.ts";
import { homeProjectDeclaration } from "../../src/project-config.ts";
import { HOST_CONFIG_ENV, hostConfigPath } from "../../src/host-config.ts";
import { DECISION_RULE, NO_TICKET_LINE, POST_MERGE_RULE, RATCHET_RULE, unrequiredRedWords } from "./prompt.ts";
import { REVIEW_CAUSE, atomicReviewerPort as portOver, clonedSeatOf, type Seams, verdictFileIn as verdictFileOver } from "./port.ts";

const PR_URL = `https://github.com/${REPO}/pull/7`;
const at = (ms: number) => new Date(ms).toISOString();

/** What a test names of the board and the port's seams, as `atomicReviewerPort` took them before the plugin: `heads`, `clones` and `instance` are the board's. */
type PortOptions = Seams & Readonly<{ session: string; run: (args: string[]) => string; codeHost: CodeHost; heads?: Map<string, string>; clones?: Record<string, string>; instance: string }>;

/** The port the board makes: over the real helpers of core, with the board's collaborators these options name. */
function atomicReviewerPort({ session, run, codeHost, heads = new Map<string, string>(), clones = {}, instance, ...seams }: PortOptions): ReviewerPort {
  return portOver(reviewingHelpers({ session, run, codeHost: () => codeHost, clones, instance, heads }), seams);
}

/** The verdict file of a checkout, found as the port finds it: with the verdict reader the board hands it. */
const verdictFileIn = (tree: string, number: number, head: string): string | null => verdictFileOver(tree, number, head,
  reviewingHelpers({ session: "tickets", run: () => "", codeHost: () => createFakeCodeHost(), clones: {}, instance: "work", heads: new Map() }).board().verdict);

const review = (login: string, state: string, commit: string, ms: number) => ({ author: { login }, state, commit: { oid: commit }, submittedAt: at(ms) });

/** A herdr that opens workspaces and starts agents, and lists each label in `status` as a workspace. */
function herdr(status: Map<string, string>) {
  const calls: string[][] = [];
  let next = 0;
  const run = (args: string[]) => {
    calls.push(args);
    if (args.includes("create")) {
      next += 1;
      return JSON.stringify({ result: { root_pane: { pane_id: `w${next}:p1` }, workspace: { workspace_id: `w${next}` } } });
    }
    if (args.includes("agent") && args.includes("list")) return JSON.stringify({ result: { agents: [...status].map(([label]) => ({ name: null, workspace_id: `w${label.replace(/\D/g, "")}`, agent_session: { value: `session-${label}` } })) } });
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: [...status].map(([label, s]) => ({ label, workspace_id: `w${label.replace(/\D/g, "")}`, agent_status: s })) } });
    return JSON.stringify({ type: "ok" });
  };
  return { run, calls };
}

const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }];

/** A commit status as GitHub keeps it on a head: its id, its context, when it was written, and its description. */
type Status = { id: number; context: string; created_at: string; description: string };

/** The claim entries among a pull request's head statuses, in the order they were written. */
const claimEntriesOf = (pr: { statuses?: Status[] }) =>
  (pr.statuses ??= []).filter((status) => status.context === "agent-org/review").map((status) => ({ id: status.id, description: status.description, created: Date.parse(status.created_at) }));

/**
 * GitHub as the reviewer's tests see it: the pull request `pr` describes, held by the code host (the fake) for every read of a pull request, and its head's commit statuses, which its claim
 * operations read and write (a write adds one written now, so a claim written through one port is read back through another). `head` is its commit, `reviews` its reviews as GitHub lists them, `outside` whether its author is outside the org, `checks` its checks (green by default), `state` its
 * state (open by default), `statuses` its head's commit statuses. A test moves the pull request by changing `pr`: each read holds it as it is then.
 */
function ghFor(pr: { head: string; reviews?: unknown[]; outside?: boolean; checks?: unknown[]; state?: string; statuses?: Status[]; unrequiredRed?: string[] }) {
  const host = createFakeCodeHost("worker-bot");
  type Reviewed = { author: { login: string }; state: string; commit: { oid: string }; submittedAt: string };
  const hold = (url: string): void => {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    if (match === null) return;
    const checks = (pr.checks ?? GREEN) as { conclusion: string | null }[];
    host.seedPull(match[1], Number(match[2]), {
      head: pr.head, state: (pr.state ?? "OPEN").toLowerCase() as "open" | "merged" | "closed", trust: pr.outside === true ? "outside" : "inside", settled: checks.every(({ conclusion }) => conclusion === "SUCCESS"), ...(pr.unrequiredRed === undefined ? {} : { unrequiredRed: pr.unrequiredRed }),
      reviews: ((pr.reviews ?? []) as Reviewed[]).map((r) => ({ author: r.author.login, state: r.state, commit: r.commit.oid, at: Date.parse(r.submittedAt) })),
    });
  };
  const codeHost: CodeHost = {
    ...host,
    readPullFeedback: (url, self, alsoIgnore) => { hold(url); return host.readPullFeedback(url, self, alsoIgnore); },
    readReviewState: (url) => { hold(url); return host.readReviewState(url); },
    readPullState: (url) => { hold(url); return host.readPullState(url); },
    readReviewClaims: () => ({ entries: claimEntriesOf(pr) }),
    writeReviewClaim: ({ description }) => {
      const statuses = pr.statuses ??= [];
      statuses.push({ id: statuses.length + 1, context: "agent-org/review", created_at: new Date().toISOString(), description });
      return null;
    },
  };
  return { pr, codeHost };
}

/** The code host a port is given, which also keeps its claims, so a claim written through one port is read back through another, and no test reaches GitHub. */
const claiming = (fake: ReturnType<typeof ghFor>) => ({ codeHost: fake.codeHost, mint: () => null });

test("the atomic reviewer refuses a pull request whose author is outside the org, and starts nothing", async () => {
  await loadReviewerGate();
  const herd = herdr(new Map());
  const spawned: unknown[] = [];
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: herd.run, ...claiming(ghFor({ head: "h1", outside: true })),
    spawn: (order) => { spawned.push(order); return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }; },
    checkout: () => ({ path: "/work/pr-7", head: "h1" }) });
  const started = port.start({ pr: PR_URL, head: "h1" });
  assert.match("refusal" in started ? started.refusal : "", /outside the org/);
  assert.deepEqual(spawned, []);
  assert.equal(herd.calls.some((args) => args.includes("prompt")), false, "no prompt is sent");
});

test("the atomic reviewer starts the gate's reviewer in the tickets' session for an org pull request, and is live for its head only", async () => {
  await loadReviewerGate();
  const listed = new Map<string, string>();
  const herd = herdr(listed);
  const spawned: { order: unknown; cwd: unknown }[] = [];
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: herd.run, ...claiming(ghFor({ head: "h1" })),
    spawn: (order, _agents, options) => { spawned.push({ order, cwd: options.cwd }); return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }; },
    checkout: () => ({ path: "/work/pr-7", head: "h1" }) });
  assert.deepEqual(port.start({ pr: PR_URL, head: "h1" }), { label: "reviewer-7" });
  assert.deepEqual(spawned, [{ order: { session: "reviewer-7", cause: REVIEW_CAUSE, causeKey: `${PR_URL}@h1`, trust: INSIDE }, cwd: "/work/pr-7" }]);
  const prompt = herd.calls.find((args) => args.includes("prompt"))!;
  assert.deepEqual(prompt.slice(0, 5), ["--session", "tickets", "agent", "prompt", "reviewer-7"]);
  assert.equal(port.live({ pr: PR_URL, head: "h1" }), false, "not live until herdr lists its workspace");
  listed.set("reviewer-7", "working");
  assert.equal(port.live({ pr: PR_URL, head: "h1" }), true, "live for the head it was started for");
  assert.equal(port.live({ pr: PR_URL, head: "h2" }), false, "not live for a head it was not started for");
});

test("the reviewer is asked the gate's own verdict prompt for the pull request and its head, which names the reviewer role file", async () => {
  await loadReviewerGate();
  const herd = herdr(new Map());
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: herd.run, ...claiming(ghFor({ head: "h1" })),
    spawn: (order) => ({ label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }),
    checkout: () => ({ path: "/work/pr-7", head: "h1" }) });
  assert.deepEqual(port.start({ pr: PR_URL, head: "h1" }), { label: "reviewer-7" });
  const prompt = herd.calls.find((args) => args.includes("prompt"))!;
  const GATE_WORDS = "Ready (not a draft) #7 at `h1` has settled green checks and no verdict at that head. Review it per .agent-org/roles/reviewer.md and post the verdict as it says.";
  assert.equal(prompt[prompt.length - 1], `${GATE_WORDS}\n\n${NO_TICKET_LINE}\n\n${POST_MERGE_RULE}`, "the gate's own words, then (A11-156) what a start with no brief tells the reviewer");
});

/** A port over a green, ready pull request whose head carries `statuses`, and the herdr it prompts: the reviewer's start, as the re-review tests drive it. */
function startingPort({ reviews = [] as unknown[], statuses = [] as Status[], unrequiredRed }: { reviews?: unknown[]; statuses?: Status[]; unrequiredRed?: string[] } = {}) {
  const herd = herdr(new Map());
  const fake = ghFor({ head: "h1", reviews, statuses, ...(unrequiredRed === undefined ? {} : { unrequiredRed }) });
  const spawned: unknown[] = [];
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: herd.run, ...claiming(fake),
    spawn: (order) => { spawned.push(order); return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }; },
    checkout: () => ({ path: "/work/pr-7", head: "h1" }) });
  const prompted = (): string => herd.calls.filter((args) => args.includes("prompt")).map((args) => args[args.length - 1]).at(-1) ?? "";
  return { port, spawned, statuses: fake.pr.statuses ?? [], prompted };
}
const DONE_WHEN = "## Done-when\n\n### Before merge\n\n- the test\n\n### After merge (who runs it)\n\n- the chairman, after 0.9.0";
const BLOCK_STATUS = (): Status => ({ id: 2, context: "agent-org/review", created_at: at(Date.now() - 30 * 60_000), description: `not-convinced by work at ${at(Date.now() - 30 * 60_000)}` });
const FIRST_CLAIM = (): Status => ({ id: 1, context: "agent-org/review", created_at: at(Date.now() - 40 * 60_000), description: `claimed by work at ${at(Date.now() - 40 * 60_000)}, lease 60 min` });
const REPLY = { author: "worker-bot", url: `${PR_URL}#issuecomment-9`, text: "Not a defect in this diff: the live run is after the release." };

test("A11-156: a first review's prompt carries the ticket's Done-when and the post-merge rule after the gate's own words, and the reprompt does too", async () => {
  await loadReviewerGate();
  const { port, prompted } = startingPort();
  assert.deepEqual(port.start({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN }), { label: "reviewer-7" });
  const first = prompted();
  assert.ok(first.startsWith("Ready (not a draft) #7 at `h1`"), "the gate's words come first");
  assert.ok(first.includes(`The ticket's Done-when, as the ticket states it:\n\n${DONE_WHEN}`) && first.endsWith(POST_MERGE_RULE));
  assert.deepEqual(port.reprompt({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN }), { prompted: true });
  assert.equal(prompted(), first, "the reprompt says what the first prompt did");
  assert.deepEqual(port.reprompt({ pr: PR_URL, head: "h1" }), { prompted: true });
  assert.ok(prompted().includes(NO_TICKET_LINE) && prompted().endsWith(POST_MERGE_RULE), "and with no brief it still carries the rule");
});

test("A11-156: a head whose review is posted is refused a start, but not a re-review: it claims the head again after the verdict, starts the same reviewer, and sends the re-review brief", async () => {
  await loadReviewerGate();
  const block = review("a11ign-reviewer", "CHANGES_REQUESTED", "h1", Date.now() - 30 * 60_000);
  const { port, spawned, statuses, prompted } = startingPort({ reviews: [block], statuses: [FIRST_CLAIM(), BLOCK_STATUS()] });
  const refused = port.start({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN });
  assert.match("refusal" in refused ? refused.refusal : "", /its review at h1 is already posted/, "the first review's claim ended in the verdict");
  assert.deepEqual(spawned, []);
  assert.deepEqual(port.start({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN, rereview: { replies: [REPLY] } }), { label: "reviewer-7" });
  assert.equal(spawned.length, 1);
  assert.match(statuses.at(-1)?.description ?? "", /^claimed by work at /, "a claim is written after the verdict");
  const words = prompted();
  assert.ok(words.startsWith("This is a re-review of #7"), words);
  assert.ok(words.includes(`- worker-bot (${PR_URL}#issuecomment-9):\n  ${REPLY.text}`) && words.includes(DONE_WHEN) && words.includes(POST_MERGE_RULE));
  assert.ok(words.includes("Review it per .agent-org/roles/reviewer.md") && words.includes("Corrects review: Review of #7 at `h1`"), "and names the standing block the approval corrects, and the role file");
  assert.ok(!words.includes("no verdict at that head"), "the gate's first-review sentence is not sent");
});

test("A11-156: a re-review another instance already holds is refused, and an approved head is refused a re-review", async () => {
  await loadReviewerGate();
  const otherClaim: Status = { id: 3, context: "agent-org/review", created_at: at(Date.now() - 5 * 60_000), description: `claimed by laptop at ${at(Date.now() - 5 * 60_000)}, lease 60 min` };
  const held = startingPort({ statuses: [FIRST_CLAIM(), BLOCK_STATUS(), otherClaim] });
  const heldAnswer = held.port.start({ pr: PR_URL, head: "h1" }, { doneWhen: null, rereview: { replies: [REPLY] } });
  assert.match("refusal" in heldAnswer ? heldAnswer.refusal : "", /another instance \(`laptop`\) holds the review/);
  const approved: Status = { id: 4, context: "agent-org/review", created_at: at(Date.now() - 60_000), description: `convinced by work at ${at(Date.now() - 60_000)}` };
  const done = startingPort({ statuses: [FIRST_CLAIM(), BLOCK_STATUS(), approved] });
  const doneAnswer = done.port.start({ pr: PR_URL, head: "h1" }, { doneWhen: null, rereview: { replies: [REPLY] } });
  assert.match("refusal" in doneAnswer ? doneAnswer.refusal : "", /its review at h1 is already posted \(convinced by work/);
  assert.deepEqual([held.spawned, done.spawned], [[], []]);
});

test("the atomic reviewer starts nothing for a head whose checks have not settled green", async () => {
  await loadReviewerGate();
  const herd = herdr(new Map());
  const spawned: unknown[] = [];
  const checks = [{ name: "gate", status: "IN_PROGRESS", conclusion: null }];
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: herd.run, ...claiming(ghFor({ head: "h1", checks })),
    spawn: (order) => { spawned.push(order); return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }; },
    checkout: () => ({ path: "/work/pr-7", head: "h1" }) });
  const started = port.start({ pr: PR_URL, head: "h1" });
  assert.match("refusal" in started ? started.refusal : "", /have not settled green/);
  assert.deepEqual(spawned, []);
});

test("a port given the heads a pool remembers is live for the head its reviewer was started for, across a restart", async () => {
  await loadReviewerGate();
  const herd = herdr(new Map([["reviewer-7", "working"]]));
  const heads = new Map([["reviewer-7", "h1"]]);
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: herd.run, ...claiming(ghFor({ head: "h1" })), heads });
  assert.equal(port.live({ pr: PR_URL, head: "h1" }), true, "live for the remembered head");
  assert.equal(port.live({ pr: PR_URL, head: "h2" }), false, "not live for a head it was not started for");
});

/**
 * A port over a herdr that lists `status`, for the close and the teardown. Its checkout's uncommitted paths are `paths`, or the read fails, and its
 * removal answers `removal`; nothing is removed and no git runs. `events` names each close, each git read and each removal, in the order they happen.
 */
function teardownPort(status: Map<string, string>, { paths = [] as string[], pathsFail = false, removal = null as string | null } = {}) {
  const herd = herdr(status);
  const events: string[] = [];
  const removed: { pr: number; session: string; key: string }[] = [];
  const heads = new Map([["reviewer-7", "h1"]]);
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: (args) => { if (args.includes("close")) events.push("close"); return herd.run(args); },
    ...claiming(ghFor({ head: "h1" })), heads, exists: () => true,
    uncommittedPaths: () => { events.push("read"); if (pathsFail) throw new Error("fatal: not a git repository"); return paths; },
    removeCheckout: ({ pr, session, key }) => { events.push("removed"); removed.push({ pr, session: String(session), key: String(key) }); return removal; } });
  return { port, herd, events, removed, heads };
}


test("a reviewer is closed once its verdict is posted: its workspace closes, and its checkout is kept", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]));
  assert.deepEqual(made.port.close({ pr: PR_URL, head: "h1" }), { state: "closed" });
  assert.deepEqual(made.herd.calls.filter((args) => args.includes("close")), [["--session", "tickets", "workspace", "close", "w7"]]);
  assert.deepEqual(made.removed, [], "the checkout is kept for the next reviewer of the seat");
  assert.equal(made.heads.get("reviewer-7"), "h1", "the head it was started for is still remembered");
});

test("close waits for a reviewer still working: nothing closes, and it answers busy", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "working"]]));
  assert.deepEqual(made.port.close({ pr: PR_URL, head: "h1" }), { state: "busy" });
  assert.equal(made.herd.calls.some((args) => args.includes("close")), false, "no workspace is closed");
});

test("close answers gone for a reviewer herdr no longer lists, and closes nothing", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map());
  assert.deepEqual(made.port.close({ pr: PR_URL, head: "h1" }), { state: "gone" });
  assert.equal(made.herd.calls.some((args) => args.includes("close")), false);
});

test("close closes nothing for a head the seat's reviewer was not started for", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]));
  const answer = made.port.close({ pr: PR_URL, head: "h2" });
  assert.match("refusal" in answer ? answer.refusal : "", /was not started for h2/);
  assert.equal(made.herd.calls.some((args) => args.includes("close")), false, "no workspace is closed");
});

test("retire closes every workspace under the seat's label, then removes its checkout, and forgets the head", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]));
  assert.deepEqual(made.port.retire(PR_URL), { retired: true, report: null });
  assert.deepEqual(made.events, ["close", "read", "removed"], "the workspace first, then the checkout");
  assert.deepEqual(made.removed, [{ pr: 7, session: "reviewer-7", key: "" }]);
  assert.equal(made.heads.has("reviewer-7"), false, "the head is forgotten once the checkout is gone");
});

test("retire on a pull request whose seat has no workspace removes only its checkout", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map());
  assert.deepEqual(made.port.retire(PR_URL), { retired: true, report: null });
  assert.equal(made.herd.calls.some((args) => args.includes("close")), false);
  assert.deepEqual(made.removed, [{ pr: 7, session: "reviewer-7", key: "" }]);
});

test("retire on a reviewer still working refuses, and removes nothing", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "working"]]));
  const answer = made.port.retire(PR_URL);
  assert.match("refusal" in answer ? answer.refusal : "", /still working/);
  assert.deepEqual(made.removed, []);
  assert.equal(made.heads.get("reviewer-7"), "h1");
});

test("a checkout with uncommitted changes is reported, naming the seat, the head and the paths, and is removed", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]), { paths: ["src/a.ts", "node_modules/x"] });
  const answer = made.port.retire(PR_URL);
  assert.ok("retired" in answer, "the pull request is retired");
  assert.match(answer.report ?? "", /^reviewer teardown: reviewer-7 for https:\/\/github\.com\/[^ ]+\/pull\/7 at h1 had 2 uncommitted change\(s\) in .+\/reviewer-7, discarded with the checkout: src\/a\.ts, node_modules\/x$/);
  assert.equal(made.removed.length, 1, "and the checkout is removed with them");
});

test("a report of uncommitted changes names the first 20 paths and how many more there were", async () => {
  await loadReviewerGate();
  const paths = Array.from({ length: 23 }, (_, i) => `f${i}.ts`);
  const made = teardownPort(new Map([["reviewer-7", "idle"]]), { paths });
  const answer = made.port.retire(PR_URL);
  const report = "retired" in answer ? answer.report ?? "" : "";
  assert.match(report, /had 23 uncommitted change\(s\)/);
  assert.match(report, /: f0\.ts, .*, f19\.ts and 3 more$/);
  assert.equal(report.includes("f20.ts"), false, "the paths past the twentieth are counted, not named");
});

test("a clean checkout is removed with no report", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]), { paths: [] });
  assert.deepEqual(made.port.retire(PR_URL), { retired: true, report: null });
  assert.equal(made.removed.length, 1);
});

test("a checkout whose changes cannot be read is kept, and the head is remembered for the next sweep", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]), { pathsFail: true });
  const answer = made.port.retire(PR_URL);
  assert.match("refusal" in answer ? answer.refusal : "", /could not be read, so it is kept/);
  assert.deepEqual(made.removed, [], "nothing is removed that could not be inspected");
  assert.equal(made.heads.get("reviewer-7"), "h1");
});

test("a removal that fails is a refusal, keeps the head, and reports no discard", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"]]), { paths: ["a.ts"], removal: "could not remove /home/x/reviews/reviewer-7 (busy)" });
  const answer = made.port.retire(PR_URL);
  assert.match("refusal" in answer ? answer.refusal : "", /could not remove .* \(busy\)/);
  assert.equal(made.heads.get("reviewer-7"), "h1", "the head is kept, so the next sweep retries");
});

test("listedPulls names the pull request of each reviewer workspace the session lists, and of no other workspace", async () => {
  await loadReviewerGate();
  const made = teardownPort(new Map([["reviewer-7", "idle"], ["NBF-1", "idle"], ["reviewer-2", "idle"]]));
  assert.deepEqual(made.port.listedPulls(), [PR_URL]);
});

// A11-83: a reviewer that ended without its verdict on the pull request. The verdict file is found by what it says, posted again through the
// door with its token minted first, and a reviewer that ended with no file is prompted again.


/** The heads the verdict tests use: hex, as the door and the verdict parser read them. */
const H1 = "a1".repeat(20);
const H2 = "c3".repeat(20);

/** The verdict line a reviewer writes for pull request 7 at `head`, as the door reads it. */
const verdictLine = (head: string, word: string) => `**Review of #7 at \`${head.slice(0, 8)}\`, by reviewer-7: ${word} (CI run 41)**`;

/** An atomic port over a checkout `tree`, whose reviewer is listed as `status`, recording each mint and door run in order. */
function verdictPort(tree: string, { status = new Map([["reviewer-7", "idle"]]), mint = (() => null) as (path: string) => string | null, door = (() => {}) as DoorRun } = {}) {
  const order: string[] = [];
  const herd = herdr(status);
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: herd.run, ...claiming(ghFor({ head: "h1" })), heads: new Map([["reviewer-7", "h1"]]),
    checkoutOf: () => tree,
    mint: (path) => { order.push(`mint ${path}`); return mint(path); },
    door: (file, args, env) => { order.push("door"); door(file, args, env); } });
  return { port, herd, order };
}

/** A fresh checkout whose `verdict-7.md` holds `content`: the checkout and the file's path. */
function verdictTree(prefix: string, content: string): { tree: string; file: string } {
  const tree = tmpDir(prefix);
  const file = join(tree, "verdict-7.md");
  writeFileSync(file, content);
  return { tree, file };
}


test("a verdict file is found by what it says, in the checkout or one folder down, for the head it names, and the newest one wins", async () => {
  await loadReviewerGate();
  const tree = tmpDir("reviewer-tree-");
  mkdirSync(join(tree, "sub"));
  mkdirSync(join(tree, "node_modules"));
  writeFileSync(join(tree, "notes.md"), "not a verdict\n");
  writeFileSync(join(tree, "old-head.md"), `${verdictLine(H2, "convinced")}\n`);
  writeFileSync(join(tree, "node_modules", "skipped.md"), `${verdictLine(H1, "convinced")}\n`);
  writeFileSync(join(tree, "verdict-7.md"), `${verdictLine(H1, "convinced")}\n`);
  utimesSync(join(tree, "verdict-7.md"), new Date(1_000), new Date(1_000));
  writeFileSync(join(tree, "sub", "verdict.md"), `${verdictLine(H1, "not convinced")}\n`);
  assert.equal(verdictFileIn(tree, 7, H1), join(tree, "sub", "verdict.md"), "the newer of the two files for the head, one folder down");
  assert.equal(verdictFileIn(tree, 7, H2), join(tree, "old-head.md"), "a file for the head it names");
  assert.equal(verdictFileIn(tree, 8, H1), null, "none for another pull request");
  assert.equal(verdictFileIn(join(tree, "missing"), 7, H1), null, "none in a checkout that is not there");
});

test("a verdict file is posted again through the door: the token is minted first, and the door is given the word the file opens with", async () => {
  await loadReviewerGate();
  const { tree, file } = verdictTree("reviewer-repost-", `${verdictLine(H1, "not convinced")}\n\nfindings\n`);
  const doorCalls: { file: string; args: string[]; env: Record<string, string> }[] = [];
  const made = verdictPort(tree, { door: (path, args, env) => { doorCalls.push({ file: path, args, env }); } });
  assert.deepEqual(made.port.repostVerdict({ pr: PR_URL, head: H1 }, file), { posted: true });
  assert.deepEqual(made.order, [`mint ${tree}`, "door"], "the token is minted before the door posts");
  assert.deepEqual(doorCalls.map((call) => call.args), [["7", "not-convinced", file]]);
  assert.equal(doorCalls[0].env.A11Y_REVIEWER_SESSION, "reviewer-7", "the door posts with the reviewer's own identity");
  assert.equal(doorCalls[0].env.A11Y_APP_TOKEN_DIR, join(tree, "node_modules", ".cache", "app-tokens"), "from the token directory the reviewer reads");
});

test("a token that will not mint stops the repost before the door runs, and its reason is the refusal, which a later attempt may cure", async () => {
  await loadReviewerGate();
  const { tree, file } = verdictTree("reviewer-mint-", `${verdictLine(H1, "convinced")}\n\nbody\n`);
  const doorCalls: string[][] = [];
  const made = verdictPort(tree, { mint: () => "the reviewer's app token could not be minted: no key", door: (_path, args) => { doorCalls.push(args); } });
  assert.deepEqual(made.port.repostVerdict({ pr: PR_URL, head: H1 }, file), { refusal: "the reviewer's app token could not be minted: no key", final: false });
  assert.deepEqual(doorCalls, [], "the door is not run without a token");
});

test("a door refusal is said with the door's own last line: a refusal a repost would repeat is final, and one for the token is not", async () => {
  await loadReviewerGate();
  const { tree, file } = verdictTree("reviewer-refused-", `${verdictLine(H1, "convinced")}\n\nbody\n`);
  for (const [status, reason, final] of [
    [5, "The head moved since you reviewed it: your verdict names a1a1a1a1.", true],
    [3, "#7 already has a review at an equal patch: APPROVED", true],
    [6, "the reviewer App token could not be minted: no key", false],
  ] as const) {
    const made = verdictPort(tree, { door: () => { throw Object.assign(new Error("door"), { status, stderr: `pr-review-verdict: NOT POSTED. ${reason}\n` }); } });
    assert.deepEqual(made.port.repostVerdict({ pr: PR_URL, head: H1 }, file), { refusal: reason, final }, `door exit ${status}`);
  }
});

test("a verdict file that names another head, or no verdict, is not posted", async () => {
  await loadReviewerGate();
  const { tree, file } = verdictTree("reviewer-wrong-", `${verdictLine(H2, "convinced")}\n\nbody\n`);
  const made = verdictPort(tree);
  assert.deepEqual(made.port.repostVerdict({ pr: PR_URL, head: H1 }, file), { refusal: `the verdict file ${file} does not open with a verdict for ${H1.slice(0, 8)}`, final: true });
  assert.deepEqual(made.order, [], "nothing is minted or posted");
});

test("settled reads the reviewer for its head: working while its agent works, ended once it is idle, and gone when herdr lists none for the head", async () => {
  await loadReviewerGate();
  const status = new Map([["reviewer-7", "working"]]);
  const made = verdictPort(tmpDir("reviewer-settled-"), { status });
  const ref = { pr: PR_URL, head: "h1" };
  assert.equal(made.port.settled(ref), "working");
  status.set("reviewer-7", "idle");
  assert.equal(made.port.settled(ref), "ended");
  status.set("reviewer-7", "unknown");
  assert.equal(made.port.settled(ref), "ended", "no agent in the pane: its process exited");
  status.delete("reviewer-7");
  assert.equal(made.port.settled(ref), "gone");
  assert.equal(made.port.settled({ pr: PR_URL, head: H2 }), "gone", "and for a head it was not started for");
});

test("reprompt sends the gate's verdict prompt to the seat's agent again, naming the head", async () => {
  await loadReviewerGate();
  const made = verdictPort(tmpDir("reviewer-prompt-"));
  assert.deepEqual(made.port.reprompt({ pr: PR_URL, head: "h1" }), { prompted: true });
  const prompt = made.herd.calls.find((args) => args.includes("prompt"))!;
  assert.deepEqual(prompt.slice(0, 5), ["--session", "tickets", "agent", "prompt", "reviewer-7"]);
  assert.ok(prompt[5].includes("`h1`"), "the prompt names the head it is for");
});


/** A repository this host clones and the project does not declare, under the primary's owner: the atomic reviewer takes its pull requests. */
const OWNER = REPO.split("/")[0];
const PLUGIN_URL = `https://github.com/${OWNER}/plugin/pull/7`;
const refusalOf = (answer: object | null): string => answer !== null && "refusal" in answer && typeof answer.refusal === "string" ? answer.refusal : "";

/** An atomic port whose only clone is `plugin`, recording each checkout and each spawn; herdr lists `listed`. */
function clonedPort(listed: Map<string, string>, clones: Record<string, string> = { plugin: "/repos/plugin" }) {
  const herd = herdr(listed);
  const checkouts: object[] = [];
  const spawned: { options: object; env: unknown; cwd: unknown }[] = [];
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: herd.run, ...claiming(ghFor({ head: "h1" })), clones,
    checkout: (args) => { checkouts.push(args); return { path: "/work/pr-7", head: "h1" }; },
    spawn: (order, _agents, options) => { spawned.push({ options, env: options.env, cwd: options.cwd }); return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }; } });
  return { port, herd, checkouts, spawned };
}


test("the atomic reviewer starts a reviewer for a repository the host clones and the project does not declare, in its clone, naming its repository", async () => {
  await loadReviewerGate();
  const made = clonedPort(new Map());
  assert.deepEqual(made.port.start({ pr: PLUGIN_URL, head: "h1" }), { label: "reviewer-plugin-7" });
  assert.deepEqual(made.checkouts, [{ pr: 7, session: "reviewer-plugin-7", trust: INSIDE, repoRoot: "/repos/plugin" }], "the checkout is made in the clone");
  assert.deepEqual(made.spawned[0].env, { GH_REPO: `${OWNER}/plugin`, [HOST_CONFIG_ENV]: hostConfigPath(), AGENT_ORG_INSTANCE: "work" }, "the reviewer's door posts to the clone's repository");
  const prompt = made.herd.calls.find((args) => args.includes("prompt"))!;
  assert.equal(prompt[4], "reviewer-plugin-7", "the gate's prompt goes to the clone's seat");
});

test("a cloned-only reviewer is live for its head, is listed by its pull request, and is retired from its clone", async () => {
  await loadReviewerGate();
  const removed: object[] = [];
  const herd = herdr(new Map([["reviewer-plugin-7", "idle"], ["reviewer-foo-3", "idle"]]));
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: herd.run, ...claiming(ghFor({ head: "h1" })), clones: { plugin: "/repos/plugin" },
    heads: new Map([["reviewer-plugin-7", "h1"]]), exists: () => false,
    removeCheckout: (args) => { removed.push(args); return null; } });
  assert.equal(port.live({ pr: PLUGIN_URL, head: "h1" }), true, "live for the head it was started for");
  assert.deepEqual(port.listedPulls(), [PLUGIN_URL], "the sweep finds the clone's pull request, and no reviewer of a repository neither declared nor cloned");
  assert.deepEqual(port.retire(PLUGIN_URL), { retired: true, report: null });
  assert.deepEqual(removed, [{ pr: 7, session: "reviewer-plugin-7", key: "plugin", repoRoot: "/repos/plugin" }], "the checkout is removed from the clone under its own ref");
});

test("a verdict of a cloned-only reviewer is posted through the door with its repository in the environment", async () => {
  await loadReviewerGate();
  const { tree, file } = verdictTree("reviewer-clone-repost-", `${verdictLine(H1, "convinced")}\n\nbody\n`);
  const doorCalls: { args: string[]; env: Record<string, string> }[] = [];
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: herdr(new Map()).run, ...claiming(ghFor({ head: "h1" })), clones: { plugin: "/repos/plugin" },
    checkoutOf: () => tree, mint: () => null, door: (_path, args, env) => { doorCalls.push({ args, env }); } });
  assert.deepEqual(port.repostVerdict({ pr: PLUGIN_URL, head: H1 }, file), { posted: true });
  assert.deepEqual(doorCalls.map((call) => call.args), [["7", "convinced", file]]);
  assert.equal(doorCalls[0].env.GH_REPO, `${OWNER}/plugin`, "the door posts to the clone's pull request, not the primary's pull request of the same number");
});

test("a repository neither declared nor cloned, or cloned under another owner, is refused, and the refusal names the project's declaration and the host's clones", async () => {
  await loadReviewerGate();
  const made = clonedPort(new Map());
  for (const pr of [`https://github.com/someone-else/plugin/pull/7`, `https://github.com/${OWNER}/not-cloned/pull/7`]) {
    const refusal = refusalOf(made.port.start({ pr, head: "h1" }));
    assert.match(refusal, /project\.json/, `${pr} names the project's declaration`);
    assert.match(refusal, /host\.json/, `${pr} names the host's clones`);
  }
  assert.deepEqual(made.checkouts, [], "nothing is checked out for a refused repository");
});

test("a clone whose name cannot be a reviewer key is refused by name, and no checkout is made", async () => {
  await loadReviewerGate();
  const made = clonedPort(new Map(), { Foo: "/repos/Foo" });
  assert.match(refusalOf(made.port.start({ pr: `https://github.com/${OWNER}/Foo/pull/7`, head: "h1" })), /its name `Foo` cannot be a reviewer key/);
  assert.deepEqual(made.checkouts, []);
});

test("a declared repository whose name is also a clone keeps its declared key, with no clone as its checkout and only the instance added to its environment", async () => {
  await loadReviewerGate();
  const declared = homeProjectDeclaration().code.find((code) => code.key !== "")!;
  const made = clonedPort(new Map(), { [declared.key]: "/repos/elsewhere" });
  assert.deepEqual(made.port.start({ pr: `https://github.com/${declared.repo}/pull/7`, head: "h1" }), { label: `reviewer-${declared.key}-7` });
  assert.equal("repoRoot" in made.checkouts[0], false, "the gate takes the declared clone, as it does now");
  assert.deepEqual(made.spawned[0].env, { AGENT_ORG_INSTANCE: "work" }, "the spawn names this instance for the door's claim, and no repository, as it did not before");
});

test("clonedSeatOf takes a clone only of the primary's owner, refuses a name that cannot be a key, and refuses a name a declared repository is keyed by", () => {
  const clones = { plugin: "/repos/plugin", ".github": "/repos/github", github: "/repos/github-clone" };
  const codes = [{ key: "", repo: `${OWNER}/${OWNER}` }, { key: "github", repo: `${OWNER}/.github` }];
  assert.deepEqual(clonedSeatOf(`${OWNER}/plugin`, { owner: OWNER, clones, codes }), { key: "plugin", clone: "/repos/plugin" });
  assert.equal(clonedSeatOf("someone-else/plugin", { owner: OWNER, clones, codes }), null, "another owner's repository is no clone of this org's");
  assert.equal(clonedSeatOf(`${OWNER}/not-cloned`, { owner: OWNER, clones, codes }), null, "a repository the host does not clone is no seat");
  assert.match(refusalOf(clonedSeatOf(`${OWNER}/.github`, { owner: OWNER, clones: { ".github": "/repos/github" }, codes: [] })), /its name `\.github` cannot be a reviewer key \(lowercase letters, digits and hyphens, not ending in a number\)/);
  assert.ok(refusalOf(clonedSeatOf(`${OWNER}/github`, { owner: OWNER, clones, codes })).includes(`declares \`github\` as the key of ${OWNER}/.github`), "the clone named as a declared key would take that key's seat");
});

test("A11-175: the started prompt names the unrequired red checks the code host reports, and the reprompt and a re-review do too; a head with none says nothing of them", async () => {
  await loadReviewerGate();
  const red = ["checks (cross-repo)"];
  const { port, prompted } = startingPort({ unrequiredRed: red });
  assert.deepEqual(port.start({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN }), { label: "reviewer-7" }, "its required checks are settled green, so it starts");
  assert.ok(prompted().includes(unrequiredRedWords(red)) && prompted().endsWith(POST_MERGE_RULE), "the first review is told which checks were left red");
  assert.deepEqual(port.reprompt({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN }), { prompted: true });
  assert.ok(prompted().includes(unrequiredRedWords(red)), "and so is the reprompt");
  const block = review("a11ign-reviewer", "CHANGES_REQUESTED", "h1", Date.now() - 30 * 60_000);
  const again = startingPort({ reviews: [block], statuses: [FIRST_CLAIM(), BLOCK_STATUS()], unrequiredRed: red });
  assert.deepEqual(again.port.start({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN, rereview: { replies: [REPLY] } }), { label: "reviewer-7" });
  assert.ok(again.prompted().startsWith("This is a re-review of #7") && again.prompted().includes(unrequiredRedWords(red)), "a re-review is told too");
  const plain = startingPort();
  plain.port.start({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN });
  assert.ok(!plain.prompted().includes("not required"), "a head with no red check that is left out says nothing of them");
});

test("A11-175: a brief that names the plan step a pull request finishes reaches the prompt in a first review and a reprompt", async () => {
  await loadReviewerGate();
  const { port, prompted } = startingPort();
  const brief = { doneWhen: DONE_WHEN, step: { step: 3, of: 9, section: "### Step 3 of 9: Reviews\n\nMove the calls." } };
  assert.deepEqual(port.start({ pr: PR_URL, head: "h1" }, brief), { label: "reviewer-7" });
  const first = prompted();
  assert.ok(first.includes("This pull request is step 3 of 9 of its ticket's plan") && first.includes("Move the calls.") && first.includes(RATCHET_RULE));
  assert.ok(first.includes(`The ticket's Done-when, for the last step (step 9 of 9), as the ticket states it:\n\n${DONE_WHEN}`) && first.endsWith(POST_MERGE_RULE));
  assert.deepEqual(port.reprompt({ pr: PR_URL, head: "h1" }, brief), { prompted: true });
  assert.equal(prompted(), first, "the reprompt says what the first prompt did");
});

test("A11-213: the ticket's decisions in the brief reach the prompt a reviewer is started with, the one a reprompt sends, and the re-review's", async () => {
  await loadReviewerGate();
  const decisions = "This step widens the policy's permissions by the chairman's decision on 2026-10-24.";
  const { port, prompted } = startingPort();
  assert.deepEqual(port.start({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN, decisions }), { label: "reviewer-7" });
  const first = prompted();
  assert.ok(first.includes(`The ticket's explicit decisions, as the ticket states them:\n\n${decisions}`) && first.includes(DECISION_RULE), first);
  assert.deepEqual(port.reprompt({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN, decisions }), { prompted: true });
  assert.equal(prompted(), first, "the reprompt says what the first prompt did");
  const block = review("a11ign-reviewer", "CHANGES_REQUESTED", "h1", Date.now() - 30 * 60_000);
  const again = startingPort({ reviews: [block], statuses: [FIRST_CLAIM(), BLOCK_STATUS()] });
  assert.deepEqual(again.port.start({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN, decisions, rereview: { replies: [REPLY] } }), { label: "reviewer-7" });
  assert.ok(again.prompted().startsWith("This is a re-review of #7") && again.prompted().includes(decisions) && again.prompted().includes(DECISION_RULE), "the re-review carries them too");
});

test("A11-235: a re-review brief whose description changed reaches the prompt with the changed lines, with or without a reply", async () => {
  await loadReviewerGate();
  const block = review("a11ign-reviewer", "CHANGES_REQUESTED", "h1", Date.now() - 30 * 60_000);
  const body = [{ kind: "removed", text: "Outside-Region: none" }, { kind: "added", text: "Outside-Region: src/a.ts — the reason" }] as const;
  const only = startingPort({ reviews: [block], statuses: [FIRST_CLAIM(), BLOCK_STATUS()] });
  assert.deepEqual(only.port.start({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN, rereview: { replies: [], body } }), { label: "reviewer-7" });
  const words = only.prompted();
  assert.ok(words.startsWith("This is a re-review of #7") && words.includes("- Outside-Region: none\n+ Outside-Region: src/a.ts — the reason"), words);
  assert.ok(!words.includes("The replies posted since that review"), "and no replies are listed when there are none");
  const both = startingPort({ reviews: [block], statuses: [FIRST_CLAIM(), BLOCK_STATUS()] });
  both.port.start({ pr: PR_URL, head: "h1" }, { doneWhen: DONE_WHEN, rereview: { replies: [REPLY], body } });
  assert.ok(both.prompted().includes("+ Outside-Region: src/a.ts — the reason") && both.prompted().includes(`- worker-bot (${PR_URL}#issuecomment-9):`), "a description edit and a reply are both quoted");
});

/** A port whose Codex trust is `answer` for the root `rootOf` finds, with the order in which the trust, the claim and the spawn happened. */
function trustingPort({ root = "/repos/alpha" as string | null, answer }: { root?: string | null; answer: (root: string) => import("./codex-trust.ts").Ensured }) {
  const herd = herdr(new Map());
  const fake = ghFor({ head: "h1" });
  const events: string[] = [];
  const logged: string[] = [];
  const asked: string[] = [];
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: herd.run, ...claiming(fake),
    spawn: (order) => { events.push(`spawn (${fake.pr.statuses?.length ?? 0} claim statuses)`); return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }; },
    checkout: () => ({ path: "/work/pr-7", head: "h1" }),
    codexTrust: { rootOf: (tree) => { asked.push(tree); return root; }, ensure: (found) => { events.push(`trust ${found} (${fake.pr.statuses?.length ?? 0} claim statuses)`); return answer(found); }, log: (line) => logged.push(line) } });
  return { port, events, logged, asked, herd, statuses: () => fake.pr.statuses ?? [] };
}

test("A11-221: an untrusted host repository is trusted before the reviewer launches: the checkout's clone root is trusted before the claim is written and before the spawn", async () => {
  await loadReviewerGate();
  const made = trustingPort({ answer: (root) => ({ kind: "added", root, file: "/home/me/.codex/config.toml" }) });
  assert.deepEqual(made.port.start({ pr: PR_URL, head: "h1" }), { label: "reviewer-7" });
  assert.deepEqual(made.asked, ["/work/pr-7"], "the clone root is found from the checkout");
  assert.deepEqual(made.events, ["trust /repos/alpha (0 claim statuses)", "spawn (1 claim statuses)"]);
  assert.deepEqual(made.logged, [`codex now trusts /repos/alpha: the reviewer of ${PR_URL} starts in it`]);
});

test("A11-221: a repository Codex already has an entry for starts silently, as does a root the host file does not name and a checkout with no clone root", async () => {
  await loadReviewerGate();
  const present = trustingPort({ answer: (root) => ({ kind: "present", root, file: "/c", level: "untrusted" }) });
  assert.deepEqual(present.port.start({ pr: PR_URL, head: "h1" }), { label: "reviewer-7" });
  const outside = trustingPort({ answer: (root) => ({ kind: "not-host", root, reason: "not named" }) });
  assert.deepEqual(outside.port.start({ pr: PR_URL, head: "h1" }), { label: "reviewer-7" });
  const rootless = trustingPort({ root: null, answer: () => { throw new Error("nothing to trust"); } });
  assert.deepEqual(rootless.port.start({ pr: PR_URL, head: "h1" }), { label: "reviewer-7" });
  assert.deepEqual([present.logged, outside.logged, rootless.logged], [[], [], []]);
});

test("A11-221: a Codex config that cannot be used refuses the start, naming the file, and no claim is written, no reviewer spawned, no prompt sent", async () => {
  await loadReviewerGate();
  const made = trustingPort({ answer: () => ({ kind: "refused", file: "/home/me/.codex/config.toml", reason: "/home/me/.codex/config.toml does not parse as TOML" }) });
  const started = made.port.start({ pr: PR_URL, head: "h1" });
  assert.equal("refusal" in started ? started.refusal : "", `no reviewer for ${PR_URL}: /home/me/.codex/config.toml does not parse as TOML`);
  assert.deepEqual(made.events, ["trust /repos/alpha (0 claim statuses)"]);
  assert.deepEqual(made.statuses(), [], "no claim is written");
  assert.equal(made.herd.calls.some((args) => args.includes("prompt")), false);
});
