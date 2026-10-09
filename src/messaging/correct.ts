// `chairman:correct` (a11ign/a11ign#3417, B4; epic #3409): WHAT THE CHAIRMAN SAYS IS WRONG ABOUT A ROW, FIXED THROUGH A CLOSED SET OF THREE VERBS AND NOTHING ELSE.
//
//   pnpm run chairman:correct -- --row=3333 --message=45 --as=withdraw --reason=already-done      (his words on stdin)
//   pnpm run chairman:correct -- --row=3333 --message=45 --as=reroute                             (his words on stdin)
//   pnpm run chairman:correct -- --row=3333 --message=45 --as=re-ask                              (the NEW BRIEF on stdin)
//
//   * `withdraw` takes `needs:chairman` off, with a comment giving the reason (`stale`, `wrongly-labelled` or `already-done`) and his words quoted: the row is no longer
//     asking him. Comment first, label last, so a failed comment leaves the row still asking and never withdrawn-and-silent (`answers.ts`'s order).
//   * `reroute` sets `answer:product-manager` and no other label. A wrong label, scope or done-when is the product manager's to fix, and **a waiting condition is data,
//     not a comment**: the comment is the reasoning, the label is what moves the org. `needs:chairman` stays, because whether the ask still stands is that ruling.
//   * `re-ask` writes a NEW brief, which `latestBrief` reads as the newest, so the watcher sees the ask change and tells the chairman. It is held to the same lines the
//     watcher requires (`requestEvent`): a brief that would send no alert is refused here, before it is written, and not found out at the next tick.
//
// **ANYTHING ELSE IS REFUSED, AND NOTHING IS WRITTEN.** Editing a row's body, Region or Done-when is not a verb: it is `reroute`. There is no verb that closes a row,
// answers for the chairman or removes any label but `needs:chairman`. Every other rule is `record.ts`'s: the `--message` ref must be an accepted inbound line, his
// words must be the ones the ledger hashed (a `re-ask`'s stdin is a brief, so only its ref is checked), the comment says it was written by the liaison, and a
// failure between two steps is resumed by the next call and not repeated.
//
// `chairman:ask-ceo` is not here: it is a ruling asked of `ceo` and writes nothing to a row.

import { pathToFileURL } from "node:url";

import type { GithubWriter, RowRef } from "./answers.ts";
import { alreadyDone, attribution, carryOut, checkMessage, finished, quoted, readRowOrRefuse, runCommand, stepsDone } from "./record.ts";
import type { Ledger, Outcome } from "./record.ts";
import { NEEDS_CHAIRMAN, requestEvent, requestKey } from "./sources/requests.ts";

/** The closed set. Pinned by the test: a fourth is a change of what the liaison may do. */
export const VERBS = Object.freeze(["withdraw", "reroute", "re-ask"]);
/** Why a request is withdrawn, as the comment says it. */
export const WITHDRAW_REASONS = Object.freeze({ stale: "stale", "wrongly-labelled": "wrongly labelled", "already-done": "already done" } as Record<string, string>);
/** The session `reroute` hands the row to. A constant and not an argument: the verb's whole meaning is that this one owns a wrong label, scope or done-when. */
export const REROUTE_TO = "product-manager";

/** What a plan is built from. */
type Said = { ref: string; at: string; words: string; text: string; reason: string | undefined; row: RowRef };
type Plan = { steps: (github: GithubWriter) => [string, () => Promise<void>][]; extra: Record<string, unknown> };

/** An attribution, a sentence of what is being done, then his words quoted. */
function commentOf(verb: string, { ref, at, words }: Said, lines: string[]): string {
  return [attribution(verb, ref), "", ...lines, "", `Telegram message ${ref}, ${at}, as the chairman wrote it:`, "", quoted(words)].join("\n");
}

/** A brief, then the attribution line. */
function reaskComment(body: string, { ref }: Said): string {
  return `${body.trimEnd()}\n\n${attribution("Re-asked", ref)}`;
}

/** The three plans. Each builds its writes from what was said, and knows nothing of the ledger or the row's labels. */
const PLANS: Record<string, (said: Said, rerouteLabel: string) => Plan> = {
  withdraw: (said) => {
    const why = WITHDRAW_REASONS[said.reason as string];
    const body = commentOf("Withdrawn", said, [`\`${NEEDS_CHAIRMAN}\` is taken off because it is ${why}, as the chairman said:`]);
    return {
      steps: (github) => [["comment", () => github.comment(said.row, body)], ["remove-label", () => github.removeLabel(said.row, NEEDS_CHAIRMAN)]],
      extra: { reason: said.reason },
    };
  },
  reroute: (said, rerouteLabel) => {
    const body = commentOf("Rerouted", said, [`The chairman says something on this row is wrong. \`${rerouteLabel}\` is set so the ${REROUTE_TO} rules on it:`]);
    return {
      steps: (github) => [["comment", () => github.comment(said.row, body)], ["set-answer", () => github.addLabel(said.row, rerouteLabel)]],
      extra: { to: REROUTE_TO },
    };
  },
  "re-ask": (said) => ({ steps: (github) => [["comment", () => github.comment(said.row, reaskComment(said.text, said))]], extra: {} }),
};

