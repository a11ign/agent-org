// no-token: gh -- every `gh` and `herdr` here is a recorder or an injected seam; the pull requests are in memory and nothing reaches GitHub
/**
 * agent-org#1311: A PULL REQUEST FROM OUTSIDE THE ORG IS READ, NEVER RUN.
 *
 * WHAT IS PINNED, through the paths the order really takes: `perPullRequestOrders` decides the trust, `deliver` prepares the checkout and
 * starts the reviewer, and the recorders say what reached herdr, git and the door. A fork pull request and a same-repository pull request by
 * an account the host did not name are each read-only: no dependency link, no `gh` identity in the pane, the codex sandbox set to read-only,
 * and a prompt that forbids running anything. A pull request by a declared author in the org's own repository is started EXACTLY as before.
 *
 * The explicit identities below are the host's declaration as a test writes it: `declaredIdentities()` reads the machine's own `hosts.yml`,
 * and a test does not read that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { perPullRequestOrders } from "./work-gate/pr-orders.ts";
import { deliver, spawnInvocation, postOutsideVerdictsOf, reviewerEnvironment } from "./wake.ts";
import { DEPENDENCY_BOT_LOGIN } from "./dependency-bot-login.ts";
import { reviewerDoorPath } from "./reviewer-door-path.ts";
import { startedPanes } from "./packaging/started-pane.ts";
import {
  AUTOMATION_WRITER_LOGIN, INSIDE, OUTSIDE, REVIEWER_GH_CONFIG_DIR, isDeclaredLogin, outsidePrompt, outsideReviewArgs,
  outsideReviewerEnvironment,
  outsideVerdictBlock, postOutsideVerdict, postOutsideVerdicts, reviewTrustOf, type DeclaredIdentities, type DoorRun, type ReviewTrust,
} from "./review-trust.ts";

type Order = Parameters<typeof deliver>[0][number];
type Events = string[];

const HEAD = "7311face".repeat(5);
const HEAD8 = HEAD.slice(0, 8);
const OTHER_HEAD = "9311beef".repeat(5);
const OTHER8 = OTHER_HEAD.slice(0, 8);
const NOW = Date.parse("2026-10-13T10:20:00Z");
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-13T10:00:00Z" }];
const ROLE_FILE = ".agent-org/roles/reviewer.md";
const ROSTER: string[] = [];
const DECLARED: DeclaredIdentities = { exact: ["worker-1"], pattern: [DEPENDENCY_BOT_LOGIN, AUTOMATION_WRITER_LOGIN] };

/** A pull request as `gh pr list --json` returns it. `crossRepository` is GitHub's own `isCrossRepository`: true for a fork. */
const pullRequest = (number: number, { crossRepository, login }: { crossRepository: boolean; login: string; }) => ({
  number, headRefOid: HEAD, isDraft: false, statusCheckRollup: GREEN, updatedAt: "2026-10-13T09:50:00Z", mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN", headRefName: `agent/some-slug-${number}`, comments: [], closingIssuesReferences: [],
  author: { login }, reviewDecision: null, labels: [], reviews: [], isCrossRepository: crossRepository,
});

/** The draft order `perPullRequestOrders` makes for `pr`, with the host's identities passed in. */
function reviewOrderFor(pr: ReturnType<typeof pullRequest>): Order {
  const made = perPullRequestOrders([pr] as never, null, null, { nowMs: NOW, identities: DECLARED }) as unknown as { cause: string; }[];
  const asked = made.find((o) => o.cause === "draft-awaiting-verdict");
  assert.ok(asked, `no reviewer order for #${pr.number}`);
  return asked as unknown as Order;
}

const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));

