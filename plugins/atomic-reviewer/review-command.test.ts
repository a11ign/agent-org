// no-token: gh -- the reviewer port and the pull request's state are injected; nothing starts and nothing reaches GitHub or herdr.
//
// `ticket:review` WITH THE ATOMIC REVIEWER (A11-161): the start of a reviewer for a repository the host clones, and the claim on a head, driven through `reviewOnDemand` over the plugin's real port, which
// core's own tests do not build. The gate's modules are loaded for real, and herdr, `gh` and the code host are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../../src/plugins/fakes/code-host.ts";
import type { CodeHost, ReviewState } from "../../src/plugins/contracts/code-host.ts";
import type { ReviewerPort } from "../../src/plugins/contracts/reviewer.ts";
import { reviewingHelpers } from "../../src/plugins/reviewing-helpers.ts";
import { reviewOnDemand } from "../../src/ticket-mode/review-command.ts";
import { loadReviewerGate } from "../../src/ticket-mode/reviewer-port.ts";
import { atomicReviewerPort as portOver, type Seams } from "./port.ts";

const PLUGIN = "https://github.com/a11ign/plugin/pull/7";
const HEAD = "3aeaba9bd".padEnd(40, "0");

/** The code host the reviewer port reads the plugin's pull request through: open at `HEAD`, its author the org's own, and its checks settled green. */
function pluginPull() {
  const host = createFakeCodeHost();
  host.seedPull("a11ign/plugin", 7, { head: HEAD, trust: "inside", settled: true });
  return host;
}

/** The pull request as `readState` reads it at `head`, with `reviews` on it. */
const stateAt = (head: string, reviews: ReviewState["reviews"] = []) => ({ head, reviews, settled: true, trust: "INSIDE", view: {} }) as unknown as ReviewState;

type PortOptions = Seams & Readonly<{ session: string; run: (args: string[]) => string; gh: (args: string[]) => string; codeHost: CodeHost; heads?: Map<string, string>; clones?: Record<string, string>; instance: string }>;

/** The port the board makes: over the real helpers of core, with the board's collaborators these options name. */
function atomicReviewerPort({ session, run, gh, codeHost, heads = new Map<string, string>(), clones = {}, instance, ...seams }: PortOptions): ReviewerPort {
  return portOver(reviewingHelpers({ session, run, gh, codeHost: () => codeHost, clones, instance, heads }), seams);
}

test("ticket:review starts the reviewer for a repository the host clones and the project does not declare, with no entry in project.json", async () => {
  await loadReviewerGate();
  // The pull request, and the head's statuses: a claim is read and written as one tab-separated line per status, as `claimEntriesOf` reads them.
  const statuses: string[] = [];
  const gh = (args: string[]) => {
    if (args.some((arg) => arg.includes("/statuses"))) {
      if (!args.includes("POST")) return statuses.join("");
      statuses.push(`${statuses.length + 1}\t${new Date().toISOString()}\t${args.find((arg) => arg.startsWith("description="))!.slice("description=".length)}\n`);
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const port = atomicReviewerPort({ session: "tickets", instance: "work", run: () => JSON.stringify({ result: { agents: [], workspaces: [] } }), gh, claimGh: () => gh, mint: () => null, codeHost: pluginPull(),
    clones: { plugin: "/repos/plugin" }, checkout: () => ({ path: "/work/pr-7", head: HEAD }), spawn: (order) => ({ label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }) });
  const r = reviewOnDemand({ url: "https://github.com/a11ign/plugin/pull/7", port, readState: () => stateAt(HEAD), started: new Set(), record: () => {} });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /started reviewer-plugin-7 for .*a11ign\/plugin\/pull\/7 at 3aeaba9b/);
});

/**
 * A port over a `gh` that holds `claim` on the head (a status line under the claim's context, as `claimEntriesOf` reads it) and answers the pull request
 * as `HEAD` with green checks, the way the tickets' reviewer reads it. A claim written through `claimGh` lands on the same statuses.
 */
function portHolding(statuses: string[], spawned: string[]) {
  const gh = (args: string[]) => {
    if (args.some((arg) => arg.includes("/statuses"))) {
      if (!args.includes("POST")) return statuses.join("");
      statuses.push(`${statuses.length + 1}\t${new Date().toISOString()}\t${args.find((arg) => arg.startsWith("description="))!.slice("description=".length)}\n`);
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return atomicReviewerPort({ session: "tickets", instance: "work", run: () => JSON.stringify({ result: { agents: [], workspaces: [] } }), gh, claimGh: () => gh, mint: () => null, codeHost: pluginPull(),
    clones: { plugin: "/repos/plugin" }, checkout: () => ({ path: "/work/pr-7", head: HEAD }), spawn: (order) => { spawned.push(order.session); return { label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }; } });
}

/** `ticket:review` for the plugin's pull request, with a claim by `instance` written `minutesOld` minutes ago on its head: what it answers, and what it started. */
async function reviewWithClaimBy(instance: string, minutesOld: number) {
  await loadReviewerGate();
  const spawned: string[] = [];
  const since = new Date(Date.now() - minutesOld * 60_000).toISOString();
  const r = reviewOnDemand({ url: PLUGIN, port: portHolding([`1\t${since}\tclaimed by ${instance} at ${since}, lease 60 min\n`], spawned), readState: () => stateAt(HEAD), started: new Set(), record: () => {} });
  return { r, spawned, since };
}

test("A11-149: ticket:review refuses a head another instance holds, names the holder, and starts nothing", async () => {
  const { r, spawned } = await reviewWithClaimBy("laptop", 5);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /another instance \(`laptop`\) holds the review of https:\/\/github\.com\/a11ign\/plugin\/pull\/7 at 3aeaba9b since /);
  assert.deepEqual(spawned, [], "no reviewer is started");
});

test("A11-149: ticket:review takes over a claim past its lease with no verdict, and says whose and how old", async () => {
  const { r, spawned } = await reviewWithClaimBy("laptop", 61);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /started reviewer-plugin-7 for .* at 3aeaba9b; took over the claim of laptop, 61 min old with no verdict; its verdict posts/);
  assert.deepEqual(spawned, ["reviewer-plugin-7"]);
});
