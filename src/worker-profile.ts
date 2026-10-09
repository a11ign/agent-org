#!/usr/bin/env node
// @ts-check
// command: worker-profile -- which model and effort a wake order's CAUSE deserves. Data, not judgment.
//
// The org ran six sessions on Opus at xhigh (the ceo on Fable at high) because nothing ever chose: the
// model and the effort were whatever the session happened to be started with, by hand, months ago. This
// is the table that chooses, keyed on `work-gate`'s `cause` -- a string derived from GitHub state by a
// script, so the choice costs no model turn. A router that had to think would rebuild the burn it exists
// to remove.
//
// THE POLICY IS NOT INVENTED HERE. `.claude/rules/agent-practices.md` already carries the chairman's
// routing rule, ruled for subagents and applied here unchanged to whole workers:
//
//   haiku  -- data gathering: file reads, counting, directory walks, grep, API listings
//   sonnet -- analysis and judgment over gathered material
//   opus   -- ONLY for multi-step reasoning that a cheaper tier has MEASURABLY got wrong
//
// So nothing below starts on Opus, and that is the policy's plain reading rather than a cost preference.
// The measurement the rule asks for does not exist yet for any of these causes: nobody has run a review
// or a row build on sonnet and recorded it failing. Until someone has, "opus by default" is the option
// the rule specifically refuses, and the same 30-day measurement it cites -- Opus carrying 66% of
// billable tokens with no routing rule anywhere -- is what that default already cost.
//
// ESCALATION IS EXPECTED, AND IS EVIDENCE, NOT PREFERENCE. When a cause is measurably beyond its tier,
// raise it HERE, in this table, with the run that showed it. That keeps the reason attached to the
// number. A session quietly restarted on a bigger model is how the org got back to Opus-everywhere with
// nobody able to say who decided it.
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync, readFileSync } from "node:fs";
import { LANE_PREFIX, NEEDS_CHAIRMAN_LABEL } from "./project-vocabulary.ts";
import { extractRegionSection } from "./region-paths.ts";
import { extractAcceptanceSection } from "./acceptance-commands.ts";
import { refuseUnknownFlags, flagValue } from "./lib/cli-flags.ts";
import { PROFILES } from "./cause-declaration.ts";

/** The effort levels the `claude` CLI accepts. A value outside this set is a typo, not a preference. */
export const CLAUDE_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/** `codex`'s `model_reasoning_effort`. A separate list because it is a separate product's knob. */
export const CODEX_EFFORTS = Object.freeze(["minimal", "low", "medium", "high"]);

/** The model aliases the `claude` CLI accepts. Full model IDs are allowed too; these are the shorthands. */
export const MODELS = Object.freeze(["haiku", "sonnet", "opus", "fable"]);

/**
 * THE CLAUDE MODELS THE ORG RUNS, and the effort the org depends on for each (#2783). Keyed by the alias `PROFILES` and
 * the host's `settings.json` `model` use; `id` is what a session's transcript records, which is how a live session is
 * checked against this table.
 *
 * WHY `effortLevel` IS DECLARED HERE. Claude Code's `modelSettings.<id>.effortLevel` in the host's
 * `~/.claude/settings.json` is per MODEL ID, so a model change silently drops effort to that model's default unless
 * somebody adds the entry. 2026-09-29: the chairman moved the org to `claude-sonnet-5-5` and added
 * `modelSettings.claude-sonnet-5-5.effortLevel: high` by hand -- host state no repo file recorded. `modelEffortDrift`
 * (host-units.ts) reads the host against this table. It is the FLOOR: the highest effort any `PROFILES` entry on the alias asks for.
 */
export const DECLARED_CLAUDE_MODELS = Object.freeze({
  sonnet: Object.freeze({ id: "claude-sonnet-5-5", effortLevel: "high" }),
});

/** Effort vocabulary per agent kind -- the two products do not share one. */
export const EFFORTS = Object.freeze({ claude: CLAUDE_EFFORTS, codex: CODEX_EFFORTS });

// #2717's REGRESSION (2026-09-28, worker-2623). THE WINDOW PASSED TO `--autocompact` IS NOT THE TRIGGER --
// Claude Code compacts roughly this far BELOW it. Measured directly: worker-2623's 139 auto-compactions
// against a 120,000 window all fired at preTokens 86k-94k, never at 120k itself. Rounded up from the
// worse (larger) margin observed, so a future measurement inside this range does not need a second fix.
export const AUTO_COMPACT_TRIGGER_MARGIN_TOKENS = 35_000;

