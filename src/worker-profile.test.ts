// #4738: the window rungs and the Haiku clamp, and that a route's window reaches the agent as `--autocompact`. Pure: no network, no clock, no files.
// no-token: gh -- nothing here calls `gh`
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentArgs, AUTOCOMPACT_WINDOW_TOKENS, clampWindow, HAIKU_AUTOCOMPACT_WINDOW_TOKENS, HAIKU_MODEL_ID, LARGE_WINDOW_TOKENS, LARGEST_WINDOW_TOKENS, ordinaryTierProfile, profileFor,
  SONNET_WINDOW_RUNGS, windowCeiling,
} from "./worker-profile.ts";

const AT = (args: string[]): number => Number(args[args.indexOf("--autocompact") + 1]);

test("the Sonnet rungs start at today's window and rise: 200k, 400k, 600k", () => {
  assert.deepEqual([...SONNET_WINDOW_RUNGS], [AUTOCOMPACT_WINDOW_TOKENS, LARGE_WINDOW_TOKENS, LARGEST_WINDOW_TOKENS]);
  assert.deepEqual([AUTOCOMPACT_WINDOW_TOKENS, LARGE_WINDOW_TOKENS, LARGEST_WINDOW_TOKENS], [200_000, 400_000, 600_000]);
});

test("clampWindow: a Haiku model never exceeds its prompt ceiling, whatever it is offered, and a Sonnet model is held only at the largest rung", () => {
  for (const offered of [LARGE_WINDOW_TOKENS, LARGEST_WINDOW_TOKENS, 10_000_000]) assert.equal(clampWindow(HAIKU_MODEL_ID, offered), HAIKU_AUTOCOMPACT_WINDOW_TOKENS);
  assert.equal(clampWindow("haiku", LARGE_WINDOW_TOKENS), HAIKU_AUTOCOMPACT_WINDOW_TOKENS, "an alias is a Haiku model too");
  assert.equal(clampWindow("sonnet", LARGE_WINDOW_TOKENS), LARGE_WINDOW_TOKENS, "the control: the clamp does not touch a Sonnet window below its ceiling");
  assert.equal(clampWindow("sonnet", 10_000_000), LARGEST_WINDOW_TOKENS);
  assert.equal(windowCeiling(HAIKU_MODEL_ID), HAIKU_AUTOCOMPACT_WINDOW_TOKENS);
  assert.equal(clampWindow(HAIKU_MODEL_ID, 50_000), 50_000, "and a window already under the ceiling is left");
});

test("ordinaryTierProfile is the ordinary worker's model and effort at the window asked, and reaches the agent as `--autocompact`", () => {
  const ordinary = profileFor("ready-row-unclaimed");
  assert.ok(!("refusal" in ordinary));
  const profile = ordinaryTierProfile({ autocompactWindow: LARGE_WINDOW_TOKENS, why: "x" });
  assert.deepEqual([profile.kind, profile.model, profile.effort, profile.autocompactWindow], ["claude", ordinary.model, ordinary.effort, LARGE_WINDOW_TOKENS]);
  assert.equal(AT(agentArgs(profile)), LARGE_WINDOW_TOKENS);
  assert.equal(AT(agentArgs(ordinary)), AUTOCOMPACT_WINDOW_TOKENS, "the control: a profile with no window still starts at the ordinary one");
});
