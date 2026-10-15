The reviewer's hand-off is the verdict file, and an `(environment)` verdict must quote its command (agent-org#1398). The door refuses an `(environment)` `not-convinced` with no backtick-quoted command before any `gh` call and names the verdict file, not a row label the reviewer App cannot write; the row-review skill says an Acceptance that fails as written is `not convinced`.

Acceptance: `node --test src/packaging/reviewer-environment-verdict.test.ts`

Mutation (each restored from a copy and diffed back to identical):
- the door as on `main` (no quoted-command rule): the positive control and the refusal (naming the verdict file) fail, `2 fail, 3 pass`.
- the skill as on `main`: the skill sentence case fails, `1 fail, 4 pass`.
- the quoted-command check made to refuse always: the positive control fails, `1 fail, 4 pass`.
