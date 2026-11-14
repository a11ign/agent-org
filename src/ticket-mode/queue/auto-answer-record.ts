// @ts-check
// module: what a run records of an automatic answer to its question (A11-438, `auto-answer.ts`) -- TYPES ONLY

/** One source an automatic answer cites (A11-438): its label (`the ticket`, `the parent ticket A11-1`, a file's name) and, when it has one, its address. */
export type AnswerSource = Readonly<{ label: string; url?: string }>;

/**
 * What the answerer answered on a run (A11-438, `auto-answer.ts`): the question as the board held it (the run's `needs-human` reason), the answer, how sure the model was (0 to 1), the sources it cited and when. `overruledAt`
 * is set when a person answered the same question through the answer route: the run carries on with the person's answer. `closedAt` is set when a person answered a later question of the run instead: the
 * automatic answer then stands, and can no longer be overruled.
 */
export type AutoAnswer = Readonly<{ question: string; answer: string; confidence: number; sources: readonly AnswerSource[]; at: number; overruledAt?: number; closedAt?: number }>;
