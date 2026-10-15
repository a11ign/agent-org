---
name: row-review
description: Review an agent-org pull request against the row it closes on three separate axes (Spec, Tests and correctness, Standards) and decide convinced or not convinced. Use for every reviewer order (cause draft-awaiting-verdict) and whenever asked to review a PR against its row.
---

# Row review

Adapted from the `code-review` skill in mattpocock/skills (MIT; see LICENSE). This skill says WHAT to check and what counts as a defect. `.agent-org/roles/reviewer.md` says how to post: its first-line shape, its door and its hand-offs come first, and this skill's body follows that first line. Where the two disagree on what makes a defect, this skill wins.

## Inputs

- **Diff:** `git diff origin/main...HEAD` in the review checkout (three-dot, so it is against the merge base). Get the changed paths with `--name-only`.
- **Row:** the issue the PR closes (`Closes #N` or `Closes <owner>/<repo>#N`), read with `gh issue view`. Its `## Done-when`, `## Change`, `## Region` and `## Acceptance` sections are the spec.
- **Acceptance:** run the Acceptance command. An Acceptance that fails as written is `not convinced`, and `(environment)` is only for a failure that disappears outside your sandbox (see Verdict). You have no Issues write, so the verdict file is your hand-off, not a label on the row.
- **Prompt-supplied inputs:** when the prompt hands you the diff and the row as files and says nothing may be posted or run, read those instead, run no `gh` and post nothing. If the tree has no `.git`, search it with `grep -rn` where this skill says `git grep`. An Acceptance the prompt says was not run is not held against the PR, but its tests are still read.

Review the three axes separately and report them separately. One axis passing never excuses another failing.

## Axis 1: Spec. The row is the contract.

1. **Item table.** Make one line per Done-when item and one per Change item: `quoted item | where in the diff | met / partial / missing / deferred`. Every item gets a line.
   - An item that is partial, missing, turned into a notice or message instead of the behaviour, or deferred "to a follow-up row" is a **defect in this diff**. Deferring is allowed only when the row itself says so.
   - An item that names a counter, a signal, a flag or a command is met only where the diff WRITES and READS it, not where it merely mentions it.
   - An item that prescribes HOW a test is built (an injected clock, an injected spawn) is met when the test crosses the same boundary through the seam the code really has and the PR says which seam. It is partial only when the behaviour at that boundary has no test that fails; then say what is untested, not that the recipe differs.
2. **Region check.** List every changed path that is not in the row's Region. `.changeset/` and `.acceptance/` are exempt by repo rule: leave them out of the list and never raise them as a finding.
   - Each one needs a reason in the PR body (`Outside-Region: <path> — <reason>`). A path with no reason is a defect.
   - So is any out-of-Region change that is security-relevant: permissions, token or STS policy, a workflow `permissions:` block, or secrets handling.
3. **Scope creep.** Behaviour the row did not ask for is a nit, unless it adds risk; then it is a defect. A row that says "decision rows stay where they are" is broken by a change that moves them, whatever else it does well.

## Axis 2: Tests and correctness

1. **Name the test for each change.** For every behaviour the diff changes, name the test that would FAIL if that change were reverted or broken. "I think it is covered" does not count.
2. **Not tests.** The following are not tests of a behaviour. If one of them is the only evidence for a changed behaviour, that is a defect:
   - a regex, grep or `includes` over source text or workflow YAML ("the file contains X");
   - a test that stubs, mocks or replaces the very function or line the diff changed;
   - an assertion that restates a constant, or compares a value with itself (a "byte-identical" test whose expected side is a literal the test file also defines proves nothing about the code);
   - a boundary test whose fixture does not hit the boundary (for example, an "exactly two" case built with three);
   - a re-implementation of the production check inside the test;
   - a flag test that injects the flag's reading, when the production default (where the flag is really read) is never exercised.
3. **Mutate the subject, not the test.** Take the key changed line, flip it, and check that a test goes red. Do it for real when it is cheap.
   - Read where the changed line LIVES. If it is inside a function the tests call, with the clock, the spawn or the store passed in, it is tested; the entrypoint that only hands that function the real collaborators and exits with its result is a nit at most. An untested entrypoint is a defect only when the changed line or the changed logic is in the entrypoint itself, or when the only evidence for it is a source-text assertion.
4. **Correctness.** Each of these is a defect if it is reachable:
   - **Fails open:** an unreadable or unknown input treated as safe or empty (`?? []`, an empty `catch`, `void error`, a parse failure that returns `{}`).
   - **Silent skip:** a read that is skipped without saying so, which downstream code then reads as "nothing there".
   - **Reused name:** an existing identifier, cause or label reused with a new meaning.
   - **Hidden coupling:** state carried between functions through a module-level Map or WeakMap, which breaks when a caller skips the first function.
   - **Missing counter:** a counter or metric the row names that nothing writes or reads.

## Axis 3: Standards

1. **Repo standards first.** These are `CLAUDE.md`, `.claude/rules/`, `CONTRIBUTING.md` and the toolchain ADR. A documented repo standard overrides the baseline below.
2. **Duplicated Code is a defect, not a nit, when the diff copies an existing exported function, constant or parser** (or a whole lifecycle of one, with only the names changed) instead of importing it or moving it to one shared place. Search with `git grep` before deciding. A "parity test" that keeps two copies equal does not excuse the copy.
3. **Smell baseline.** These are judgement calls and therefore nits. Name each one and quote the hunk:
   - **Mysterious Name:** the name does not say what it does or holds.
   - **Speculative Generality:** hooks or parameters the row does not need.
   - **Shotgun Surgery:** one change forces edits scattered across many files.
   - **Divergent Change:** one file is edited for several unrelated reasons.
   - **Data Clumps:** the same few fields keep travelling together.
   - **Primitive Obsession:** a string or number standing in for a domain type.
   - **Feature Envy:** a function that reaches into another module's data more than its own.
   - **Middle Man:** a function that only passes a call on.
   - **Repeated Switches:** the same switch or if-chain repeated across the change.
4. **Casts.** `any`, `as never` or `as unknown as` in production code is a nit, unless it is at a JSON boundary.

## Verdict

**Not convinced** when any of these holds:
- any Spec item is partial, missing or deferred;
- there is an unexplained or risky out-of-Region path;
- a changed behaviour has no test that would fail;
- there is a correctness defect;
- an existing helper is duplicated.

Otherwise the verdict is **convinced**, with the nits listed. Nits alone never make a `not convinced`; a defect on any axis always does.

**An Acceptance that fails as written is `not convinced`**, on the head, from the checkout you hold. Quote the command in backticks with its last lines. `(environment)` is only for a failure that disappears outside your sandbox, that is, the same command passes in CI or in the lab; the verdict then names the command that showed it, quoted. The door refuses an `(environment)` verdict that quotes no command, and the verdict file is the hand-off the reviewer can perform.

**After the role doc's first line, write the body as three sections: `## Spec` (holding the item table), `## Tests and correctness` and `## Standards`.**
- Give `file:line` for every finding.
- Do not rerank findings across axes.
- End with one line naming the worst finding in each axis, or "none".
- Keep the body under 600 words.
- When the prompt asks for it, finish with one last line, `VERDICT: convinced` or `VERDICT: not convinced`, and nothing after it.
