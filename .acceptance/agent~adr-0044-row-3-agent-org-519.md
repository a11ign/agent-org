The body is no longer an acceptance source (ADR 0044 row 3, a11ign/agent-org#519): a pull request that adds no `.acceptance/` file is REFUSED, with the one exemption the ceo ruled (a11ign/a11ign#4811, (a)) for a Dependabot-authored pull request, whose body is still read.

Acceptance:
```bash
bash -c 'cd /home/agent/repos/wt-agent-org-519 && ! grep -q "body (deprecated" src/acceptance-file.ts'
bash -c 'cd /home/agent/repos/wt-agent-org-519 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/acceptance-file.test.ts'
```

The row's own commands `cd /home/agent/repos/agent-org`, the primary checkout, which carries this change only after the merge; these are the same two commands in this worktree. Printed: the grep exits 0 (no `body (deprecated` left in `src/acceptance-file.ts`), and `VERDICT pass: 24 tests in 1 file`.

What the tests pin (`src/acceptance-file.test.ts`, each with its negative control beside it):
- **3a** a non-bot author, a body `Acceptance:` and no file: REFUSED, `ACCEPTANCE: MISSING`, nothing run. Control: the same body from `dependabot[bot]` is read and run.
- **3b** a body that names `dependabot[bot]` (its login, a `dependabot/npm_and_yarn/...` branch name, a label and a trailer written into the body) but is authored by someone else: REFUSED. Control: the same body authored by `dependabot[bot]` is read.
- **3c** a Dependabot pull request with a body `Acceptance:`: READ, in both spellings of the login (`dependabot[bot]`, `app/dependabot`), and the line says whose body it read. Control: an unset `PR_AUTHOR` is no exemption.
- **Condition 2** a command read from a Dependabot body meets the same classifier and allowlist as one read from a file (`gh pr merge 1` from a Dependabot body is `ACCEPTANCE: REFUSED`, not run, with verdict lines byte-for-byte those of the file route).
- **Condition 4** `BODY_EXEMPT_AUTHORS` is one constant, matched whole and case-sensitively, so a near miss is refused; its comment names this row.

What a Dependabot pull request's source line now reads, run through `runCiBodyReports` over the real body of Dependabot pull request a11ign/a11ign#4472 (author `app/dependabot`, fetched with `gh pr view`, state MERGED), with `PR_AUTHOR=dependabot[bot]`:

```
ACCEPTANCE-SOURCE: body (exempt author dependabot[bot]; this pull request adds no file under .acceptance/; agent-org#519)
ACCEPTANCE: RAN pnpm exec rstest run --config=scripts/rstest/rstest.config.mjs --include packages/guards/src/one-package-manager.test.ts -> pass (exit 0)
```

and the same body with `PR_AUTHOR=someone-else`, or `PR_AUTHOR` unset:

```
ACCEPTANCE-SOURCE: none (this pull request adds no file under .acceptance/ and its author someone-else is not exempt, so the body is not read; add .acceptance/<branch with / as ~>.md)
ACCEPTANCE: MISSING
```

Mutation (each applied to `src/acceptance-file.ts`, run over `acceptance-file.test.ts` and `acceptance-commands.test.ts`, restored from a copy and `cmp` showed it byte-identical; baseline 33 tests green):
- `isBodyExemptAuthor` always false: 12 of 33 red. Always true: 13 red.
- Exemption keyed on the body text naming `dependabot[bot]`, not the author: 2 red (3b and the CLI test).
- Substring match instead of whole: 1 red. Case-insensitive match: 1 red. `app/dependabot` spelling dropped: 2 red. A third author added: 1 red.
- A refused source's section text `null` instead of `""` (so the `Mutation:` report falls back to the body): 6 red.
- An unreadable diff reads the body for everyone: 5 red. Zero added files reads the body for everyone: 10 red.
- An exempt author's body beats the file it added: 5 red.
- The refused line says nothing of the author: 3 red.

Judgement calls:
- **The Region was too narrow.** The row names two files; about a dozen other test files pinned the body fallback (46 tests failed when the reader changed, none of them in the Region), and `src/pr-open.ts` carried a comment saying the body was a fallback. They are changed as fixtures only (each hands the diff the file its body was always meant to be, and `readFile` returns the same text), with every assertion unchanged except one re-pinned in `pr-open-runs-every-ci-body-report.test.ts` (an unreadable diff now finds no file, so the ACCEPTANCE line is `MISSING` there and the MUTATION line is still `UNCHECKED`), and one in `acceptance-commands.test.ts` (the author-dependent table). Each is declared `Outside-Region:` in the pull request body. One test in `acceptance-primary-checkout.test.ts` had been passing vacuously over the old fallback and now exercises the file.
- **`pr:open` is unaffected** in production: its own file step already refused a diff with no file, and the opener is never Dependabot, so `checkBody` takes no author. The workflows that run `acceptance-commands` must pass `PR_AUTHOR` (the changeset says so); absent, a pull request is refused, which is the safe side.
- **A refusal reads the empty text**, not `null` and not the body, so no report that falls back to the body on `null` reads a body that was refused as a source.
- **Accepted, per the ruling:** a Dependabot pull request's body can still be edited after its review; this does not re-open it.

Whole suite, `AGENT_ORG_HOST` set, unmodified reader against this branch: 35 failed of 8678 on both, the identical 35 names (environmental: this host's stale `@a11ign/toolchain` install and the host checkout's missing `.agent-org/` files); none is in a file this change touches. With the reader changed and the fixtures not, 81 failed, so the 46 extra were all fixtures. `pnpm run typecheck`: only the two `mjs-ratchet.test.ts` missing-module errors, which `main` has too.