// A FRESH per-row worker's own usage before it has done any work at all -- system prompt, tools,
// CLAUDE.md, the rules files this org loads on every wake. Measured on worker-2623's first turn: 62,861
// tokens. Rounded up, not trimmed to the exact reading: a rules file growing by a few hundred bytes
// should not silently eat back the margin this constant exists to hold.
export const MEASURED_FRESH_WORKER_BASE_TOKENS = 65_000;

// Real working room a row needs ABOVE that base before Claude Code's own compaction fires -- enough to
// read a large doc (ADR 0040, ~16k tokens) or a large module (layer-edges.mjs, ~11k) more than once in
// one turn without immediately re-triggering. #2717's original 120,000 window cleared the trigger margin
// and the base and left only ~22k here -- one such read away from the exact failure this constant now
// names: 139 compactions, 5.4 hours, an estimated $95-125, for a copied LICENSE file and one package.json
// field.
export const MIN_WORKING_ROOM_TOKENS = 100_000;

/**
 * The `--autocompact` window for a per-row Claude engineer, DERIVED rather than picked so the next
 * change to any of the three constants above re-lands this number rather than silently under-cutting it.
 * Still far below the 479k-615k peaks #2717 set out to cap in the first place (see `worker-profile.ts`'s
 * own history), so a genuinely runaway row still compacts before reaching them -- the margin and the
 * base are cleared FIRST, not assumed away.
 */
export const AUTOCOMPACT_WINDOW_TOKENS =
  AUTO_COMPACT_TRIGGER_MARGIN_TOKENS + MEASURED_FRESH_WORKER_BASE_TOKENS + MIN_WORKING_ROOM_TOKENS;

// --- THE HAIKU TIER, A TRIAL (a11ign/a11ign#4382, the chairman's spend direction of 2026-10-09, part 2) ---
//
// A row labelled `tier:haiku` gets a `claude-haiku-5-5` worker. THE ONE DESIGN FACT: Haiku 5.5 takes a prompt of at most
// 100,000 tokens (`PRICES` in `trace/store.mjs`: a request above it costs `null`, and the model refuses it), while the Sonnet
// window above is 200,000. `--autocompact` compacts about AUTO_COMPACT_TRIGGER_MARGIN_TOKENS below its window, so the Haiku
// window is the ceiling less a little headroom, PLUS that margin: the trigger lands at 95,000, inside the ceiling. A fresh
// worker's own base is MEASURED_FRESH_WORKER_BASE_TOKENS, which leaves about 30,000 of working room -- the shape of #2717's
// thrash -- and is why the tier is for rows small enough to finish in it, and why more than 10 compactions of one Haiku worker
// is a stop-rule hit on the row, not a number to tune.
export const HAIKU_TIER_LABEL = "tier:haiku";
export const HAIKU_MODEL_ID = "claude-haiku-5-5";
export const HAIKU_PROMPT_CEILING_TOKENS = 100_000;
export const HAIKU_TRIGGER_HEADROOM_TOKENS = 5_000;
export const HAIKU_AUTOCOMPACT_WINDOW_TOKENS =
  HAIKU_PROMPT_CEILING_TOKENS - HAIKU_TRIGGER_HEADROOM_TOKENS + AUTO_COMPACT_TRIGGER_MARGIN_TOKENS;

/** The switch `ceo` flips (and nothing else does): `{ "enabled": true }`. */
export const HAIKU_TIER_SWITCH_PATH = fileURLToPath(new URL("./haiku-tier.json", import.meta.url));

/** Labels a tier label never overrides: a tier lowers cost, never what a row is allowed to touch. */
const TIER_REFUSING_LABELS = Object.freeze([`${LANE_PREFIX}ceo`, NEEDS_CHAIRMAN_LABEL]);

/** What `--effort` a Haiku worker is started with: `high`, the same as the Sonnet workers, so the #4382 trial compares model against model. Low would confound it: a Haiku failure at low could not be told apart from the effort. Haiku output is cheap, so the extra thinking costs far less than one wrong PR. */
const HAIKU_EFFORT = "high";

export type TierProfile = { kind: "claude"; model: string; effort: string; why: string; autocompactWindow: number };

