The retro says which limit ended a read, and reads a tag repository's release commits from the clone (a11ign/agent-org#754, for a11ign#4690).

Closes a11ign/agent-org#754

## The call sequence (Change item 1, measured)

`readRepository` for `a11ign/agent-org` through the real `githubReaders`, `gh` and `git` replaced by a logging shim that runs the real binary and writes one line per call (start offset, duration, exit status), on 2026-10-10 from the agents host, with a private clone as the declared clone. Measured, not inferred; the shim lines are the source of every number below.

```
BEFORE (the code on main):
  1 call   gh api repos/a11ign/agent-org/releases --paginate --slurp          started   0.2 s, took 2.6 s
  409 calls gh api repos/a11ign/agent-org/commits/<tag> --jq ...               started   2.8 s .. 221.7 s, 0.38 to 2.65 s each, 218 s together
  gh pr list ... --limit 1000 --json number,mergedAt,mergeCommit,files,body    STARTED at 222.5 s, ended at 240.0 s by the budget: it was given the 17.5 s that were left
  gh repo view / gh issue list (the regression rows)                            NOT STARTED: the 240 s budget was spent
  readRepository returned after 240.0 s: lead time, change failure rate, time to restore `unknown (gh pr list hit its time limit)`.
```

So `gh pr list` ran, and what ended it was the REPOSITORY's budget, not its own 90 s limit; the 409 per-tag commit reads had spent 222 of the 240 s. The row's isolated 23.8 s for the list is more than the 17.5 s it was left.

```
AFTER (this branch), same host and clone:
  1 call   gh api .../releases --paginate --slurp                              started   0.07 s, took 2.5 s
  1 call   git -C <clone> for-each-ref --format=%(refname) %(*objectname) %(objectname) refs/tags      2.6 s, 6 ms
  0 calls  gh api .../commits/<tag>
  gh pr list                                                                    started   2.6 s (was 222.5 s)
```

The `gh pr list` of the AFTER run was refused by GitHub (`GraphQL: API rate limit already exceeded for user ID 328832207`, exit 1 in 0.35 s, the same message from a bare `gh pr list -R a11ign/agent-org --state merged --limit 1`): the account's GraphQL pool was exhausted by the BEFORE runs and others, so the AFTER run does not show the list answering. What it shows is that the list is now reached 220 s sooner with 237 s of its budget left. The live reading is a11ign#4690's, as the row says.

## What changes, and why

- **`src/dora.ts`, which limit.** `readLimits.timedOut` now holds the words, and the reason prints them: `gh pr list timed out after 90 s` (the call ran its OWN limit), `gh pr list timed out after 17 s, all that was left of this repository's read budget (a call's own limit is 90 s)` (it was given only the rest of the budget: the case measured above), and `gh pr list was not started: this repository's read budget is spent` (never begun). All three read `hit its time limit` before. The third string is not in the row's two: the measured case was neither of them.
- **`src/dora.ts`, the tag commits.** `ReleaseWindow.tagCommit` is the commit a tag names read from the declared clone: ONE `git for-each-ref --format='%(refname) %(*objectname) %(objectname)' refs/tags` (annotated tags peeled), one `git fetch --tags origin` and one re-read if a tag is missing, then `null` for a tag the clone still lacks, which `tagReleasesFrom` asks of GitHub (`commits/<tag>`) for that tag only. npm repositories' `v<version>` lookup goes through it too. The clone reader is now built once per repository in `measureRepository` and shared by the releases read and `ancestryOf`, so the fetch is made at most once for both.
- **Neither constant is raised** (`READ_TIMEOUT_MS`, `REPOSITORY_BUDGET_MS`), and `gh pr list` is not paged by `merged:` range: the measurement says the list was not slow, it was starved, so Change item 3's second branch does not apply.
- **`src/dora-budget-spent-is-not-a-timeout.test.ts`** (new, 10 tests). **`src/dora-lead-time-reads-are-bounded.test.ts`** and **`src/org-retro-dora-resumes.test.ts`**: the three assertions of the old wording now assert the new.
- **`.changeset/the-dora-read-says-which-limit-it-hit.md`.** A patch.

## How you verified it

Acceptance: `node --import tsx --test src/dora-budget-spent-is-not-a-timeout.test.ts src/dora-ancestry-from-the-clone.test.ts`

```
tests 16, pass 16, fail 0     (10 new + 6 of the ancestry file, untouched)
AGENT_ORG_HOST=<a11y-witness>/.agent-org/host.json node --import tsx --test src/dora-*.test.ts src/org-retro*.test.ts   # 64 pass, 0 fail
node_modules/.bin/tsc --noEmit -p tsconfig.json   # only the two pre-existing src/packaging/mjs-ratchet.test.ts errors (the toolchain module is not installed in this tree)
```

The row's own command `cd`s into `/home/agent/repos/agent-org`, which does not hold this branch; the command above is the same two files run from this tree.

Mutation: `src/dora.ts` copied aside, one change at a time, restored from the copy and `diff`ed byte-identical after the run; red counts are of the 10 new tests, measured by running them. The tag reader not passed to the releases read -> 3 red (the three clone tests); every timeout worded as the budget's -> 1 red (the own-limit one); a never-started call worded `hit its time limit` -> 2 red; a tag the clone lacks never asked of GitHub -> 5 red (it also starves the budget fixtures of their commits). Each was red in the new file only.

## Anything a reviewer should be sceptical of

- **The AFTER sequence does not include a `gh pr list` that answered** (rate limit above). The unit tests inject the clock and a `gh` script, so they pin the words and the zero per-tag calls, not the live list's duration.
- **A repository with no declared clone still reads one `commits/<tag>` per release** and will still spend its budget on 400 of them: the fix is the clone's, as the row names it, and the retro now says which limit when it happens.
- **The role file `.agent-org/roles/engineer.md` is not in this repository's tree**; I read the copy in the `a11y-witness` sibling checkout.

## Outside the Region

Outside-Region: src/dora-lead-time-reads-are-bounded.test.ts — two assertions pinned the old words `hit its time limit` for a budget that was spent; the words are what this row changes, so they moved with it (the regexes now name `was not started: this repository's read budget is spent`).
Outside-Region: src/org-retro-dora-resumes.test.ts — two assertions pinned the same old words for a hung call and for a spent budget; they now assert `timed out after 400 ms` and `was not started: ...`.
