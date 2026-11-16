# The worker eval (`run-eval`)

The worker eval measures a change to the worker brief, the model or the effort before it merges. It replays merged tickets through a headless worker, offline, and scores what the worker made against what was merged. The reviewer has its own eval, `scripts/review-eval.ts`; this one is for the worker.

```sh
node scripts/run-eval.ts --set <name|path/to/set.json> [--only A11-1,A11-2] [--model opus] [--effort high]
```

A set named without a path is read from `evals/sets/<name>.json`. The model and effort default to the board's saved choice (`<stateDir>/tickets/choice.json`), so a run measures what the board would run today. The command prints the table and each ticket's throwaway folder. Every folder is kept, so you can read the worker's result, the brief, its diff and the review.

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

Evals run on the board's own Claude and Codex accounts: at most 10 tickets per set, and at most 2 runs per pull request (a config key off and on).