/** A `herdr` that records every call and answers `workspace create` with a pane, as the live org does. */
function recordingHerdr(events: Events = []) {
  const calls: string[][] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    calls.push(args);
    events.push(`herdr ${args.join(" ")}`);
    const answered = pane(args);
    if (answered !== null) return answered;
    if (args.join(" ").includes("workspace create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  const said = (verb: string) => calls.map((c) => c.join(" ")).filter((s) => s.includes(verb));
  return { calls, run, said };
}

/** A `git` that records what was asked and keeps the tree set in memory: a checkout is a path and the head it is at. */
function fakeCheckout(events: Events = []) {
  const trees = new Map<string, string>();
  const git = (_cmd: string, args: string[]) => {
    const line = args.join(" ");
    events.push(`git ${line}`);
    if (line.includes(" fetch ")) return "";
    if (line.includes("rev-parse --verify")) return `${HEAD}\n`;
    if (line.includes("worktree add")) { trees.set(args[args.length - 2], args[args.length - 1]); return ""; }
    if (line.endsWith("rev-parse HEAD")) return `${trees.get(args[1])}\n`;
    throw new Error(`unexpected git ${line}`);
  };
  const link = ({ path }: { path: string; }) => {
    events.push(`link ${path}`);
    return null;
  };
  return { trees, seams: { git, link, exists: (path: string) => trees.has(path), root: "/reviews-root", repoRoot: "/primary" } };
}

/** The reviewer path's seams for one test: herdr and git, sharing one event log, and the registration the gate makes. */
function world() {
  const events: Events = [];
  const h = recordingHerdr(events);
  const co = fakeCheckout(events);
  const registered: [string, ReviewTrust | undefined][] = [];
  const deps = { run: h.run, checkout: co.seams, registerReviewer: (session: string, trust?: ReviewTrust) => { registered.push([session, trust]); } };
  return { h, co, events, registered, deps };
}

/** The argument list herdr received for the call that contains `verb`, or fails the test. */
function callWith(h: ReturnType<typeof recordingHerdr>, verb: string): string[] {
  const found = h.calls.find((c) => c.join(" ").includes(verb));
  assert.ok(found, `no herdr call with "${verb}"`);
  return found;
}

/** The variable NAMES a `workspace create` carries, in order: the environment a pane is started with. */
const envNames = (create: string[]) => create.flatMap((arg, i) => (create[i - 1] === "--env" ? [arg.split("=")[0]] : []));
const envValue = (create: string[], name: string) => create.find((arg, i) => create[i - 1] === "--env" && arg.startsWith(`${name}=`))?.slice(name.length + 1);

/** A verdict block as an outside reviewer writes it at the end of a review, with `head` as the head it names. */
function verdictPane(pr: number, head = HEAD, verdict = "convinced") {
  return ["some review output", `BEGIN REVIEW VERDICT #${pr} at ${head}`, `verdict: ${verdict}`,
    `**Review of #${pr} at \`${head.slice(0, 8)}\``, "Acceptance: read, not run.", `END REVIEW VERDICT #${pr}`].join("\n");
}

// --- the decision -----------------------------------------------------------------------------------------------

test("#1311: INSIDE only when the pull request is not from a fork AND its author is declared; everything else is OUTSIDE", () => {
  const cases: [string, unknown, { isCrossRepository?: unknown; author?: { login?: unknown; } | null; }, ReviewTrust][] = [
    ["a same-repository pull request by a declared author", "a", { isCrossRepository: false, author: { login: "worker-1" } }, INSIDE],
    ["the same, with the login in another case", "a", { isCrossRepository: false, author: { login: "WORKER-1" } }, INSIDE],
    ["a same-repository pull request by a declared App", "a", { isCrossRepository: false, author: { login: "app/octo-sts" } }, INSIDE],
    ["a same-repository pull request by dependabot", "a", { isCrossRepository: false, author: { login: "dependabot[bot]" } }, INSIDE],
    ["a FORK by a declared author: the author is not enough", "a", { isCrossRepository: true, author: { login: "worker-1" } }, OUTSIDE],
    ["a same-repository pull request by an account the host did not name", "a", { isCrossRepository: false, author: { login: "mallory-human" } }, OUTSIDE],
    ["a pull request whose fork flag GitHub did not return", "a", { author: { login: "worker-1" } }, OUTSIDE],
    ["a fork flag that is not the boolean false", "a", { isCrossRepository: "false", author: { login: "worker-1" } }, OUTSIDE],
    ["a same-repository pull request with no author", "a", { isCrossRepository: false }, OUTSIDE],
    ["no pull request at all", "a", null as never, OUTSIDE],
  ];
  for (const [name, , pr, want] of cases) {
    assert.equal(reviewTrustOf(pr as never, DECLARED), want, name);
  }
});

test("#1311: a declared login is matched exactly or by the bot patterns, case-insensitively, and never by a prefix", () => {
  assert.equal(isDeclaredLogin("", DECLARED), false);
  assert.equal(isDeclaredLogin("worker-10", DECLARED), false, "`worker-1` does not declare `worker-10`");
  assert.equal(isDeclaredLogin("app/octo-sts-evil", DECLARED), false, "an App named as a prefix of a declared one is not it");
  assert.equal(isDeclaredLogin("octo-sts[bot]", DECLARED), true);
  assert.equal(isDeclaredLogin("DanBeckDev", { exact: ["danbeckdev"], pattern: [] }), true);
});

// --- the read-only shape of an outside reviewer ------------------------------------------------------------------

test("#1311: an outside reviewer's codex runs read-only: every sandbox pair is replaced by one read-only pair, last", () => {
  assert.deepEqual(outsideReviewArgs(["exec", "-c", 'sandbox_mode="workspace-write"', "-m", "gpt-5.6-luna"]),
    ["exec", "-m", "gpt-5.6-luna", "-c", 'sandbox_mode="read-only"']);
  assert.deepEqual(outsideReviewArgs(["-c", 'sandbox_mode="danger-full-access"', "-c", "approval_policy=\"never\""]),
    ["-c", "approval_policy=\"never\"", "-c", 'sandbox_mode="read-only"'], "a second pair is dropped too; the read-only one is the one codex gets");
});

test("#1311: an outside reviewer's prompt forbids running anything, forbids posting, and asks for the verdict block", () => {
  const prompt = outsidePrompt({ number: 7000, author: { login: "mallory-human" } }, HEAD8, ROLE_FILE);
  assert.match(prompt, /OUTSIDE the organization \(author `mallory-human`\)/);
  assert.match(prompt, /READ-ONLY sandbox with NO network/);
  assert.match(prompt, /Do not run, build, install or execute anything/);
  assert.match(prompt, /do NOT post anything/);
  assert.match(prompt, new RegExp(`BEGIN REVIEW VERDICT #7000 at <full head sha>`));
  assert.equal(outsideVerdictBlock(prompt, 7000), null, "the prompt's own template is never read as a verdict");
});

test("#1311: an outside reviewer's pane carries no account: no GH_CONFIG_DIR, no token, no reviewer role, no npm cache", () => {
  const env = outsideReviewerEnvironment("reviewer-7000", null);
  assert.deepEqual(env, { A11Y_REVIEWER_SESSION: "reviewer-7000" });
  assert.deepEqual(outsideReviewerEnvironment("reviewer-7000", "a11ign/agent-org"), { A11Y_REVIEWER_SESSION: "reviewer-7000", GH_REPO: "a11ign/agent-org" });
});

test("#1311: the door the gate posts through is the door the host installs -- one reviewerDoorPath, re-exported by host-units", () => {
  // host-units reads git history, so this test does not import it (the history ratchet in src/packaging/work-gate.test.ts). It reads
  // the one definition the gate and the host both call, and checks host-units re-exports that definition rather than writing its own.
  const hostUnits = readFileSync(new URL("./host-units.ts", import.meta.url), "utf8");
  assert.match(hostUnits, /import \{ reviewerDoorPath \} from "\.\/reviewer-door-path\.ts";/);
  assert.match(hostUnits, /export \{ reviewerDoorPath \};/);
  assert.doesNotMatch(hostUnits, /export function reviewerDoorPath/);
  assert.equal(reviewerDoorPath({ reviewerBin: "/x/bin" }), "/x/bin/pr-review-verdict");
});

// --- the order path: perPullRequestOrders decides the trust -----------------------------------------------------

test("#1311: the order path carries the trust: a fork is OUTSIDE, a same-repository undeclared author is OUTSIDE, a declared author INSIDE", () => {
  const fork = reviewOrderFor(pullRequest(7100, { crossRepository: true, login: "worker-1" }));
  const undeclared = reviewOrderFor(pullRequest(7101, { crossRepository: false, login: "mallory-human" }));
  const inside = reviewOrderFor(pullRequest(7102, { crossRepository: false, login: "worker-1" }));
  assert.equal((fork as { trust?: unknown }).trust, OUTSIDE);
  assert.equal((undeclared as { trust?: unknown }).trust, OUTSIDE);
  assert.equal((inside as { trust?: unknown }).trust, INSIDE);
  assert.match(fork.prompt, /READ-ONLY sandbox/, "the outside order asks for the read-only review");
  assert.doesNotMatch(inside.prompt, /READ-ONLY sandbox/, "an inside order's prompt is the one it was");
});

// --- the spawn path: deliver starts the reviewer, through recorders -----------------------------------------------

test("#1311 (fork): a fork pull request is started READ-ONLY: codex sandboxed read-only, no account in the pane, no dependency link, a read-only prompt", () => {
  const w = world();
  const out = deliver([reviewOrderFor(pullRequest(7100, { crossRepository: true, login: "worker-1" }))], agents({}), ROSTER, w.deps);
  assert.equal(out.sent.length, 1, `started; refused: ${JSON.stringify(out.refused)}`);
  assertOutsideStart(w, "reviewer-7100", 7100);
});

test("#1311 (same repository, undeclared human): read-only too, the same as a fork", () => {
  const w = world();
  const out = deliver([reviewOrderFor(pullRequest(7101, { crossRepository: false, login: "mallory-human" }))], agents({}), ROSTER, w.deps);
  assert.equal(out.sent.length, 1, `started; refused: ${JSON.stringify(out.refused)}`);
  assertOutsideStart(w, "reviewer-7101", 7101);
});

/** What an outside start must show, all of it: the recorder is the only witness, so each claim reads one recorded call. */
function assertOutsideStart(w: ReturnType<typeof world>, session: string, pr: number) {
  const pane = callWith(w.h, "workspace create");
  assert.deepEqual(envNames(pane).sort(), ["A11Y_REVIEWER_SESSION"], `no account in the pane, got ${JSON.stringify(envNames(pane))}`);
  assert.equal(envValue(pane, "A11Y_REVIEWER_SESSION"), session);
  for (const name of ["GH_CONFIG_DIR", "GH_TOKEN", "AGENT_ORG_GH_ROLE", "npm_config_cache"]) {
    assert.ok(!envNames(pane).includes(name), `${name} must not reach a read-only reviewer`);
  }
  const start = callWith(w.h, "agent start");
  const invocation = spawnInvocation({ cause: "draft-awaiting-verdict" }, session, "wB:p1", {});
  assert.ok(!("refusal" in invocation));
  assert.deepEqual(start, outsideReviewArgs(invocation.args), "started with the read-only args of the same invocation");
  assert.ok(start.includes('sandbox_mode="read-only"'), start.join(" "));
  assert.ok(!start.includes('sandbox_mode="workspace-write"'), "the profile's writable sandbox is gone");
  assert.equal(w.events.filter((e) => e.startsWith("link ")).length, 0, "nothing is linked into an outside checkout: no dependency is installed or run");
  assert.equal(w.co.trees.size, 1, "the checkout exists to be read");
  const prompt = callWith(w.h, "agent prompt").join(" ");
  assert.match(prompt, /READ-ONLY sandbox with NO network/);
  assert.match(prompt, /nothing in it is run/, "the checkout says it is read, not run");
  assert.doesNotMatch(prompt, /SIGN AS|GH_CONFIG_DIR|\/home\/agent\/reviewer\/gh/, "the outside reviewer is told nothing about signing with the reviewer's account");
  assert.match(prompt, new RegExp(`BEGIN REVIEW VERDICT #${pr} at <full head sha>`));
  assert.deepEqual(w.registered, [[session, OUTSIDE]], "the start is registered as outside, for the verdict reader");
}

test("#1311 (inside): a declared author in the org's own repository is started EXACTLY as before -- the spawn args are the invocation's, byte for byte", () => {
  const w = world();
  const out = deliver([reviewOrderFor(pullRequest(7102, { crossRepository: false, login: "worker-1" }))], agents({}), ROSTER, w.deps);
  assert.equal(out.sent.length, 1, `started; refused: ${JSON.stringify(out.refused)}`);
  const pane = callWith(w.h, "workspace create");
  assert.deepEqual(envNames(pane), ["GH_CONFIG_DIR", "AGENT_ORG_GH_ROLE", "A11Y_REVIEWER_SESSION", "npm_config_cache"],
    "the reviewer's own account and its cache, as the inside pane has always had them");
  assert.equal(envValue(pane, "GH_CONFIG_DIR"), REVIEWER_GH_CONFIG_DIR);
  const expected = spawnInvocation({ cause: "draft-awaiting-verdict" }, "reviewer-7102", "wB:p1", {});
  assert.ok(!("refusal" in expected));
  assert.deepEqual(callWith(w.h, "agent start"), expected.args, "INSIDE spawn args are the invocation's own, unchanged");
  assert.ok(callWith(w.h, "agent start").includes('sandbox_mode="workspace-write"'), "the inside profile keeps its own sandbox");
  const link = w.events.findIndex((e) => e.startsWith("link "));
  const start = w.events.findIndex((e) => e.includes("agent start"));
  assert.ok(link >= 0 && link < start, "the dependency link is made BEFORE the pane opens, as it always was");
  const prompt = callWith(w.h, "agent prompt").join(" ");
  assert.match(prompt, /SIGN AS `reviewer-7102`/, "an inside reviewer is signed as before");
  assert.doesNotMatch(prompt, /READ-ONLY/);
  assert.deepEqual(w.registered, [["reviewer-7102", INSIDE]]);
});

test("#1311: an order that does not say its trust is refused, and no checkout or pane is made for it", () => {
  const w = world();
  const bare = { session: "reviewer-7105", cause: "draft-awaiting-verdict", causeKey: "reviewer-7105/draft-awaiting-verdict/pr-7105/abc", prompt: "Review #7105." };
  const out = deliver([bare as Order], agents({}), ROSTER, w.deps);
  assert.deepEqual(out.sent, []);
  assert.match(out.refused[0], /does not say whether its pull request is inside the org/);
  assert.equal(w.h.said("workspace create").length, 0);
  assert.equal(w.co.trees.size, 0);
});

test("#1311: a LIVE reviewer keeps the trust it was started with: an outside pull request is not sent to an inside reviewer, and the reverse", () => {
  const w = world();
  const inside = deliver([reviewOrderFor(pullRequest(7103, { crossRepository: false, login: "mallory-human" }))], agents({ "reviewer-7103": "idle" }), ROSTER,
    { ...w.deps, registry: () => ({ "reviewer-7103": { spawnedAt: 1 } }) });
  assert.deepEqual(inside.sent, []);
  assert.match(inside.refused[0], /was started inside the org, and this pull request is outside: not sent/);
  assert.equal(w.h.said("agent prompt").length, 0, "no prompt carries an outside pull request into the inside pane");

  const reverse = deliver([reviewOrderFor(pullRequest(7104, { crossRepository: false, login: "worker-1" }))], agents({ "reviewer-7104": "idle" }), ROSTER,
    { ...w.deps, registry: () => ({ "reviewer-7104": { spawnedAt: 1, trust: OUTSIDE } }) });
  assert.deepEqual(reverse.sent, []);
  assert.match(reverse.refused[0], /was started outside the org, and this pull request is inside: not sent/);
});

// --- the verdict path: the gate reads the pane and posts through the door -----------------------------------------

test("#1311: the verdict block is the LAST complete block for its pull request, at the head it names", () => {
  const pane = [verdictPane(7020, HEAD, "not-convinced"), verdictPane(7020, OTHER_HEAD, "convinced")].join("\n");
  assert.deepEqual(outsideVerdictBlock(pane, 7020), {
    head: OTHER_HEAD, verdict: "convinced", body: `**Review of #7020 at \`${OTHER8}\`\nAcceptance: read, not run.`,
  });
});

test("#1311: a block that never closes, names another pull request, or has no body or a foreign verdict word is no verdict", () => {
  const open = [`BEGIN REVIEW VERDICT #7021 at ${HEAD}`, "verdict: convinced", "**Review of #7021 at `7311face`"].join("\n");
  assert.equal(outsideVerdictBlock(open, 7021), null, "a block that never closes");
  assert.equal(outsideVerdictBlock(verdictPane(7022), 7021), null, "another pull request's block");
  assert.equal(outsideVerdictBlock(`BEGIN REVIEW VERDICT #7023 at ${HEAD}\nverdict: convinced\nEND REVIEW VERDICT #7023`, 7023), null, "no body");
  assert.equal(outsideVerdictBlock(verdictPane(7024).replace("verdict: convinced", "verdict: maybe"), 7024), null, "a verdict word that is neither");
  assert.equal(outsideVerdictBlock(`BEGIN REVIEW VERDICT #7025 at 1234\nverdict: convinced\nbody\nEND REVIEW VERDICT #7025`, 7025), null, "a head that is not forty hex digits");
  assert.equal(outsideVerdictBlock(null, 7025), null, "a pane that cannot be read");
});

test("#1311: the door is run with the verdict file, the pull request number and the word, with the reviewer's identity, and the file is removed", () => {
  const seen: { file: string; args: string[]; env: Record<string, string>; body: string; }[] = [];
  const door: DoorRun = (file, args, env) => { seen.push({ file, args, env, body: readFileSync(args[2], "utf8") }); };
  const verdict = outsideVerdictBlock(verdictPane(7030), 7030)!;
  const env = reviewerEnvironment("reviewer-7030");
  assert.deepEqual(postOutsideVerdict({ pr: 7030, verdict, env, door: "/door/pr-review-verdict", run: door }), { posted: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].file, "/door/pr-review-verdict");
  assert.deepEqual(seen[0].args.slice(0, 2), ["7030", "convinced"]);
  assert.equal(seen[0].body, `${verdict.body}\n`);
  assert.equal(seen[0].env.GH_CONFIG_DIR, REVIEWER_GH_CONFIG_DIR, "the door is the reviewer's to post as");
  assert.equal(existsSync(seen[0].args[2]), false, "the verdict file is removed");
});

test("#1311: the door's exit 3 is a verdict already standing, so it reads as posted; any other failure is a refusal that names the door's exit", () => {
  const verdict = outsideVerdictBlock(verdictPane(7031), 7031)!;
  const standing: DoorRun = () => { throw Object.assign(new Error("standing"), { status: 3, stderr: "" }); };
  assert.deepEqual(postOutsideVerdict({ pr: 7031, verdict, env: {}, door: "d", run: standing }), { posted: true });
  const stale: DoorRun = () => { throw Object.assign(new Error("stale"), { status: 5, stderr: "head moved\nmore" }); };
  const refused = postOutsideVerdict({ pr: 7031, verdict, env: {}, door: "d", run: stale });
  assert.ok("refusal" in refused);
  assert.match(refused.refusal, /not posted \(door exit 5: head moved\)/);
});

test("#1311: the gate posts each outside verdict ONCE per head, and an unreadable pane posts nothing", () => {
  const seen: string[][] = [];
  const door: DoorRun = (_file, args) => { seen.push(args); };
  const env = (session: string) => reviewerEnvironment(session);
  const pane = verdictPane(7040);
  const first = postOutsideVerdicts({ outside: [{ session: "reviewer-7040", pr: 7040 }], read: () => pane, env, door: "d", run: door });
  assert.deepEqual(first, [`posted the convinced verdict for #7040 at ${HEAD8} from outside reviewer reviewer-7040`]);
  const again = postOutsideVerdicts({ outside: [{ session: "reviewer-7040", pr: 7040 }], read: () => pane, env, door: "d", run: door });
  assert.deepEqual(again, [], "the same block in the scrollback is not posted again");
  assert.equal(seen.length, 1);
  const unreadable = postOutsideVerdicts({ outside: [{ session: "reviewer-7041", pr: 7041 }], read: () => null, env, door: "d", run: door });
  assert.deepEqual(unreadable, []);
  assert.equal(seen.length, 1);
});

test("#1311: the gate reads ONLY the outside reviewers' panes, and posts their verdicts as the reviewer through the door", () => {
  const reads: string[] = [];
  const doorCalls: { args: string[]; env: Record<string, string>; body: string; }[] = [];
  const run = (args: string[]) => {
    if (args.includes("read")) {
      const label = args[args.indexOf("read") + 1];
      reads.push(label);
      return verdictPane(7002);
    }
    return "{}";
  };
  const door: DoorRun = (_file, args, env) => { doorCalls.push({ args, env, body: readFileSync(args[2], "utf8") }); };
  const registry = {
    "reviewer-7002": { spawnedAt: 1, trust: OUTSIDE as ReviewTrust },
    "reviewer-2398": { spawnedAt: 1, trust: INSIDE as ReviewTrust },
    "reviewer-2399": { spawnedAt: 1 },
  };
  const lines = postOutsideVerdictsOf(registry, run, door);
  assert.deepEqual(reads, ["reviewer-7002"], "an inside reviewer's pane is never read by the outside pass");
  assert.equal(doorCalls.length, 1);
  assert.deepEqual(doorCalls[0].args.slice(0, 2), ["7002", "convinced"]);
  assert.equal(doorCalls[0].env.GH_CONFIG_DIR, REVIEWER_GH_CONFIG_DIR);
  assert.equal(doorCalls[0].body, `**Review of #7002 at \`${HEAD8}\`\nAcceptance: read, not run.\n`);
  assert.deepEqual(lines, [`posted the convinced verdict for #7002 at ${HEAD8} from outside reviewer reviewer-7002`]);
});
