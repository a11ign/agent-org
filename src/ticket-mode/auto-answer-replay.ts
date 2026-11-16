// @ts-check
// module: the answerer's offline test (A11-438, step 2) -- past Needs-you questions a person already answered, replayed through the answerer, scored against the person's answer
//
// THE KEY TURNS ON BY EVIDENCE ONLY. `tickets.autoAnswer` is on by default only when the replay of the checked-in set (`evals/auto-answer/result.json`) agrees with the person on at least {@link AGREEMENT_BAR} of the
// questions it answers, on at least {@link MIN_ANSWERED} of them. The default in `settings.ts` is tied to the stored result by a test, so the two cannot drift apart.
//
// THE SET AND ITS ANSWERS STAY ON THE HOST. agent-org is public, and the past questions, the person's answers and the tickets' text are the organisation's own: the set and the full result (each answer and the
// judge's reason) are kept in `<stateDir>/evals/auto-answer/`, and only {@link publicResultOf} (ticket keys, what came of each, how sure, whether it agreed, and the score) is checked in.
//
// THE REPLAY ASKS AS THE BOARD DOES. Each case goes through the same gate ({@link isAnswerableItem}), the same prompt ({@link answerPrompt}) and the same decision at the threshold ({@link decide}) as a live run.
// Its sources are the ones the answerer would have read when the question was asked: the person's answer is taken out of them, so the replay never scores a copy of the answer it is checking against.
// A second model, the judge, says whether the automatic answer agrees with the person's: whether a worker told it would do the same thing. Its reason is kept on each case, so a reviewer can check every verdict.
import { answerPrompt, decide, firstLine, isAnswerableItem, objectIn, percent, type Answerer, type Decided, type Source } from "./auto-answer.ts";

/** The share of answered questions the answerer must agree with the person on before the key may be on by default (A11-429's bar for F1). */
export const AGREEMENT_BAR = 0.95;

/**
 * The fewest answered questions the bar is read on. Below 20, one answer moves agreement by more than 5 points, so 95% cannot be told from 90%, and a wrong confident answer is worse than a wait: the key stays off and the
 * result says the sample is too small.
 */
export const MIN_ANSWERED = 20;

/** One past question: the ticket it was asked on, when, the question as the run wrote it, the item it named, the person's answer, and the sources the answerer would have read then. */
export type ReplayCase = Readonly<{ ticket: string; askedAt: string; question: string; escalation?: string; personAnswer: string; sources: readonly Source[] }>;

/** What the judge said: whether the automatic answer agrees with the person's, and why. */
export type Judgement = Readonly<{ agrees: boolean; why: string }>;

/** What the judge is asked with: the question, the person's answer and the automatic one. Throws when it cannot be asked. */
export type Judge = (question: string, personAnswer: string, autoAnswer: string) => Promise<Judgement>;

/** What came of one case: not tried (its item always reaches a person), parked (with why), or answered (with the answer, how sure, and the judge's verdict). */
export type CaseResult = Readonly<{ ticket: string; askedAt: string }> & (
  | Readonly<{ result: "not-tried"; why: string }>
  | Readonly<{ result: "parked"; why: string }>
  | Readonly<{ result: "answered"; answer: string; confidence: number; agrees: boolean; why: string }>);

/** The replay's score: how many cases there were, how many the answerer tried and answered, how many of those agreed, and whether that meets the bar. */
export type ReplayScore = Readonly<{ cases: number; tried: number; answered: number; agreed: number; agreement: number | null; meetsBar: boolean }>;

/** Whether `agreed` of `answered` questions turn the key on: agreement at or above {@link AGREEMENT_BAR}, on at least {@link MIN_ANSWERED} answered. PURE. */
export const meetsBar = (answered: number, agreed: number): boolean => answered >= MIN_ANSWERED && agreed / answered >= AGREEMENT_BAR;

/** What the score reads of one case. */
type Scored = Readonly<{ result: CaseResult["result"]; agrees?: boolean }>;

/** The score of a replay's results. PURE. */
export function scoreOf(results: readonly Scored[]): ReplayScore {
  const answered = results.filter((each) => each.result === "answered");
  const agreed = answered.filter((each) => each.agrees === true).length;
  return {
    cases: results.length,
    tried: results.filter((each) => each.result !== "not-tried").length,
    answered: answered.length,
    agreed,
    agreement: answered.length === 0 ? null : agreed / answered.length,
    meetsBar: meetsBar(answered.length, agreed),
  };
}

/** A share as a percentage to one decimal, `94.7%`, without a trailing `.0`: whole percentages round 94.7% up to the bar it misses. PURE. */
const exact = (share: number): string => `${Number((share * 100).toFixed(1))}%`;

/** A gap between two shares in percentage points, to one decimal. PURE. */
const points = (share: number): string => {
  const gap = Number((share * 100).toFixed(1));
  return `${gap} ${gap === 1 ? "point" : "points"}`;
};

