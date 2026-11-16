# The answerer's offline test

`result.json` is the latest replay of past Needs-you questions a person answered, through the answerer (A11-438, `docs/answering-a-run.md`). It is the public part of the result: each question's ticket key, when it was asked, what came of it (`not-tried`, `parked` or `answered`), and for an answered one how sure the answerer was and whether the judge found it agrees with the person. The questions, the answers, the tickets' text and the judge's reasons stay on the host that ran it, in `<stateDir>/evals/auto-answer/`, because this repository is public.

`tickets.autoAnswer` is on by default only when `score.meetsBar` is true here: at least 95% agreement on at least 20 answered questions. A test holds the default in `src/ticket-mode/settings.ts` to it. Run `node scripts/replay-auto-answer.ts` on a host whose state directory holds the set to replace it.