/**
 * The switch, read. A MISSING OR MALFORMED FILE IS `enabled: false`, with the reason: the tier fails SAFE to the ordinary (Sonnet) profile,
 * and the caller logs the reason so a deleted file is seen rather than silently turning a spend experiment off.
 * @param {string} [path]
 */
export function readHaikuSwitch(path: string = HAIKU_TIER_SWITCH_PATH): { enabled: true } | { enabled: false; reason: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { enabled: false, reason: `${path} is missing or unreadable (${(err as Error).message.split("\n")[0]})` };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.enabled === true) return { enabled: true };
    if (parsed?.enabled === false) return { enabled: false, reason: "the switch is off (enabled: false)" };
    return { enabled: false, reason: `${path} has no boolean "enabled"` };
  } catch (err) {
    return { enabled: false, reason: `${path} is not valid JSON (${(err as Error).message.split("\n")[0]})` };
  }
}

/** Why a labelled row still gets the ordinary profile, or `null` when nothing refuses it. */
function whyNotHaiku(row: { labels: readonly string[]; body: string }): string | null {
  const refusing = TIER_REFUSING_LABELS.find((label) => row.labels.includes(label));
  if (refusing !== undefined) return `the row carries ${refusing}`;
  if ((extractRegionSection(row.body) ?? "").includes(".github/workflows/")) return "its Region names .github/workflows/";
  if (extractAcceptanceSection(row.body).kind !== "commands") return "it has no Acceptance command";
  return null;
}

/**
 * The Haiku profile for a row, or `null` for the ordinary one. A row without the label returns `null` SILENTLY (the common case, byte-identical to before);
 * every other `null` is said through `log` with its reason.
 * @param {{ number: number, labels: readonly string[], body: string }} row
 * @param {{ switchPath?: string, log?: (line: string) => void }} [deps]
 */
export function haikuTierProfile(row: { number: number; labels: readonly string[]; body: string }, { switchPath = HAIKU_TIER_SWITCH_PATH, log = () => {} }: { switchPath?: string; log?: (line: string) => void } = {}): TierProfile | null {
  if (!row.labels.includes(HAIKU_TIER_LABEL)) return null;
  const switched = readHaikuSwitch(switchPath);
  const reason = switched.enabled ? whyNotHaiku(row) : switched.reason;
  if (reason !== null) {
    log(`worker-profile: #${row.number} is ${HAIKU_TIER_LABEL} but gets the ordinary profile: ${reason}`);
    return null;
  }
  return { kind: "claude", model: HAIKU_MODEL_ID, effort: HAIKU_EFFORT, autocompactWindow: HAIKU_AUTOCOMPACT_WINDOW_TOKENS,
    why: `${HAIKU_TIER_LABEL} trial (a11ign/a11ign#4382): a mechanical row with a command Acceptance, in about 30,000 tokens of working room` };
}

// #2750 (chairman's 2026-09-28 token-cost reading, ceo's ruling): FIVE MORE TOOLS a per-row Claude
// engineer never needs, disallowed the same way `AskUserQuestion` already is below. A bare tool name on
// `--disallowedTools` removes that tool's FULL DEFINITION from the system prompt, not merely its calls --
// measured directly: `AskUserQuestion` is disallowed and is absent from the 12 tools a fresh worker's
// first turn actually sends. `Artifact`/`SendFeedback`/`Workflow`/`ReportFindings` cost ~13k tokens
// between them (~$20/day across the org's own volume, 8,251 Claude calls in 24h at the $0.20/MTok
// cache-read proxy) and are never a row's job: publishing a page, feedback on Claude Code itself,
// orchestrating OTHER agents, and a code-review-specific report format, respectively -- none of it is
// what a row's Region/Acceptance/Done-when ever asks for. `ListAgents` is cut for the same reason: this
// org's inter-session channel is the GitHub row (labels, comments, `answer:<session>`), never live
// Claude-Code-to-Claude-Code messaging for a spawned worker, so the tool has nothing of this org's to
// list. `Agent` STAYS, deliberately: disallowing it would cut against `agent-practices.md`'s own routing
// rule (haiku to gather, sonnet to digest), which is a real remedy for the SAME reading's other finding --
// worker-2623 read `layer-edges.mjs` five times and ADR 0040 twice directly into its own context, growth a
// subagent read would not have cost the holding session.
export const PER_ROW_DISALLOWED_TOOLS =
  Object.freeze(["AskUserQuestion", "Artifact", "SendFeedback", "Workflow", "ReportFindings", "ListAgents"]);

