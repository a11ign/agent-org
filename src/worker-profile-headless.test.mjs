// #4075 (#4055 move 9): a worker as `claude -p` over stream-json is a SECOND launch form, off by default. Run with
// `AGENT_ORG_HOST=<checkout>/.agent-org/host.json node --test src/worker-profile-headless.test.mjs`.
// Each claim below carries a positive control and a negative one, so none of them is an emptiness assertion that
// passes because nothing was looked at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentArgs, PROFILES, profileFor, PER_ROW_DISALLOWED_TOOLS, WORKER_SETTINGS_PATH, AUTOCOMPACT_WINDOW_TOKENS }
  from "./worker-profile.mjs";

const CLAUDE = { kind: "claude", model: "sonnet", effort: "high" };
const CAPS = { maxTurns: 40, maxBudgetUsd: 2.5 };
const PANE_ONLY = ["--dangerously-skip-permissions", "--autocompact"];

/** The pane form exactly as it stood before #4075, written out so a change to it cannot also change this. */
const PANE_FORM_BEFORE = ["--model", "sonnet", "--effort", "high", "--dangerously-skip-permissions",
  "--disallowedTools", PER_ROW_DISALLOWED_TOOLS.join(","), "--autocompact", String(AUTOCOMPACT_WINDOW_TOKENS),
  "--settings", WORKER_SETTINGS_PATH];

const headless = () => agentArgs(CLAUDE, { headless: CAPS });
const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test("flag OFF: the launch arguments are byte-identical to today's, with or without an empty launch", () => {
  assert.deepEqual(agentArgs(CLAUDE), PANE_FORM_BEFORE);
  assert.deepEqual(agentArgs(CLAUDE, {}), PANE_FORM_BEFORE);
  assert.equal(agentArgs(CLAUDE).join("\0"), PANE_FORM_BEFORE.join("\0"));
  // negative control: the comparison CAN fail, because flag ON is not the pane form.
  assert.notDeepEqual(headless(), PANE_FORM_BEFORE);
});

test("flag OFF: the codex arguments are untouched as well", () => {
  const codex = { kind: "codex", model: "gpt-5.6-luna", effort: "medium" };
  assert.deepEqual(agentArgs(codex, {}), ["-m", "gpt-5.6-luna", "-c", 'model_reasoning_effort="medium"',
    "-c", 'approval_policy="never"', "-c", 'sandbox_mode="workspace-write"']);
});

test("flag ON: the arguments carry the caps and the output format", () => {
  const args = headless();
  assert.equal(args[0], "-p");
  assert.equal(valueAfter(args, "--input-format"), "stream-json");
  assert.equal(valueAfter(args, "--output-format"), "stream-json");
  assert.ok(args.includes("--verbose"), "the CLI refuses stream-json output under -p without --verbose");
  assert.equal(valueAfter(args, "--max-turns"), "40");
  assert.equal(valueAfter(args, "--max-budget-usd"), "2.5");
  assert.equal(valueAfter(args, "--permission-prompts"), "none");
  assert.equal(valueAfter(args, "--model"), "sonnet");
  assert.equal(valueAfter(args, "--effort"), "high");
  // the caps are the caller's, not a default: other numbers come out as other numbers.
  assert.equal(valueAfter(agentArgs(CLAUDE, { headless: { maxTurns: 7, maxBudgetUsd: 0.5 } }), "--max-turns"), "7");
  // negative control: the pane form carries none of these.
  for (const flag of ["-p", "--max-turns", "--max-budget-usd", "--output-format", "--permission-prompts"]) {
    assert.ok(!PANE_FORM_BEFORE.includes(flag), `${flag} is a headless-only flag`);
  }
});

test("flag ON: nothing the pane form needs is carried", () => {
  for (const flag of PANE_ONLY) {
    assert.ok(PANE_FORM_BEFORE.includes(flag), `positive control: the pane form carries ${flag}`);
    assert.ok(!headless().includes(flag), `headless must not carry ${flag}`);
  }
});

test("flag ON keeps the token levers that are not pane-shaped (#2750)", () => {
  assert.equal(valueAfter(headless(), "--disallowedTools"), PER_ROW_DISALLOWED_TOOLS.join(","));
  assert.equal(valueAfter(headless(), "--settings"), WORKER_SETTINGS_PATH);
});

test("flag ON refuses what it cannot launch: codex, a missing cap, a cap that is not a positive number", () => {
  const refuses = (profile, headlessCaps) => assert.throws(() => agentArgs(profile, { headless: headlessCaps }));
  refuses({ kind: "codex", model: "gpt-5.6-luna", effort: "medium" }, CAPS);
  refuses(CLAUDE, { maxTurns: 40 });
  refuses(CLAUDE, { maxBudgetUsd: 2.5 });
  refuses(CLAUDE, { maxTurns: 0, maxBudgetUsd: 2.5 });
  refuses(CLAUDE, { maxTurns: 40, maxBudgetUsd: -1 });
  refuses(CLAUDE, { maxTurns: 4.5, maxBudgetUsd: 2.5 });
  refuses(CLAUDE, { maxTurns: Number.NaN, maxBudgetUsd: 2.5 });
  assert.doesNotThrow(() => headless()); // positive control: the same call with valid caps launches
});

test("the flag is OFF by default: no profile carries it, and no cause turns it on", () => {
  const causes = Object.keys(PROFILES);
  assert.ok(causes.length > 0, "positive control: there are causes to look at");
  for (const cause of causes) {
    assert.ok(!("headless" in PROFILES[cause]), `${cause} carries a headless setting`);
    const got = profileFor(cause);
    if (got.kind === "claude") assert.ok(!agentArgs(got).includes("-p"), `${cause} launches headless`);
  }
});

// SELF: this file and worker-profile.mjs itself spell `headless:` on purpose; every OTHER module that does is a caller
// turning the form on, which is the row that follows this one and not this one.
const SELF = new Set(["worker-profile.mjs", "worker-profile-headless.test.mjs"]);
const TURNS_IT_ON = /agentArgs\([^)]*headless\s*:/;

function callersTurningItOn(files) {
  return files.filter(({ name, text }) => !SELF.has(name) && TURNS_IT_ON.test(text)).map(({ name }) => name);
}

test("the flag is OFF by default: no module in src/ calls agentArgs with headless", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const files = readdirSync(dir).filter((n) => n.endsWith(".mjs"))
    .map((name) => ({ name, text: readFileSync(new URL(name, import.meta.url), "utf8") }));
  assert.ok(files.length > 50, "positive control: the scan read the src/ modules");
  assert.deepEqual(callersTurningItOn(files), []);
  // positive control for the marker itself: it notices a caller that does turn it on.
  assert.deepEqual(callersTurningItOn([{ name: "x.mjs", text: "agentArgs(p, { headless: caps })" }]), ["x.mjs"]);
  assert.deepEqual(callersTurningItOn([{ name: "x.mjs", text: "agentArgs(p)" }]), []);
});
