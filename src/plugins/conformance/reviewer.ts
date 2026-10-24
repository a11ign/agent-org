// @ts-check
// module: the reviewer contract's suite (A11-158) -- `runReviewerConformance(reviewer, probe)` is the only definition of "a reviewer"
//
// THE CONTRACT IS `ReviewerPort` PLUS `load` AND `refusal`. The suite starts, closes and retires a reviewer for the pull request the probe names, so it is run against an
// implementation that has a sandbox to do it in (the fake, or an adapter given a fake herdr). A reviewer that cannot run on this host says why in `refusal()` after `load()`,
// and must then refuse `start` rather than start nothing: that is the one property core relies on to start no reviewer silently.
import type { Reviewer, ReviewerRef } from "../contracts/reviewer.ts";
import { type ConformanceResult, expect, hasFunctions, isObject, isString, runChecks } from "./suite.ts";

/** The pull request, at its head, that the suite starts a reviewer for. */
export type ReviewerProbe = Readonly<{ ref: ReviewerRef }>;
type Subject = Readonly<{ reviewer: Reviewer; probe: ReviewerProbe }>;

const OPERATIONS = ["start", "live", "close", "retire", "listedPulls", "settled", "verdictFileOf", "repostVerdict", "reprompt", "load", "refusal"] as const;
const SETTLED = ["working", "ended", "gone"];

/** Loads the reviewer, and says whether it can start here. */
async function ready(reviewer: Reviewer): Promise<string | null> {
  await reviewer.load();
  const refusal = reviewer.refusal();
  expect(refusal === null || (isString(refusal) && refusal !== ""), "refusal() must be the reason it cannot start here, or null");
  return refusal;
}

const ALWAYS: Readonly<Record<string, (subject: Subject) => unknown>> = {
  "load resolves and refusal says why it cannot start, or null": async ({ reviewer }) => {
    await ready(reviewer);
  },
  "live is false before a reviewer is started": ({ reviewer, probe }) => {
    expect(reviewer.live(probe.ref) === false, "live() must be false for a head no reviewer was started for");
    expect(!reviewer.listedPulls().includes(probe.ref.pr), "listedPulls() must not list a pull request no reviewer was started for");
  },
  "settled is gone when there is no reviewer for the head": ({ reviewer, probe }) => {
    expect(reviewer.settled(probe.ref) === "gone", "settled() must be gone when no reviewer is there");
  },
  "start answers a label, or a refusal naming why": async ({ reviewer, probe }) => {
    const refusal = await ready(reviewer);
    const answer = reviewer.start(probe.ref);
    expect(isObject(answer) && ("label" in answer ? isString(answer.label) : isString((answer as { refusal?: unknown }).refusal)), "start() must answer { label } or { refusal }");
    if (refusal !== null) expect("refusal" in answer, "start() must refuse while refusal() says the reviewer cannot start here");
    else expect("label" in answer, `start() must start a reviewer for ${probe.ref.pr}: ${"refusal" in answer ? answer.refusal : ""}`);
    if ("label" in answer) {
      expect(reviewer.live(probe.ref) === true, "live() must be true once start() answered a label");
      expect(reviewer.listedPulls().includes(probe.ref.pr), "listedPulls() must list the pull request a reviewer was started for");
      expect(SETTLED.includes(reviewer.settled(probe.ref)), "settled() must be working, ended or gone");
    }
  },
  "verdictFileOf is a path or null": ({ reviewer, probe }) => {
    const file = reviewer.verdictFileOf(probe.ref);
    expect(file === null || isString(file), "verdictFileOf() must be the verdict file's path, or null when the reviewer wrote none");
  },
  "repostVerdict and reprompt answer, and never throw for a refusal": ({ reviewer, probe }) => {
    const repost = reviewer.repostVerdict(probe.ref, "/nonexistent/verdict.md");
    expect("posted" in repost || ("refusal" in repost && typeof repost.final === "boolean"), "repostVerdict() must answer { posted } or { refusal, final }");
    const prompt = reviewer.reprompt(probe.ref);
    expect("prompted" in prompt || "refusal" in prompt, "reprompt() must answer { prompted } or { refusal }");
    // A brief that names the plan step of a partial pull request (contract 1.3) is one a reviewer takes, with its section found or not.
    for (const section of ["Step 3 of 9: the section of the plan", null]) {
      const stepped = reviewer.reprompt(probe.ref, { doneWhen: null, step: { step: 3, of: 9, section } });
      expect("prompted" in stepped || "refusal" in stepped, "reprompt() with a brief that names a plan step must answer { prompted } or { refusal }");
    }
    // A brief that quotes the ticket's explicit decisions (contract 1.4) is one a reviewer takes too.
    const decided = reviewer.reprompt(probe.ref, { doneWhen: null, decisions: "## Decisions\n\n- Widen the policy, by the chairman's decision." });
    expect("prompted" in decided || "refusal" in decided, "reprompt() with a brief that quotes the ticket's decisions must answer { prompted } or { refusal }");
  },
  "close answers closed, gone or busy, or a refusal": ({ reviewer, probe }) => {
    const answer = reviewer.close(probe.ref);
    expect(("state" in answer && ["closed", "gone", "busy"].includes(answer.state)) || "refusal" in answer, "close() must answer { state } or { refusal }");
  },
  "retire answers retired, or a refusal, and lists the pull request no more": ({ reviewer, probe }) => {
    const answer = reviewer.retire(probe.ref.pr);
    expect(("retired" in answer && answer.retired === true) || "refusal" in answer, "retire() must answer { retired } or { refusal }");
    if ("retired" in answer) expect(!reviewer.listedPulls().includes(probe.ref.pr), "listedPulls() must not list a pull request whose reviewer was retired");
  },
};

/**
 * Runs every check against `reviewer`, so one run reports EVERY way a reviewer is wrong. The checks are ordered: they start a reviewer and then close and retire it.
 * @throws ContractError listing each failed check
 */
export function runReviewerConformance(reviewer: Reviewer, probe: ReviewerProbe): Promise<ConformanceResult> {
  return runChecks("reviewer", { reviewer, probe }, {
    shape: ({ reviewer: candidate }) => expect(hasFunctions(candidate, OPERATIONS), `a reviewer is an object with ${OPERATIONS.join(", ")} functions`),
    always: ALWAYS,
  });
}