/** `worker-settings.json`'s own absolute path, resolved from this file's rather than the caller's cwd. */
export const WORKER_SETTINGS_PATH = fileURLToPath(new URL("./worker-settings.json", import.meta.url));

/** The two prompt arms of the calm-finish A/B (#4070, #4055 move 2). */
export const ARM = Object.freeze({ CALM: "calm", CONTROL: "control" });

/**
 * THE ARM OF A NEW PER-ROW WORKER IS ITS ROW NUMBER'S PARITY: even is `calm`, odd is `control`. A rule that is data and cannot be gamed: the
 * number exists before the worker does, is fixed for the row, is unrelated to difficulty or lane, and is readable afterwards from the session
 * name (`worker-<row>`), so any record yields the arm with no field to lose and no randomness to reproduce. A respawn of the same row is the
 * same arm, which keeps a row's turns in one arm however many instances it took.
 * @param {number} row
 * @returns {"calm" | "control"}
 */
export function armOf(row: number): "calm" | "control" {
  return row % 2 === 0 ? ARM.CALM : ARM.CONTROL;
}

/** The two prompt arms of the round-trips A/B (#4182, #4055 next wave item 3). */
export const TRIPS_ARM = Object.freeze({ BATCHED: "batched", CONTROL: "control" });

/**
 * THE ROUND-TRIPS ARM OF A NEW PER-ROW WORKER IS THE SECOND BIT OF ITS ROW NUMBER: `batched` when `Math.floor(row / 2)` is even, `control` otherwise.
 * {@link armOf} already spends the first bit on the calm A/B, whose comparison is still running; reusing it would put this paragraph on exactly the
 * rows that carry the calm one and neither result could be read. Over any four consecutive row numbers each of the four cells (calm or control by
 * `armOf`, batched or control here) occurs once, so the two assignments are independent by construction, are fixed by the row, and are readable from
 * the session name (`worker-<row>`) with no field to lose. Read the results as a 2 by 2, never as two A/Bs.
 * @param {number} row
 * @returns {"batched" | "control"}
 */
export function tripsArmOf(row: number): "batched" | "control" {
  return Math.floor(row / 2) % 2 === 0 ? TRIPS_ARM.BATCHED : TRIPS_ARM.CONTROL;
}

/**
 * The calm finish paragraph, appended LAST to a `calm` worker's first-contact preamble and to nothing else. The text is #4055 move 2's own, kept
 * with its reason sentences and without capitals: the org's ALL-CAPS end-of-turn rules are what the report reads as a fight against early stops. The report's saving is Anthropic's, at max effort, on Anthropic's tasks; this arm exists to
 * measure it here.
 */
export const CALM_FINISH_PARAGRAPH = "No one watches this session live. A question or a plan at the end of your turn stops all work until the\n"
  + "next order arrives, which can be hours. Make routine judgment calls yourself, note the assumption in the\n"
  + "task log, and keep going. Stop to ask only when nothing can move without an answer, or before a destructive\n"
  + "or irreversible step. When the work in the order is done and its checks pass, stop and report what changed,\n"
  + "the evidence (test output, PR link) and anything left open. Don't start extra rounds of review or polish.";

/**
 * The round-trips paragraph, appended AFTER the calm paragraph (when the row has one) on a `batched` worker's first-contact preamble and on nothing
 * else (#4182). Two lines, each with its reason, and no capitals for emphasis. THE FIRST LINE IS ANTHROPIC'S: the "Optimize parallel tool calling"
 * section of https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices (fetched 2026-10-08) says "when
 * reading 3 files, run 3 tool calls in parallel" and that independent calls should be made in parallel. THE SECOND LINE IS NOT ON THAT PAGE: it is the
 * chairman's direction of 2026-10-08 (#4055 next wave, item 3), so it is not Anthropic's wording and no figure of theirs is claimed for it. The page's
 * "about 100%" is a rate of parallel calling under its sample prompt, not a saving; this arm exists to measure what the lines do here.
 */
