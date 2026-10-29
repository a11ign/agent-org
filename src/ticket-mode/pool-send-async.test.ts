// no-token: gh -- herdr is injected; nothing is spawned
// A11-282: a prompt to a run's agent is asked of herdr without holding the loop. It reaches the same pane, answers null when herdr took it and herdr's reason when it did not, and a run with no pane is found by herdr's listing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFixture } from "./pool-fixture.ts";
import { newPoolContext } from "./pool-context.ts";
import { agentTargetAsync, sendToAgentAsync } from "./pool-resume.ts";
import type { PoolDeps } from "./pool-context.ts";

const NEVER_USED = { assigned: async () => [], read: async () => { throw new Error("unused"); }, download: async () => [] };
const LISTING = JSON.stringify({ result: { workspaces: [{ label: "t-nbf-1", workspace_id: "w7", agent_status: "idle" }] } });

/** A context whose herdr, synchronous or asynchronous, is the given function, recording every call each was asked. */
function contextOver(answer: (args: string[]) => Promise<string>) {
  const made = poolFixture();
  const sync: string[][] = [];
  const asked: string[][] = [];
  const herdrAsync: NonNullable<PoolDeps["herdrAsync"]> = (args) => { asked.push(args); return answer(args); };
  const ctx = newPoolContext(made.store, { settings: made.settings, source: NEVER_USED, codeHost: {} as never, hook: { node: "n", bin: "b" }, herdr: (args) => { sync.push(args); return "{}"; }, herdrAsync });
  return { ctx, sync, asked };
}

test("A11-282: a prompt to a run with a pane is asked of herdr through the async seam, in the board's session, and answers null", async () => {
  const { ctx, sync, asked } = contextOver(async () => "{}");
  assert.equal(await sendToAgentAsync(ctx, { name: "t-nbf-1", pane: "w7:p1" }, "carry on"), null);
  assert.deepEqual(asked, [["--session", "tickets", "agent", "prompt", "w7:p1", "carry on"]]);
  assert.deepEqual(sync, [], "nothing is asked of the synchronous call that holds the board thread");
});

test("A11-282: a run with no pane is found by herdr's listing, and the prompt goes to the root pane of its workspace", async () => {
  const { ctx, sync, asked } = contextOver(async (args) => (args.includes("list") ? LISTING : "{}"));
  assert.equal(await agentTargetAsync(ctx, { name: "t-nbf-1", pane: undefined }), "w7:p1");
  assert.equal(await sendToAgentAsync(ctx, { name: "t-nbf-1", pane: undefined }, "carry on"), null);
  assert.deepEqual(asked.at(-1), ["--session", "tickets", "agent", "prompt", "w7:p1", "carry on"]);
  assert.deepEqual(sync, []);
});

test("A11-282: a prompt herdr refuses answers herdr's reason, never throws", async () => {
  const { ctx } = contextOver(async () => { throw Object.assign(new Error("herdr exited 1"), { stderr: "the pane is busy\n" }); });
  const reason = await sendToAgentAsync(ctx, { name: "t-nbf-1", pane: "w7:p1" }, "carry on");
  assert.match(reason ?? "", /the pane is busy/);
});

test("A11-282: a run herdr lists no workspace for answers why it has no pane to reach, never throws", async () => {
  const { ctx, asked } = contextOver(async (args) => (args.includes("list") ? JSON.stringify({ result: { workspaces: [] } }) : "{}"));
  const reason = await sendToAgentAsync(ctx, { name: "t-nbf-1", pane: undefined }, "carry on");
  assert.match(reason ?? "", /herdr lists no workspace for t-nbf-1/);
  assert.equal(asked.some((args) => args.includes("prompt")), false, "nothing is sent to a pane that was not found");
});
