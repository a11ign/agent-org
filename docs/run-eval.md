# The worker eval (`run-eval`)

The worker eval measures a change to the worker brief, the model or the effort before it merges. It replays merged tickets through a headless worker, offline, and scores what the worker made against what was merged. The reviewer has its own eval, `scripts/review-eval.ts`; this one is for the worker.

```sh
node scripts/run-eval.ts --set <name|path/to/set.json> [--only A11-1,A11-2] [--model opus] [--effort high] [--key <switch>=on|off] [--replace]
node scripts/run-eval.ts compare --set <name|path/to/set.json> <A> <B>
```

A set named without a path is read from `evals/sets/<name>.json`; the first is `first`. The model and effort default to the board's saved choice (`<stateDir>/tickets/choice.json`), so a run measures what the board would run today. The command prints the table and each ticket's throwaway folder. Every folder is kept, so you can read the worker's result, the brief, its diff and the review.

## Measuring a change

1. On `main`, run the set: `node scripts/run-eval.ts --set first`.
2. On your branch, with the change committed, run it again.
3. Compare the two: `node scripts/run-eval.ts compare --set first <main's sha> <your sha>`.

Each run is stored by its set and the sha of the checkout it ran from, at `<stateDir>/evals/<set>/<sha>.json`. A run already stored at that sha is refused before any ticket starts; `--replace` runs it again. A run from a checkout with uncommitted changes, untracked files included, is stored apart as `<sha>-dirty`, named so in a comparison (`compare --set first <sha>-dirty <sha>`), and marked "uncommitted changes". A run with `--only` is printed and not stored, since it is not the whole set.

`compare` takes each run as a sha or its first seven or more characters, and prints a row per ticket with each score as `A → B (change)`, and the totals the same way. Its shape, with made-up numbers:

```text
worker eval of first, A → B
A: 0d450e9 (opus, effort medium, finished 2026-11-16T09:12:40.000Z)
B: a1b2c3d (opus, effort medium, finished 2026-11-16T15:02:11.000Z)

ticket  tests        verdict                      similarity           outside     tokens                       wall
A11-376 fail → pass  not convinced → convinced    0.25 → 0.50 (+0.25)  2 → 1 (-1)  21000000 → 18000000 (-3000000)  900s → 840s (-60s)
...
total   6 → 7 (+1) of 10  5 → 6 (+1) convinced  0.31 → 0.35 (+0.04)  ...
```

The totals count only the tickets both runs have; the others are named under the table. An unknown (`?`) stays unknown, with no change, and the similarity and token totals are over the tickets known on both sides, saying how many they left out.

## A config key on and off