export const ROUND_TRIPS_PARAGRAPH = "Every tool call is a round trip that reads the whole conversation again, so fewer round trips cost less. When you\n"
  + "intend to call several tools and none depends on another's result, issue them all in the same turn rather than one at a time.\n"
  + "For fan-out work, such as the same read over many files or rows, write one script that prints a summary instead of making one call per item.";

/**
 * CAUSE -> the worker that should take it.
 *
 * #2621 (child 3e of #69): COMPUTED, NOT SPELLED HERE. `PROFILES` used to be a fourth hand-maintained
 * list a cause had to be added to, beside `work-gate.ts`'s `CAUSES`, `JUDGMENT_CAUSES` and
 * `START_CAUSES` -- four lists in two files, and a cause added to one and not the others is a recorded
 * trap. `cause-declaration.ts` is now the one place a cause is declared (`{cause, group, profile}`), and
 * this name -- unchanged from here on, same keys, same `kind`/`model`/`effort`/`why` shape -- is its
 * computation. See that file's `TOOL_CAUSE_DECLARATIONS` for every cause's own profile and the reasoning
 * behind it, kept verbatim from this file's own history.
 *
 * Keyed on `cause` and not on `session`, deliberately. `session` says WHO is free, which is a scheduling
 * fact that changes minute to minute; `cause` says WHAT THE WORK IS, which is what decides how much
 * thinking it deserves. Two engineers taking different causes should not run at the same effort merely
 * because they are both engineers -- that conflation is how one setting ended up covering everything.
 *
 * `kind` IS PART OF THE PROFILE BECAUSE THE ORG IS NOT ALL ONE PRODUCT. The reviewers are `codex` and
 * the engineers are `claude`; a table that named only a model would have handed a reviewer a Claude
 * alias that `codex -m` cannot resolve. The first version of this file did exactly that.
 */
export { PROFILES };

/**
 * The profile for a cause, or a refusal.
 *
 * REFUSES AN UNKNOWN CAUSE rather than defaulting. Both defaults are wrong in a way that hides: falling
 * back to opus/xhigh silently restores exactly the spend this table exists to end, and falling back to
 * haiku/low silently gives hard work to a tier that cannot do it. A refusal is the only answer that
 * makes a new cause someone's decision -- and `work-gate` adding one is the moment to make it.
 *
 * @param {string} cause
 * @param {{ model?: string, effort?: string }} [override] operator override, both fields optional
 * @returns {{ kind: "claude"|"codex", model: string, effort: string, why: string } | { refusal: string }}
 */
export function profileFor(cause: string, override: { model?: string; effort?: string; } = {}): { kind: "claude" | "codex"; model: string; effort: string; why: string; } | { refusal: string; } {
  const base = (PROFILES as Record<string, {kind: "claude"|"codex", model: string, effort: string, why: string}>)[cause];
  if (!base) {
    return { refusal: `no profile for cause "${cause}" -- add one to PROFILES with the reason. `
      + `Known causes: ${Object.keys(PROFILES).join(", ")}` };
  }
  const model = override.model ?? base.model;
  const effort = override.effort ?? base.effort;
  const kind = base.kind;
  if (kind === "claude" && !MODELS.includes(model) && !model.includes("-")) {
    return { refusal: `model "${model}" is not a known claude alias (${MODELS.join(", ")}) or a full id` };
  }
  const allowed = EFFORTS[kind];  // keyed by the profile's own kind
  if (!allowed.includes(effort)) {
    return { refusal: `effort "${effort}" is not one of ${allowed.join(", ")} for a ${kind} worker` };
  }
  return { kind, model, effort,
    why: override.model || override.effort ? `${base.why} [OVERRIDDEN]` : base.why };
}

/**
 * The agent's own arguments for this profile -- everything after herdr's `--`.
 *
 * TWO PRODUCTS, TWO SPELLINGS, and neither is guessable from the other. `claude` takes `--model` and
 * `--effort` as flags; `codex` takes `-m` and sets its reasoning effort through `-c key=value`, the same
 * override mechanism its own `config.toml` uses.
 *
 * NOT STOPPING TO ASK IS DELIBERATE ON BOTH AND IS THE WHOLE POINT OF A SPAWNED WORKER:
 * nobody is sitting at that terminal, so a worker that stops to ask is a worker that hangs until a human
 * notices. It is defensible HERE and would not be on a developer's own machine -- these run in a
 * throwaway pane on the agent host, against a checkout the org owns, and what they may do is bounded by
 * the repository's own guards rather than by an interactive prompt. `codex`'s box already runs
 * `approval_policy = "never"` for the same reason.
 *
 * `launch.headless` is the ONE switch to the other form (#4075, #4055 move 9): absent, which is every caller today,
 * the arguments are the pane form below, byte for byte. No `PROFILES` entry carries it and no cause turns it on.
 *
 * @param {{ kind: string, model: string, effort: string }} profile
 * @param {{ headless?: HeadlessCaps }} [launch]
 * @returns {string[]}
 */