/** Why the watcher would send no alert for this brief, or null when it would. */
function briefProblem({ row, brief, now }: { row: RowRef; brief: string; now: number; }): string | null {
  const comments = [{ body: brief, createdAt: new Date(now).toISOString(), authorAssociation: "MEMBER" }];
  const { event, problem } = requestEvent({ repo: row.repo, row: { number: row.number, title: "", url: "", comments }, now });
  return event === null || problem !== null ? (problem ?? "the brief is not one the watcher reads") : null;
}

/**
 * `rerouteLabel` is the label that wakes the product manager: the vocabulary's answer prefix and `REROUTE_TO`, an INPUT and not a literal here, as `answers.ts`'s
 *   `answerLabel` is, because `project-vocabulary.test.ts` refuses a copy in code.
 */
export function createCorrector({ ledger, github, now, rerouteLabel }: { ledger: Ledger; github: GithubWriter; now: () => number; rerouteLabel: string; }) {
  /** Why the verb cannot be carried out at all, before the ledger or the row is read. */
  function verbProblem({ as, reason }: { as: string; reason?: string; }): string | null {
    if (!VERBS.includes(as)) return `${JSON.stringify(as)} is not one of ${VERBS.join(", ")}; those are the only corrections, and nothing was written`;
    if (as === "withdraw" && !Object.hasOwn(WITHDRAW_REASONS, reason ?? "")) return `withdraw needs --reason=${Object.keys(WITHDRAW_REASONS).join("|")}; nothing was written`;
    return null;
  }

  return {
    /** `text` is his words, or for `re-ask` the new brief. Never throws for a refusal or a failed write: both are values. */
    async correct({ row, ref, as, reason, text }: { row: RowRef; ref: string; as: string; reason?: string; text: string; }): Promise<Outcome> {
      const refused = verbProblem({ as, reason });
      if (refused !== null) return { outcome: "refused", say: refused };
      const checked = checkMessage(ledger.read(), { ref, text: as === "re-ask" ? null : text });
      if (!checked.ok) return { outcome: "refused", say: checked.why };
      const unsendable = as === "re-ask" ? briefProblem({ row, brief: text, now: now() }) : null;
      if (unsendable !== null) return { outcome: "refused", say: `${unsendable}; the brief was not written` };
      const plan = PLANS[as]({ ref, at: checked.at, words: checked.words ?? "", text, reason, row }, rerouteLabel);
      const job = { direction: as, request: requestKey(row.repo, row.number), ref, extra: plan.extra };
      const steps = plan.steps(github);
      const done = stepsDone(ledger.read(), job);
      if (steps.every(([name]) => done.has(name))) return alreadyDone({ row, verb: VERB_DONE[as] });
      const read = await readRowOrRefuse(github, row);
      if ("refusal" in read) return { outcome: "refused", say: read.refusal };
      // A started correction is finished whether or not the label is still there: `withdraw`'s second step is what removed it.
      if (done.size === 0 && !read.labels.includes(NEEDS_CHAIRMAN)) return { outcome: "refused", say: `${row.repo}#${row.number} is not asking the chairman anything now (${read.labels.join(", ") || "no labels"}); nothing was written` };
      return finished({ row, step: await carryOut({ ledger, job, steps, done }), verb: VERB_DONE[as] });
    },
  };
}

/** What each verb is called once it is done, in the words of its comment's first line. */
const VERB_DONE = Object.freeze({ withdraw: "Withdrawn", reroute: "Rerouted", "re-ask": "Re-asked" } as Record<string, string>);

/** The label that wakes the product manager, from the vocabulary: imported when asked, as `reply-cli.ts` does `host-config.ts`, so this file loads outside a configured host */
async function vocabularyRerouteLabel(): Promise<string> {
  const { ANSWER_PREFIX } = await import("../project-vocabulary.ts");
  return `${ANSWER_PREFIX}${REROUTE_TO}`;
}

/** Returns the exit code. */
export function main(argv: string[], deps: Partial<Parameters<typeof runCommand>[0]["deps"]> & { rerouteLabel?: string; } = {}): Promise<number> {
  return runCommand({
    name: "chairman:correct", argv, deps, options: { as: { type: "string" }, reason: { type: "string" } },
    perform: async ({ values, row, ref, text, ledger, github }) => createCorrector({
      ledger, github, now: deps.now ?? Date.now, rerouteLabel: deps.rerouteLabel ?? await vocabularyRerouteLabel(),
    }).correct({ row, ref, as: String(values.as), reason: values.reason, text }),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
