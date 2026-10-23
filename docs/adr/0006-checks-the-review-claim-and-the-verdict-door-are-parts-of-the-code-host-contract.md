# A failing check's log and rerun, the review claim and the verdict door are parts of the codeHost contract (1.5)

## Context

Step 3 of A11-160 moves the reviewer's GitHub calls and ticket mode's reads of a red check into `plugins/github`. Four things were still `gh` in core: the log of the job behind a failing check and the rerun of its failed jobs (`ticket-port/ci-reads.ts`, called from `ticket-mode/pool-checks.ts` through the pool's raw `gh`), the review claim, a commit status that says which instance is reviewing a head (`ticket-port/review-claim.ts`'s `claimEntriesOf` and `writeClaimStatus`, called by the atomic reviewer through `ReviewerBoard.gh` and `ghWith`), and the verdict door, the shell program a reviewer posts its verdict with (`src/reviewer/pr-review-verdict.sh`, ten `gh` calls). A plugin imports core's types only (ADR 0001), and core imports no plugin (A11-159's boundary test).

## Decision

1. **Operations are named for what core asks.** `readCheckLog(detailsUrl)` and `rerunFailedChecks(detailsUrls)` take the address a check reports (`FailingCheck.detailsUrl`), so core no longer parses a GitHub Actions address. `readReviewClaims(repository, head)` answers `{ entries }` or `{ unreadable: <reason> }`, and `writeReviewClaim({ repository, head, description, environment })` answers `null` or why it was refused; `environment` is the reviewer role's (`reviewerEnvironment`). They are required members, like `readReplies` (1.2).
2. **The claim protocol stays core's.** `claimHead` and the descriptions it reads are pure over an injected `read` and `write`, and decide who holds a head; only the calls that back the two moved.
3. **The verdict door is one optional member, `verdictDoor`: `{ source, installer }`, absolute paths of files the plugin ships.** Core still installs and compares it (`host:check` and the host's install), asking the activated code host for the paths. A code host with no door installs none.
4. **Contract version 1.5.** A plugin of 1.4 is not read as implementing the four operations; while plugins are in-repo that is the same pull request (Decision 8 of A11-157).

## Why

A generic `gh(args)` would keep GitHub's command language in core (ADR 0002). Returning a reason instead of throwing keeps `claimHead`'s `reasonOf` (the first line GitHub printed) the board's words without core knowing what a process failure looks like. Shipping the door as a path keeps core the one writer of installed files, as for the wrapper (ADR 0003).

## Considered

- **Moving `claimHead` into the plugin**: rejected. The protocol is the same for any code host that can keep a status on a head, and the pool's tests of two instances run it over the fake.
- **A `rerunFailedChecks` that takes run ids**: rejected. A run is GitHub's word; the address a check already reports names it.
- **Moving `gh-identity.ts` and `review-trust.ts`'s declared-identity reads now**: left. They read account files and spawn no `gh`; they move with the gate (steps 6 and 8), as ADR 0003 says.

## Paths

- `agent-org:plugins/github/`
- `agent-org:src/plugins/contracts/code-host.ts`
- `agent-org:src/ticket-mode/pool-checks.ts`
- `agent-org:plugins/atomic-reviewer/port.ts`
