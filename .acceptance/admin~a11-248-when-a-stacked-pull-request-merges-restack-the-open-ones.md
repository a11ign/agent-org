Closes A11-248

Step 2 of 2: a member of a stack left with no changes of its own (everything it held merged below it) is closed with a comment instead of being left open. When the member below a finished stacked run's open pull request merges, agent-org merges the default branch into the open one (`updateBranch`, no rebase, no force-push; step 1 and the earlier work). Step 2: the board reads the member's files on a later sweep; when the list is complete and every file is scaffolding (`.acceptance/`, `.changeset/`) or there is none, the head is one it can trust, a second read on a later sweep finds the same, and no other run is stacked on it, it closes the pull request through the code host's new optional `closePull` (contract 1.23, the workers' account) and the card shows "#N closed: everything it held merged with #M". A refused close shows GitHub's reason and is tried again; a host without `closePull` says to close it; a member whose restack conflicted or was refused is never closed.

Acceptance:
```bash
# An empty member is closed (stale head not trusted, refusal retried, no closePull noted, conflict never closed, a closed member starts nothing), the pure decision and notes, and the earlier restack tests as they were.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-restack-close.test.ts src/ticket-mode/stack-restack-close.test.ts src/ticket-mode/pool-restack.test.ts src/ticket-mode/stack-restack.test.ts src/ticket-mode/pool-stack-merge.test.ts src/ticket-mode/stack-rebase.test.ts src/ticket-mode/pool-restack-order.test.ts
# The code host: GitHub's close (arguments, refusal in GitHub's first line), the fake's, and the contract suite on both.
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/close-pull.test.ts plugins/github/conformance.test.ts plugins/github/index.test.ts src/plugins/fakes/code-host.test.ts src/plugins/built-in.test.ts
npm run typecheck
npm run lint
```
Run with `AGENT_ORG_HOST` naming a host declaration, as CI's `suite` job does (the fixture project copied to a temporary directory).

After merge (run by the chairman session; no person acts on the stack, and the check changes nothing, so it needs no cleanup): the next stack whose bottom member merges has the rest restacked with no person. When that stack's blocker pull request merges, the session reads the run's notes with
`jq '.entries[] | select(.ticket.key=="<KEY>") | .retargets' ~/.local/state/agent-org/tickets/queue.json`. A pass is `#P restacked on main after #N merged` (or the conflict note, with a conflict round whose brief names the stack and the merged member), and `gh pr view <url> --json commits --jq '.commits[-1].messageHeadline'` reads "Merge branch 'main' into …". For a member left with nothing of its own, a pass is the note `#P closed: everything it held merged with #N` after a second sweep, and `gh pr view <url> --json state,comments` showing it CLOSED with the comment `Closed by agent-org: everything #P held merged with #N…`.
