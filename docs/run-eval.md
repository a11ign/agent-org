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

The key must be a switch of the host file (an entry marked `switch` in `src/ticket-mode/config-schema.ts`) that the eval hands its worker, listed in `EVAL_SWITCHES` (`src/run-eval/worker.ts`); any other name is refused before a ticket starts. Today that is `tickets.drafts` alone: a switch the eval does not carry into the worker's brief or settings would run a whole set and change nothing. A feature that ships off (`tickets.lessons` above is the shape M3's would take) reads its key from the settings the eval reads (`readTicketSettings`), carries it into `HostBrief` so the brief the eval writes depends on it, and adds the key to `EVAL_SWITCHES` in the same pull request. The eval sets the key only in its own read of the host file: the file is not written, and the board does not see it. Each setting is stored apart, as `<sha>@<key>=on.json` and `<sha>@<key>=off.json`.

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
2. **The current brief.** The brief is `briefText` from `src/ticket-mode/worker-files.ts`, as the board would write it today. It has the host's notes, plugins, draft choice, pre-PR review skill and the tracker's keywords. The ticket, its parent and their attachments are read from the tracker (read-only). Only these differ from a real run:
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

Every call a stand-in receives is written to `record/attempts.log`.

These walls close every path the brief and the board's tools give a worker. They are not a container: a worker that went out of its way to read a credential file under `HOME` by its path could still use it.

## Spend

Evals run on the board's own Claude and Codex accounts: at most 10 tickets per set, at most 2 runs per pull request (a config key off and on), and under the token cap.

### The measured cost of the first set

MEASURED_COST_PENDING