/** The score in one line, for the pull request and the docs: the agreement and the sample, and by how much it misses the bar when it does. PURE. */
export function verdictOf({ cases, tried, answered, agreed, agreement, meetsBar: met }: ReplayScore): string {
  const sample = `${answered} answered of ${tried} tried, from ${cases} past questions`;
  if (agreement === null) return `No agreement to read: the answerer answered none of ${tried} tried, from ${cases} past questions. The key stays off: the bar needs ${MIN_ANSWERED} answered at ${percent(AGREEMENT_BAR)}.`;
  const read = `Agreement ${exact(agreement)} (${agreed} of ${answered}), ${sample}.`;
  if (met) return `${read} It meets the ${percent(AGREEMENT_BAR)} bar on at least ${MIN_ANSWERED} answered, so the key is on by default.`;
  const misses = [
    ...(agreement < AGREEMENT_BAR ? [`${points(AGREEMENT_BAR - agreement)} under the ${percent(AGREEMENT_BAR)} bar`] : []),
    ...(answered < MIN_ANSWERED ? [`${MIN_ANSWERED - answered} answered short of the ${MIN_ANSWERED} the bar is read on`] : []),
  ];
  return `${read} The key stays off: ${misses.join(", ")}.`;
}

/** What the replay asks with: the answerer and its model, the judge, and the threshold. */
export type ReplayDeps = Readonly<{ ask: Answerer; model: string; judge: Judge; threshold: number }>;

/** What the answerer decides on `question` from `sources` at the threshold, as on a live run: parked, saying why, when it cannot be asked. */
async function answered(question: string, sources: readonly Source[], { ask, model, threshold }: Omit<ReplayDeps, "judge">): Promise<Decided> {
  try {
    return decide(await ask(answerPrompt(question, sources), model), sources, threshold);
  } catch (err) {
    return { parked: `the answerer could not be asked (${firstLine(err)})` };
  }
}

/** Replay one case: the live gate, the live prompt and the live decision, then the judge on an answer. A judge that cannot be asked counts the answer as not agreeing: an unchecked answer is never a pass. */
export async function replayCase(each: ReplayCase, { ask, model, judge, threshold }: ReplayDeps): Promise<CaseResult> {
  const { ticket, askedAt, question, escalation, personAnswer, sources } = each;
  if (!isAnswerableItem(escalation)) return { ticket, askedAt, result: "not-tried", why: `it names ${escalation}, which always reaches a person` };
  const decided = await answered(question, sources, { ask, model, threshold });
  if ("parked" in decided) return { ticket, askedAt, result: "parked", why: decided.parked };
  const { answer, confidence } = decided.answered;
  try {
    const { agrees, why } = await judge(question, personAnswer, answer);
    return { ticket, askedAt, result: "answered", answer, confidence, agrees, why };
  } catch (err) {
    return { ticket, askedAt, result: "answered", answer, confidence, agrees: false, why: `the judge could not be asked, so it counts as not agreeing (${firstLine(err)})` };
  }
}

/** Replay every case, one after another, and stop before one when `spent()` says the token cap is reached: the cases not replayed are left out, and the caller says so. */
export async function replay(cases: readonly ReplayCase[], deps: ReplayDeps, spent: () => boolean = () => false): Promise<readonly CaseResult[]> {
  const results: CaseResult[] = [];
  for (const each of cases) {
    if (spent()) break;
    results.push(await replayCase(each, deps));
  }
  return results;
}

/** The judge's prompt: the question, both answers, and the one JSON object it answers with. PURE. */
export function judgePrompt(question: string, personAnswer: string, autoAnswer: string): string {
  return [
    "An unattended software worker asked a person the question below. The person answered it. Separately, an automatic answerer answered it too.",
    "Does the automatic answer agree with the person's? It agrees only when a worker told the automatic answer would do the same thing the person's answer tells it to do. Wording does not matter; a different choice, a missing condition the person set, or a hedge where the person was definite, does not agree.",
    "Reply with ONE JSON object and nothing else: {\"agrees\": true or false, \"why\": \"<one sentence>\"}.",
    "",
    `<question>\n${question.trim()}\n</question>`,
    `<person_answer>\n${personAnswer.trim()}\n</person_answer>`,
    `<automatic_answer>\n${autoAnswer.trim()}\n</automatic_answer>`,
  ].join("\n");
}

/** The judge's reply read, or null when it is not the object its prompt asks for. PURE. */
export function judgementOf(text: string): Judgement | null {
  const read = objectIn(text) as { agrees?: unknown; why?: unknown } | null;
  if (read === null || typeof read !== "object") return null;
  const { agrees, why } = read;
  return typeof agrees === "boolean" && typeof why === "string" ? { agrees, why } : null;
}

/** The result a replay stores beside its set: when and how it ran, every case's result, the score and its verdict. */
export type ReplayResult = Readonly<{ ranAt: string; sha: string; model: string; judgeModel: string; threshold: number; capped: boolean; score: ReplayScore; verdict: string; results: readonly CaseResult[] }>;

/** One case as the checked-in result shows it: its ticket, when it was asked, what came of it, and, when answered, how sure the answerer was and whether it agreed. No question, answer or reason. */
export type PublicCase = Readonly<{ ticket: string; askedAt: string; result: CaseResult["result"]; confidence?: number; agrees?: boolean }>;

/** The result as it is checked in to the public repository: the full one without any text from the tickets, the answers or the judge. */
export type PublicResult = Omit<ReplayResult, "results"> & Readonly<{ results: readonly PublicCase[] }>;

/** `result` with every question, answer and reason taken out ({@link PublicCase}). PURE. */
export function publicResultOf(result: ReplayResult): PublicResult {
  const results = result.results.map((each): PublicCase => {
    const { ticket, askedAt } = each;
    return each.result === "answered" ? { ticket, askedAt, result: each.result, confidence: each.confidence, agrees: each.agrees } : { ticket, askedAt, result: each.result };
  });
  return { ...result, results };
}
