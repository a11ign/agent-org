// no-token: none -- the gate, herdr, `gh` and the code host are fakes: nothing is spawned, no checkout is made, and nothing reaches GitHub
//
// THE REVIEWER CONTRACT'S SUITE, RUN ON THE ATOMIC PLUGIN (A11-161, Decision 11 of A11-157): `runReviewerConformance` is the only definition of "a reviewer", so the plugin passes the same checks the fake does,
// as `create` builds it: over `deps.reviewing` seams that are a fake herdr, a fake gate and a fake code host, so the suite starts, closes and retires a reviewer in a sandbox. The gate's real modules are
// the port's own tests' (`port.test.ts`); here the gate is what core hands the plugin, and the plugin is held to the contract it implements.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runReviewerConformance } from "../../src/plugins/conformance/reviewer.ts";
import { ContractError } from "../../src/plugins/conformance/suite.ts";
import { createFakeCodeHost } from "../../src/plugins/fakes/code-host.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import type { PluginDeps, ReviewerGate, ReviewerHelpers } from "../../src/plugins/manifest.ts";
import { reviewingHelpers } from "../../src/plugins/reviewing-helpers.ts";
import { create } from "./index.ts";

const REPO = "owner/repo";
const PR = `https://github.com/${REPO}/pull/7`;
const HEAD = "h1";

/** A herdr that lists each label in `listed` as an agent, and opens and closes workspaces: the sandbox the suite starts a reviewer in. */
function herdr(listed: Map<string, string>) {
  return (args: string[]): string => {
    if (args.includes("agent") && args.includes("list")) return JSON.stringify({ result: { agents: [...listed].map(([label]) => ({ name: null, workspace_id: `w${label.replace(/\D/g, "")}`, agent_session: { value: `session-${label}` } })) } });
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: [...listed].map(([label, status]) => ({ label, workspace_id: `w${label.replace(/\D/g, "")}`, agent_status: status })) } });
    return JSON.stringify({ type: "ok" });
  };
}

/** The gate as a fake: a reviewer that is spawned into `listed`, a checkout that is never made, and a door that is never run. */
function fakeGate(listed: Map<string, string>): ReviewerGate {
  return {
    wake: {
      spawnReviewer: (order: { session: string }) => { listed.set(order.session, "idle"); return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }; },
      prepareReviewCheckout: () => ({ path: "/nowhere/pr-7", head: HEAD }),
      removeReviewCheckout: () => null,
      uncommittedPathsOf: () => [],
      reviewCheckoutPath: (label: string) => `/nowhere/${label}`,
      closeReviewer: (label: string) => { listed.delete(label); return true; },
      reviewerEnvironment: () => ({}),
      reviewerTokenMinter: () => () => null,
      reviewerAppOf: () => ({}),
    },
    trust: { INSIDE: "inside", runDoor: () => undefined },
    config: { homeProjectDeclaration: () => ({ code: [] }) },
    identity: { REPO },
    orders: { awaitingVerdictPrompt: () => "the verdict prompt", reviewHeadsOf: () => [], reviewerRoleFile: () => ".agent-org/roles/reviewer.md" },
    doorPath: { reviewerDoorPath: () => "/nowhere/door" },
    host: { HOST_CONFIG_ENV: "AGENT_ORG_HOST", hostConfigPath: () => "/nowhere/host.json" },
  } as unknown as ReviewerGate;
}

/** `deps.reviewing` over the fakes: core's own helpers for what a plugin only calls (seat names, the herdr listing, claims), the fake gate, and the board's collaborators as fakes. */
function helpersOver({ refusal = null }: { refusal?: string | null } = {}): { reviewing: ReviewerHelpers; listed: Map<string, string> } {
  const listed = new Map<string, string>();
  const host = createFakeCodeHost();
  host.seedPull(REPO, 7, { head: HEAD, settled: true, trust: "inside" });
  const real = reviewingHelpers({ session: "tickets", run: herdr(listed), codeHost: () => host, clones: {}, instance: "work", heads: new Map<string, string>() });
  const loaded = { current: false };
  return { listed, reviewing: { loadGate: async () => { loaded.current = true; }, gateRefusal: () => { if (!loaded.current) throw new Error("the gate is not loaded"); return refusal; }, gate: () => fakeGate(listed),
    board: () => real.board() } };
}

const depsOver = (reviewing: ReviewerHelpers): PluginDeps => fakePluginDeps({ reviewing });

test("the atomic reviewer passes the reviewer contract suite, as create builds it over a fake gate, herdr and code host, and every check ran", async () => {
  const { reviewing, listed } = helpersOver();
  const { passed, skipped } = await runReviewerConformance(create({}, depsOver(reviewing)), { ref: { pr: PR, head: HEAD } });
  assert.deepEqual(skipped, []);
  assert.equal(passed.length, 9);
  for (const check of ["load resolves and refusal says why it cannot start, or null", "start answers a label, or a refusal naming why", "retire answers retired, or a refusal, and lists the pull request no more"]) assert.ok(passed.includes(check), check);
  assert.equal(listed.size, 0, "the suite retired what it started");
});

test("a reviewer whose gate does not load says why in refusal() and refuses start, and every other call answers as an empty session would: nothing throws the gate's own exception", async () => {
  const { reviewing } = helpersOver({ refusal: "/.agent-org/project.json: the declaration cannot be read" });
  const reviewer = create({}, depsOver(reviewing));
  const { passed } = await runReviewerConformance(reviewer, { ref: { pr: PR, head: HEAD } });
  assert.ok(passed.includes("start answers a label, or a refusal naming why"));
  await reviewer.load();
  assert.equal(reviewer.refusal(), "/.agent-org/project.json: the declaration cannot be read");
  const started = reviewer.start({ pr: PR, head: HEAD });
  assert.ok("refusal" in started && /the reviewer's gate does not load on this host: .*declaration cannot be read/.test(started.refusal));
  assert.deepEqual([reviewer.live({ pr: PR, head: HEAD }), reviewer.listedPulls(), reviewer.settled({ pr: PR, head: HEAD }), reviewer.verdictFileOf({ pr: PR, head: HEAD })], [false, [], "gone", null]);
  assert.deepEqual(reviewer.repostVerdict({ pr: PR, head: HEAD }, "/v.md"), { refusal: `no reviewer for ${PR}: the reviewer's gate does not load on this host: /.agent-org/project.json: the declaration cannot be read`, final: true });
});

test("a reviewer that ignores its refusal and starts anyway fails the suite by name", async () => {
  const { reviewing } = helpersOver({ refusal: "no primary" });
  const reviewer = create({}, depsOver(reviewing));
  const starting = { ...reviewer, start: () => ({ label: "reviewer-7" }) };
  await assert.rejects(runReviewerConformance(starting, { ref: { pr: PR, head: HEAD } }), (error: unknown) => error instanceof ContractError && error.concern === "reviewer"
    && error.failures.map(({ check }) => check).includes("start answers a label, or a refusal naming why"));
});