A feature that ships off (the epic's M3 and F2) is measured by running the set with its key on and off at the same sha:

```sh
node scripts/run-eval.ts --set first --key tickets.lessons=off
node scripts/run-eval.ts --set first --key tickets.lessons=on
node scripts/run-eval.ts compare --set first <sha>@tickets.lessons=off <sha>@tickets.lessons=on
```

The key must be a switch of the host file (an entry marked `switch` in `src/ticket-mode/config-schema.ts`) that the eval hands its worker, listed in `EVAL_SWITCHES` (`src/run-eval/worker.ts`); any other name is refused before a ticket starts. Today those are `tickets.drafts`, `tickets.localReview` (the pre-PR review, below) and `tickets.lessons`: a switch the eval does not carry into the worker's brief or settings would run a whole set and change nothing. With `tickets.lessons` on, the brief carries the lessons of the ticket's repository from the host's own lessons files (`<stateDir>/tickets/lessons/`), as the board's brief would; with it off, none. A host whose retro has never run has no lessons file, so on and off write the same brief: write the lessons first (the daily retro, or a person on the board's Lessons page), or the comparison measures nothing. A feature that ships off reads its key from the settings the eval reads (`readTicketSettings`), carries it into `HostBrief` so the brief the eval writes depends on it, and adds the key to `EVAL_SWITCHES` in the same pull request. The eval sets the key only in its own read of the host file: the file is not written, and the board does not see it. Each setting is stored apart, as `<sha>@<key>=on.json` and `<sha>@<key>=off.json`.

## The pre-PR review on and off (A11-440)

`tickets.localReview` has the worker run the reviewer on its own diff before it opens a pull request. With it on, the eval's brief has step 5b, naming the stand-in `eval-review-local` where a board's brief names `agent-org ticket:review-local`. The stand-in runs `ticket:review-local`'s own logic (`scripts/eval-review-local.ts`): the same prompt, the same Codex reviewer, the same record beside the brief and the same exit codes. It also writes each review's Codex tokens to `record/local-review-tokens.log`. A review that never answered (the worker's command was killed) and a review whose tokens Codex did not report count as unknown, never as 0. The eval's `eval-pr-open` stand-in does not refuse a pull request that skipped the review, as `pr:open` would. The run's table shows the worker's tokens; the pre-PR reviews are kept per ticket as `localReviews` in the stored run.

The epic's bar for turning the key on by default is a better first-pass reviewer verdict, for reviewer tokens no more than the feedback rounds it saves. `bar` reads the two runs at one sha and the board's outcome log, and runs nothing:

```sh
node scripts/run-eval.ts --set first --key tickets.localReview=off
node scripts/run-eval.ts --set first --key tickets.localReview=on
node scripts/run-eval.ts bar --set first <sha>@tickets.localReview=off <sha>@tickets.localReview=on
```

- **The first-pass verdict** is the eval's own verdict column: the convinced tickets among those both runs have. An unknown verdict counts as not convinced. Better means strictly more.
- **The rounds saved** are the convinced tickets gained, and none when the on run has fewer.
- **A round's tokens** are the median of every round after a run's first in `<stateDir>/tickets/outcomes.jsonl`. That counts review rounds, talk sessions and rounds resumed by an answer, all of them worker turns. The board's review of the head a round pushes is not counted, so the saving is, if anything, low.
- **The reviewer tokens** are every pre-PR review's Codex tokens on the on run: input (cached included) plus output (reasoning included). One unknown makes the total unknown, and an unknown total misses the bar.

`bar` refuses two runs that are not the key's off run and on run, at one committed sha, from the same model and effort. It names a run the token cap stopped, and compares only the tickets both runs have. It prints a row per ticket, the verdict and token lines, and `BAR MET` (exit 0) or `BAR MISSED` (exit 1), saying which condition failed and by how much.

### The measured bar: missed, so the key stays off

The two runs, `--set first` at f76d22d85 with `tickets.localReview` off and on, opus at effort medium, run side by side on the board's host on 2026-11-16 from about 08:55 UTC (off finished at 13:49, on at 14:41):

| ticket | verdict off → on | pre-PR reviews | reviewer tokens | worker tokens off → on |
|---|---|---|---|---|
| A11-376 | convinced → convinced | 1 | 212,749 | 7,819,062 → 4,471,769 |
| A11-397 | convinced → not convinced | 3 | 573,181 | 4,795,561 → 6,283,614 |
| A11-344 | convinced → convinced | 1 | 331,371 | 4,180,083 → 3,252,410 |
| A11-340 | not convinced → not convinced | 1 | 373,397 | 13,774,384 → 14,975,437 |
| A11-341 | not convinced → convinced | 2 | 661,947 | 6,445,846 → 10,629,115 |
| A11-297 | not convinced → not convinced | 4 | 1,276,418 | 4,047,838 → 9,888,730 |
| A11-449 | not convinced → not convinced | 5 | 1,012,012 | 17,693,107 → 35,982,610 |
| A11-394 | not convinced → not convinced | 5 | 1,250,851 | 7,295,578 → 13,506,582 |
| A11-239 | convinced → convinced | 1 | 221,587 | 3,994,431 → 4,832,231 |
| A11-140 | convinced → convinced | 1 | 227,284 | 4,604,015 → 5,114,840 |
| **total** | **5 → 5 convinced** | **24** | **6,140,797** | **74,649,905 → 108,937,338** |

- **The first-pass verdict is not better:** 5 of 10 convinced both ways (+0). The on run needs 1 more convinced ticket to be better. One ticket was gained (A11-341) and one lost (A11-397).
- **The reviewer tokens are not within the rounds saved:** no rounds were saved, so the 6,140,797 tokens of the 24 pre-PR reviews are 6,140,797 more than the 0 tokens saved. A round costs 2,762,926 tokens (the median of 52 rounds after a run's first in the outcome log), so the reviews cost about 2.2 rounds. The key would have had to gain 3 convinced tickets to pay for them.
- **The worker spent 46% more with the key on** (+34,287,433 tokens, +58 minutes of ticket time), mostly fixing what the pre-PR reviewer found and reviewing again: the tickets that ran 4 or 5 reviews account for most of it, and none of them ended convinced. The bar does not count this, because the ticket's words name the reviewer's tokens, but it would only raise the cost.
- **One pair of runs is noisy.** The run of the same set from 30a8a5b59 (below) had 6 of 10 convinced with no pre-PR review at all, and 3 tickets' verdicts differ between it and the off run here (A11-340, A11-297, A11-140). A gain of one or two tickets would not have been told apart from that noise. A loss of 34M worker tokens is far outside it.

Every review the on run's workers started has a token line in its record, and none named `--record` or `--ticket-dir` (read from each ticket's `record/attempts.log`). The off run's records have no token log.

## The token cap

`tickets.evalTokenCap` in the host file is the most tokens one run may spend, 300,000,000 by default (ten tickets at the 90th percentile of a first round on the board's outcome log). The eval adds up each ticket's worker tokens, cache reads included. A worker that fails is counted at the tokens its printed result reports; one killed at its two hours printed none, and counts as unknown, which the report says. When the total has reached the cap and a ticket is still to start, the run stops: it prints how many tickets ran, the tokens they spent and the tickets it never started, stores the run marked as stopped, and exits 1. A ticket already running finishes. The reviewer's tokens, on the Codex account, are not counted.

## A set

A set is a JSON list of at most 10 merged tickets:

```json
[
  { "repo": "a11ign/agent-org", "ticket": "A11-123", "baseSha": "<40-hex sha the merged pull request was based on>", "mergedPr": 2001 }
]
```

An entry may add `"test": "<shell command>"`, the check its tree is held to. Without it, the check is agent-org's own: `pnpm install --frozen-lockfile && pnpm run check:changed`. A set with more than 10 tickets, a ticket listed twice or a malformed entry is refused by name. A long set is never cut short.

## What happens to each ticket

1. **A throwaway clone at the base sha.** A bare `origin.git` in the ticket's folder holds the base sha's history and nothing after it, so the merged answer is not in the clone. The history is fetched from the host's checkout when it holds the sha, else from GitHub (read-only).
2. **The current brief.** The brief is `briefText` from `src/ticket-mode/worker-files.ts`, as the board would write it today. It has the host's notes, plugins, draft choice, pre-PR review skill, the lessons of the ticket's repository while `tickets.lessons` is on, and the tracker's keywords. The ticket, its parent and their attachments are read from the tracker (read-only). Only these differ from a real run:
   - the worktree and pull-request commands are local stand-ins, and the pull-request stand-in records the body without checking it as `pr:open` would;
   - no connector is listed, and no design tool or screenshot is offered;
   - the ticket's comments are left out, because comments read after the merge name the merged pull request, which is the answer;
   - the board's run state (blockers, stacks, earlier plan steps) is left out, because a first run of a ticket has none.
3. **A headless worker.** It runs `claude -p` with the board's own worker flags and the worker's settings, but without the board's hooks (an eval has no run state for them to read).
4. **The scores**, in this order (the tests and the verdict count for more than similarity):
   - **tests**: whether the entry's check passes in the worker's tree;
   - **verdict**: the reviewer's, offline. It uses `review-eval`'s model, effort and `row-review` skill in a read-only sandbox, with the ticket as the spec. The reviewer is not told an answer exists;
   - **similarity**: the share of changed lines the worker's diff and the merged diff have in common, from 0 to 1. A changeset or acceptance file is compared by its folder, since its author names it;
   - **outside**: the files the worker changed that the merged pull request did not;
   - **tokens**: the worker's total across every model, from its result. `?` means unknown, never 0;
   - **wall**: the worker's wall time.

A step that fails is shown as an unknown (`?`) and its note gives the reason. It is never skipped, and the totals never count it as a pass.

## Nothing leaves the machine

- **git:** the clone's only remote is the local `origin.git`, so a push lands there. The worker's environment has `GIT_ALLOW_PROTOCOL=file`, so git refuses an `https` or `ssh` URL before it connects.
- **The code host:** `gh` is a stand-in that records `gh pr create` (its title and body go to `record/pull-request.md`, and it answers with an `eval.invalid` URL). It refuses every other call. The environment has no tokens and an empty `GH_CONFIG_DIR`, and the settings deny the host's own `gh` by its path.
- **The tracker and the board:** the worker starts with no MCP server (`--strict-mcp-config`, and claude.ai's connectors off). `agent-org` is a stand-in that refuses, and the settings deny the host's own launcher by its path. Every `AGENT_ORG_*` variable is dropped, and `AGENT_ORG_HOST` names a file that does not exist. So agent-org code that the worker or its check runs (the clone's own `src/bin.ts`) refuses for want of a host file. It never falls back to `~/.agent-org/host.json` and the tracker key that file names.
- **The board's serves:** `tailscale` is a stand-in, so a test the worker or the check runs cannot switch off the board's serves.
- **The pre-PR review** (`tickets.localReview` on): `eval-review-local` is the one stand-in that runs agent-org code of the eval's own, not the worker's (`scripts/eval-review-local.ts`, from the eval's checkout). That code reads a host file as it loads, so the stand-in gives it the eval's own `AGENT_ORG_HOST`, as the eval itself has. The worker can only start it, with `--base`. It refuses an unknown option, and refuses `--ticket-dir` or `--record` given a second time. Its reviewer is the eval's Codex reviewer, read-only, and sends the worker's diff to the Codex account, as the eval's own review of every ticket already does. The worker's environment still names no host file.

Every call a stand-in receives is written to `record/attempts.log`.

These walls close every path the brief and the board's tools give a worker. They are not a container: a worker that went out of its way to read a credential file under `HOME` by its path could still use it.

## Spend

Evals run on the board's own Claude and Codex accounts: at most 10 tickets per set, at most 2 runs per pull request (a config key off and on), and under the token cap.

### The measured cost of the first set

One run, `node scripts/run-eval.ts --set first` from 30a8a5b59 (step 2 of A11-431), opus at effort medium, 2026-11-16 02:44–07:42 UTC on the board's host:

| ticket | tests | verdict | similarity | outside | tokens | wall |
|---|---|---|---|---|---|---|
| A11-376 | fail | convinced | 0.11 | 3 | 4,878,818 | 2265s |
| A11-397 | fail | convinced | 0.25 | 0 | 4,181,052 | 739s |
| A11-344 | fail | convinced | 0.13 | 1 | 5,999,623 | 1201s |
| A11-340 | fail | convinced | 0.06 | 3 | 13,616,095 | 1029s |
| A11-341 | fail | not convinced | 0.12 | 0 | 7,348,419 | 2093s |
| A11-297 | fail | convinced | 0.11 | 1 | 6,802,865 | 1401s |
| A11-449 | fail | not convinced | 0.08 | 4 | 36,947,107 | 2943s |
| A11-394 | fail | not convinced | 0.11 | 0 | 8,711,888 | 2198s |
| A11-239 | fail | convinced | 0.10 | 0 | 4,871,442 | 689s |
| A11-140 | fail | not convinced | 0.12 | 0 | 3,545,182 | 371s |
| **total** | **0/10** | **6/10 convinced** | **0.12** | **12** | **96,902,491** | **14,927s** |

**The cost: about 97M tokens and 5 hours of wall time for the set** (4h09m of ticket time, 4h58m end to end), one ticket at a time. That is a third of the 300M default cap, so one run of the set fits under it with room for a ticket like A11-449 (37M) going long.

**The tests column of this run does not measure the workers.** Two reasons, both found by re-running the check in the run's own trees:

- A11-140, A11-239 and A11-297 start from commits older than `check:changed`, so `DEFAULT_TEST` fails there with `Missing script: check:changed` whatever the worker did. Those entries need their own `test` (or replacing) before their tests score means anything.
- The other seven fail on tests that fail on this host without any change: in A11-397's tree, 8 of 5,438 failed, all in `src/packaging/host-units`, `src/packaging/org-health`, `src/ticket-mode/serve-ticket-only-host` and `src/tmp-fixtures-are-removed`, and the files the worker changed passed. The same files fail on a clean checkout of main on this host.

So until those are fixed, read the verdict, similarity and outside columns, and compare tests only between two runs on the same host, where the same host failures sit on both sides.

### Lessons off and on (A11-432)

`--set first --key tickets.lessons=off` and `=on` from 3eede5096, both at once, opus at effort medium, 2026-11-16 16:27–19:29 UTC. The on run's brief carried agent-org's 3 lessons, written by one run of the daily retro over the board's last 7 days with the set's own tickets left out (only A11-449 had runs in that window).

| ticket | tests | verdict | similarity | outside | tokens |
|---|---|---|---|---|---|
| A11-376 | fail → fail | convinced → convinced | 0.18 → 0.17 | 2 → 1 | 4.7M → 6.1M |
| A11-397 | fail → fail | not convinced → convinced | 0.27 → 0.16 | 0 → 0 | 6.7M → 4.5M |
| A11-344 | fail → fail | convinced → convinced | 0.12 → 0.14 | 0 → 0 | 5.2M → 4.3M |
| A11-340 | fail → fail | not convinced → convinced | 0.03 → 0.04 | 6 → 11 | 18.6M → 30.7M |
| A11-341 | fail → fail | convinced → convinced | 0.13 → 0.13 | 0 → 1 | 8.8M → 10.0M |
| A11-297 | fail → fail | not convinced → not convinced | 0.11 → 0.11 | 1 → 1 | 5.3M → 5.5M |
| **6 tickets** | **0 → 0** | **3 → 5 convinced** | **0.14 → 0.13** | **9 → 14** | **49.3M → 61.1M** |

The other four (A11-449, A11-394, A11-239, A11-140) have no worker run on either side: from about 19:20 UTC every worker exited within seconds, in both runs at once, and printed no tokens. The account answered again by 23:28. Running both runs at once spends the allowance twice as fast, so run them one after the other when the set is long. A failed worker's note now says why, from its result's error or its stderr, and its output is kept in `record/worker-failed.txt`.