export function agentArgs(profile: { kind: string; model: string; effort: string; autocompactWindow?: number; }, launch: { headless?: HeadlessCaps; } = {}): string[] {
  if (launch.headless) return headlessClaudeArgs(profile, launch.headless);
  if (profile.kind === "codex") {
    // NOT `--dangerously-bypass-approvals-and-sandbox`, which was the first spelling here and is wrong.
    // That flag drops the SANDBOX as well as the prompts, and this host deliberately runs
    // `sandbox_mode = "workspace-write"`. What a spawned worker needs is "never stop to ask", which is
    // `approval_policy = "never"` -- already this box's own setting, passed explicitly so a spawned
    // worker does not depend on a config file it did not write. The sandbox stays.
    return ["-m", profile.model,
      "-c", `model_reasoning_effort="${profile.effort}"`,
      "-c", 'approval_policy="never"',
      "-c", 'sandbox_mode="workspace-write"'];
  }
  // `--disallowedTools AskUserQuestion` IS THE CLAUDE HALF OF WHAT CODEX ALREADY HAS ABOVE.
  //
  // A codex worker carries `approval_policy="never"` -- "never stop to ask" -- and a Claude worker
  // carried NO equivalent. So a Claude session could raise a menu and WAIT, and herdr reports that
  // state as `blocked`: not wakeable, taking no further cause, until a human clears it by hand.
  //
  // MEASURED TWICE. `worker-capture` behind a menu, found by the chairman from a screenshot; and
  // `orchestrator` on 2026-09-19, which correctly worked out that deploying protocol 19 would cost
  // ~2,122 recaptures and ~4h of fleet time, correctly listed "Hold and escalate to ceo first" as one
  // of its options -- AND THEN ASKED A HUMAN TO PICK IT. `ceo` owns fleet-time decisions under the
  // routing rule, so the escalation WAS the autonomous path; the session had the right answer and used
  // the wrong channel to deliver it.
  //
  // #1744 made this VISIBLE (`work-tick` prints `BLOCKED <name>`); it never made it impossible, and a
  // rule in a prompt saying "never stop and wait on a human" is a sentence -- the exact class of
  // instruction this org has repeatedly proved it cannot keep by habit. Removing the tool is the
  // mechanical version: a session that cannot ask must escalate, which is what the routing rule
  // already tells it to do.
  //
  // #2750 extends this list and moves it to `PER_ROW_DISALLOWED_TOOLS` above -- see that constant's own
  // comment for which tools joined it and why.
  //
  // `--autocompact` (#2717) bounds compaction to a TURN, not only to the gap between orders. #2688's
  // `/compact`-before-order (`wake.ts`'s `deliver()`, `prompt-session.ts`'s `clearThenPrompt()`) only
  // checks cache-read tokens at the seam where an order REACHES a session; a session that never returns
  // for a new order on one long-running row (measured: 340 calls, peak context 479k in a single turn) is
  // never checked there.
  //
  // #2717's FIRST CUT reused #2688's 120,000 outright and REGRESSED (2026-09-28): the window is not the
  // trigger, and 120,000 minus Claude Code's own ~35k margin minus a fresh worker's own ~65k base left
  // only ~22k of real working room -- worker-2623 thrashed on it for 5.4 hours across 139 compactions
  // before delivering a copied LICENSE file and one package.json field. `AUTOCOMPACT_WINDOW_TOKENS` above
  // is derived from the measured margin, the measured base and a real working-room floor instead of
  // reusing a number chosen for a different seam; it is still far below the 479k-615k peaks #2717 set out
  // to cap. Codex reviewers are a different product and are untouched below.
  //
  // `--settings worker-settings.json` (#2750) carries the two remaining token-cost levers that are not
  // tool-shaped: `autoMemoryEnabled: false` (the auto-memory index is git-repo-scoped, so every worktree
  // of THIS repo shares the same one, and it loads in full -- ~9.4k tokens -- on every fresh worker
  // regardless of relevance; a row that needs a specific past lesson cites it in its own body, the way
  // rows already do, rather than a worker discovering it ambiently) and `enabledPlugins` turning off the
  // three plugins that only ever matter to ORG PROCESS work a row's Region never covers
  // (`claude-code-setup`, `claude-md-management`, `code-simplifier` -- each contributes to the skills
  // listing a fresh worker pays for on every spawn whether or not the row ever touches CLAUDE.md or asks
  // for a simplification pass). Layered on top of the host's own settings, per Claude Code's own
  // precedence, not a replacement for it.
  return ["--model", profile.model, "--effort", profile.effort, "--dangerously-skip-permissions",
    "--disallowedTools", PER_ROW_DISALLOWED_TOOLS.join(","), "--autocompact", String(profile.autocompactWindow ?? AUTOCOMPACT_WINDOW_TOKENS),
    "--settings", WORKER_SETTINGS_PATH];
}

