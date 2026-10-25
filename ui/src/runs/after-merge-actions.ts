// module: what the After-merge list's rows say and do (A11-277) -- the words of a row's runner and field, and its close and follow-up posted to the board
import { EVIDENCE_CHARS, evidenceRefusal } from "../../../src/ticket-mode/after-merge/checks.ts";
import type { Answer } from "../api/answer.ts";
import type { AfterMergeCheck, CheckAnswer, CheckResult } from "../api/types.ts";
import { useShell } from "../shell/ShellProvider.tsx";

const RUNNER_WORDS: Readonly<Record<AfterMergeCheck["runner"], string>> = { session: "the session", person: "you", board: "the board" };

/** Who the board sends a check to, as its row says it: "the session", "you" or "the board", and "for <role>" when the session runs it for a role. PURE. */
export const runnerText = ({ runner, role }: Pick<AfterMergeCheck, "runner" | "role">): string => (role === null ? RUNNER_WORDS[runner] : `${RUNNER_WORDS[runner]} for ${role}`);

/** A row's three closes, in the order its buttons are drawn, each with the button's words and the question its field asks. */
export const CLOSES: readonly Readonly<{ result: CheckResult; button: string; question: string }>[] = [
  { result: "passed", button: "Passed", question: "What did you see?" },
  { result: "failed", button: "Failed", question: "What did you see?" },
  { result: "superseded", button: "Superseded", question: "Why is it superseded?" },
];

/** Whether a field's text can be sent: one line of 1 to {@link EVIDENCE_CHARS} characters, as the board takes it. PURE. */
export const sendable = (text: string): boolean => evidenceRefusal(text) === null;

export { EVIDENCE_CHARS };

/** A row's posts: each resolves to null once the board took it (and the queue is read again, so the row leaves), or to the board's sentence when it refused. */
export type AfterMergeActions = Readonly<{
  close: (id: string, result: CheckResult, evidence: string) => Promise<string | null>;
  decide: (id: string, writer: string | null) => Promise<string | null>;
}>;

/** A person's closes and follow-ups, posted with `by: "person"` to the instance shown. */
export function useAfterMergeActions(): AfterMergeActions {
  const { client, queue } = useShell();
  const settled = (answer: Answer<CheckAnswer>): string | null => {
    if (!answer.ok) return answer.refusal;
    queue.refresh();
    return null;
  };
  return {
    close: async (id, result, evidence) => settled(await client.closeCheck(id, { result, evidence, by: "person" })),
    decide: async (id, writer) => settled(await client.decideFollowUp(id, writer)),
  };
}
