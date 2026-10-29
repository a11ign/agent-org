// no-token: none -- herdr, git and the clock are all injected; nothing is spawned
//
// A11-241: A LONG REPOSITORY KEY MAKES A SEAT LABEL HERDR WILL NOT TAKE AS AN AGENT NAME. `reviewer-announcement-emulator-11` is 33 characters and herdr 0.9.3 refuses an agent name over 32, so the
// reviewer for announcement-emulator#11 never started. The workspace keeps the full label (herdr does not limit it) and the agent is named by `herdrAgentName`, in the start and in the prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../../src/plugins/fakes/code-host.ts";
import type { CodeHost } from "../../src/plugins/contracts/code-host.ts";
import { HERDR_AGENT_NAME, herdrAgentName } from "../../src/herdr-agents.ts";
import { reviewingHelpers } from "../../src/plugins/reviewing-helpers.ts";
import { REPO } from "../../src/project-identity.ts";
import { loadReviewerGate } from "../../src/ticket-mode/reviewer-port.ts";
import { atomicReviewerPort } from "./port.ts";

const OWNER = REPO.split("/")[0];
const LABEL = "reviewer-announcement-emulator-11";
const PR_URL = `https://github.com/${OWNER}/announcement-emulator/pull/11`;

/** A code host that holds the pull request ready, green and inside the org, at head `h1`, and keeps the head's review claims, so the reviewer's claim is on the head after it is written. */
function hostWithPull(): CodeHost {
  const host = createFakeCodeHost("worker-bot");
  host.seedPull(`${OWNER}/announcement-emulator`, 11, { head: "h1", state: "open", trust: "inside", settled: true, reviews: [] });
  const entries: { id: number; description: string; created: number }[] = [];
  return {
    ...host,
    readReviewClaims: async () => ({ entries }),
    writeReviewClaim: async ({ description }) => { entries.push({ id: entries.length + 1, description, created: Date.now() }); return null; },
  };
}

/** A herdr that opens workspaces, starts agents and lists the workspaces `listed` holds by label. `refuse` makes `agent start` fail the way herdr does: its answer on stdout, a bare line on stderr. */
function herdr(listed: Map<string, string>, refuse?: string) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args.includes("create")) return JSON.stringify({ result: { root_pane: { pane_id: "w1:p1" }, workspace: { workspace_id: "w1" } } });
    if (args.includes("start") && refuse !== undefined) throw Object.assign(new Error("Command failed: herdr agent start"), { stdout: JSON.stringify({ error: { message: refuse } }), stderr: "" });
    if (args.includes("workspace") && args.includes("list")) return JSON.stringify({ result: { workspaces: [...listed].map(([label, status]) => ({ label, workspace_id: "w1", agent_status: status })) } });
    return JSON.stringify({ type: "ok" });
  };
  return { run, calls };
}

function portOver(run: (args: string[]) => string) {
  const codeHost = hostWithPull();
  const helpers = reviewingHelpers({ session: "tickets", run, runAsync: async (args) => run(args), codeHost: () => codeHost, clones: { "announcement-emulator": "/repos/announcement-emulator" }, instance: "work", heads: new Map() });
  return atomicReviewerPort(helpers, { mint: async () => null, checkout: async () => ({ path: "/work/pr-11", head: "h1" }) });
}

test("A11-241: the reviewer for announcement-emulator#11 keeps the full workspace label, starts and prompts one agent name within herdr's limit, and is live under the full label", async () => {
  await loadReviewerGate();
  const listed = new Map<string, string>();
  const herd = herdr(listed);
  const port = portOver(herd.run);
  assert.equal(LABEL.length, 33, "the seat's label is the one herdr refuses as an agent name");
  assert.deepEqual(await port.start({ pr: PR_URL, head: "h1" }), { label: LABEL });
  const create = herd.calls.find((args) => args.includes("create"))!;
  assert.equal(create[create.indexOf("--label") + 1], LABEL, "the workspace is labelled with the full name");
  const start = herd.calls.find((args) => args.includes("start"))!;
  const prompt = herd.calls.find((args) => args.includes("prompt"))!;
  const name = start[start.indexOf("start") + 1];
  assert.match(name, HERDR_AGENT_NAME);
  assert.equal(name, herdrAgentName(LABEL));
  assert.equal(prompt[prompt.indexOf("prompt") + 1], name, "the prompt goes to the agent that was started");
  assert.equal(await port.live({ pr: PR_URL, head: "h1" }), false, "not live until herdr lists its workspace");
  listed.set(LABEL, "working");
  assert.equal(await port.live({ pr: PR_URL, head: "h1" }), true, "live from a listing under the full label");
});

test("A11-241: herdr's refusal of the start, answered on stdout, reaches the start's refusal with herdr's message", async () => {
  await loadReviewerGate();
  const reason = "invalid_agent_name: agent name must start with a lowercase letter";
  const herd = herdr(new Map(), reason);
  const port = portOver(herd.run);
  const started = await port.start({ pr: PR_URL, head: "h1" });
  assert.ok("refusal" in started && started.refusal.includes(reason), JSON.stringify(started));
});

test("A11-241: a blocked reviewer with a long label has its pane read and its trust dialog answered through the short name", async () => {
  await loadReviewerGate();
  const root = "/repos/announcement-emulator";
  const pane = `\n  Trust this folder? Codex can read, edit, and run files here. Trusting will apply to the repository root: ${root}\n\n› 1. Trust and continue\n  2. Don't trust\n\n  Press enter to continue\n`;
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args.includes("read")) return pane;
    if (args.includes("workspace") && args.includes("list")) return JSON.stringify({ result: { workspaces: [{ label: LABEL, workspace_id: "w1", agent_status: "blocked" }] } });
    return JSON.stringify({ type: "ok" });
  };
  const codeHost = hostWithPull();
  const helpers = reviewingHelpers({ session: "tickets", run, runAsync: async (args) => run(args), codeHost: () => codeHost, clones: { "announcement-emulator": root }, instance: "work", heads: new Map([[LABEL, "h1"]]) });
  const port = atomicReviewerPort(helpers, { codexTrust: { rootOf: async () => root, ensure: (trusted) => ({ kind: "present", root: trusted, file: "config.toml", level: "trusted" }), log: () => {} } });
  const answer = await port.unblock!({ pr: PR_URL, head: "h1" });
  assert.ok(answer !== null && "answered" in answer, JSON.stringify(answer));
  const name = herdrAgentName(LABEL);
  assert.deepEqual(calls.find((args) => args.includes("read")), ["--session", "tickets", "agent", "read", name, "--source", "visible"]);
  assert.deepEqual(calls.find((args) => args.includes("send-keys")), ["--session", "tickets", "agent", "send-keys", name, "enter"]);
});