export type HeadlessCaps = { maxTurns: number, maxBudgetUsd: number };

/**
 * A worker as `claude -p` over stream-json instead of a pane (#4075, the report's move 9): the same process, but its
 * cost and its end are the CLI's to report and to enforce rather than a transcript's to be summed after the fact.
 *
 * THE CAPS HAVE NO DEFAULT HERE, ON PURPOSE. A turn or dollar ceiling that nobody measured is a number invented to
 * look safe, and a stop that bites mid-row is a cost of its own; the caller who turns this on names both.
 * Measured 2026-10-08 on claude 2.1.294 (n of one, a read-only task): `--max-turns 2` ended the run with exit 1 and
 * `subtype: error_max_turns`, `--max-budget-usd` is in `--help`, and `--max-turns` is NOT in `--help` though the CLI
 * accepts it -- so a release may drop it, and the test that pins this argument list is what would notice.
 *
 * WHAT THE PANE FORM HAS THAT THIS ONE LEAVES OUT: `--dangerously-skip-permissions` (`--permission-prompts none` denies
 * what would prompt, and the permission mode decides the rest, so a headless worker is granted its tools by settings
 * rather than bypassing them) and `--autocompact` (the pane's context window knob, #2717; not measured in print mode).
 * `--verbose` is required by the CLI for stream-json output under `-p`.
 *
 * @param {{ kind: string, model: string, effort: string }} profile
 * @param {HeadlessCaps} caps
 * @returns {string[]}
 */
function headlessClaudeArgs(profile: { kind: string; model: string; effort: string; }, caps: HeadlessCaps): string[] {
  if (profile.kind !== "claude") throw new Error(`headless workers are claude-only, not "${profile.kind}"`);
  for (const name of (["maxTurns", "maxBudgetUsd"] as const)) {
    const value = caps[name];
    if (!Number.isFinite(value) || value <= 0) throw new Error(`headless cap ${name} must be a positive number, got ${value}`);
  }
  if (!Number.isInteger(caps.maxTurns)) throw new Error(`headless cap maxTurns must be a whole number, got ${caps.maxTurns}`);
  return ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--max-turns", String(caps.maxTurns), "--max-budget-usd", String(caps.maxBudgetUsd),
    "--permission-prompts", "none",
    "--model", profile.model, "--effort", profile.effort,
    "--disallowedTools", PER_ROW_DISALLOWED_TOOLS.join(","), "--settings", WORKER_SETTINGS_PATH];
}

function main() {
  refuseUnknownFlags(["--cause", "--model", "--effort"], {
    entry: import.meta.url, command: "node packages/agent-org/src/worker-profile.ts",
  });
  const cause = flagValue(process.argv, "cause");
  if (!cause) {
    process.stdout.write(`${Object.entries(PROFILES)
      .map(([name, p]) => `${name}\t${p.model}\t${p.effort}\t${p.why}`).join("\n")}\n`);
    return;
  }
  const got = profileFor(cause, {
    model: flagValue(process.argv, "model") ?? undefined,
    effort: flagValue(process.argv, "effort") ?? undefined,
  });
  if ("refusal" in got) {
    process.stderr.write(`worker-profile: ${got.refusal}\n`);
    process.exit(1);
  }
  process.stdout.write(`${agentArgs(got).join(" ")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
