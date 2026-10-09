# agent-org

## 0.104.2

### Patch Changes

- 0261555: The gate no longer orders a worker to fix a red pull request whose row waits on an open native `blockedBy` edge, until the head changes or the edge closes. A wait carried as DATA excused nothing (only a `hold:*` label did), so lab#49 at `a5b63eaf` was ordered 6 times against a cap of 3 and `STUCK ... delivered 6 times` repeated for 63 minutes. `withWaitingEdges` (`work-gate/pr-waits.ts`) stamps `waitingOn: { edges, head }` from the rows already in hand, `head` being the head the wait was first seen at (kept in `pr-waits.json`, forgotten the tick the edge is gone), and `failingChecksOrder` asks `isWaitingRed` beside `isHeldRed`. A push is a new head and the order is emitted again; a closed edge ends the wait; `endedRuns` writes `RESET` for the key that stopped. a11ign/a11ign#4606.

## 0.104.1

### Patch Changes

- f26f4a4: The declared copies in `src/lib/` all name an original that exists, so `copies-drifted` reads `clear` over the 19 of them and not `unknown`. `cli-flags.ts` named `packages/worker-fleet/src/cli-flags.ts`, which left the workspace in a11ign/a11ign#3504, and now names `scripts/cli-flags.ts`; seven copies (`ci-changed`, `isolation-gate`, `test-memory-cap`, `tree-wide-guard`, `walk-scope`, `walk-scope-discovery`, `worktree-resolution`) took the original's last commit and a recounted allowance, their only differences being JSDoc against TypeScript annotations and one renamed path. a11ign/a11ign#4582.

## 0.104.0

### Minor Changes

- 843fb11: Every source file is `.ts`, run by `node file.ts` with no loader. The 110 held-back `.mjs` under `src/` were renamed (history kept), `tsx` left `dependencies`, and `engines.node` is `>=24`, so Node strips the types itself (`process.features.typescript` prints `strip`). The six units (kernel-reboot, otel-receiver, shadow-window, tmp-prune, trace-publish, work-tick) name `%h/.local/bin/node` and a `.ts`, and the work-tick `--import=` preload is `src/lib/crash-exit.ts`. The `bin` and every `exports` entry name a `.ts`, and `@a11ign/toolchain` stays a dev dependency. Node refuses to strip types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, measured on 24.21.0), so the tool runs from a checkout outside it, through `host/agent-org`; a copy installed under `node_modules` can be read but not run. a11ign/a11ign#4389.

## 0.103.0

### Minor Changes

- 3356070: The gate offers Ready rows in one declared order (a11ign/a11ign#4524): a `priority:chairman` row first, then `priority`, then the project's milestone ranking, then the oldest. A `priority:chairman` label counts only when the tracker's history shows a login in `CHAIRMAN_LOGINS` added it (any other actor's is ignored, said on stderr and reported to `ceo`), and its order carries `startFresh: true` for the spawner. `priority` now also overrides the product-share floor, which binds plain rows only. A chairman row is no longer shelved by B4 against a holder that is not itself a chairman row: it is offered and the holder is told to rebase; a chairman row that is refused is reported to `ceo` with the reason. A project ranks milestones with the optional `offerMilestones` list in `.agent-org/project.json` (a milestone number or title, primary first); absent, rows are ordered as before. The Ready-row read now asks for `milestone`.

## 0.102.3

### Patch Changes

- fdad359: The copies `src/lib/git-sandbox.ts` and `src/lib/tree-wide-guard.mjs` carry their a11ign originals' renamed paths again: the comments name `tree-wide-guards.ts`, `local-import-closure.ts` and `git-env.ts` as the originals now do, and the headers name the originals' current last commits (`a0a4e91c8`, `f3b5c5f59`). `tree-wide-guard.mjs` names ten changed lines, the nine type lines and its one import, which stays `./git-env.mjs` because the tool's own `git-env.mjs` sits beside it. So org-health's `copies-drifted` reading no longer trips on either copy (a11ign/a11ign#4557).

## 0.102.2

### Patch Changes

- f7a753e: A Haiku-tier worker starts at `--effort high`, the same as the Sonnet workers, not `low`. `HAIKU_EFFORT` was the floor of `CLAUDE_EFFORTS`, assumed and never measured; `low` would have confounded the #4382 trial, since a Haiku failure could not be told apart from the effort. The Haiku profile test now pins `high`, and a mutation back to the floor turns it red. a11ign/a11ign#4522.

## 0.102.1

### Patch Changes

- b17e82b: The headers of `src/lib/product-home.mjs` and `src/lib/fixture-symbols.ts` name the `.ts` originals the core renamed them to (`scripts/product-home.ts`, `scripts/fixture-symbols.ts`, a11ign/a11ign#4274), so `readDeclaredCopies` reads both and `copyDriftReading` can answer `clear` for them instead of `unknown` (a11ign/a11ign#4515). Reading them showed the originals gained types: `fixture-symbols.ts` is now byte-identical to its original (header: `NOTHING`), and `product-home.mjs` names a fourth changed line, the `productHome` signature it keeps untyped.

## 0.102.0

### Minor Changes

- 3d28c01: A second occurrence of a failure class files the class row by itself (a11ign/a11ign#4451, move 1b of #4437). `readClassRepeat` now also reads the `failure-ledger` (a class key with two DISTINCT refs is a repeat, the same ref twice is one standing event) and counts those events beside the closed `class:<id>` rows. A class with `guard: null`, or whose newest occurrence is inside `CLASS_REPEAT_WINDOW_MS`, is filed ONCE as a `--kind defect` row through `row-file` (milestone "Self-healing org", label `class:<id>`, every occurrence listed, an Acceptance and an Open-check the row-file validators accept); the filing is remembered in `class-repeat-filed.json` in the state directory, written only after `row-file` landed, so a failed filing is retried and a filed one is not repeated. `org-health`'s `class-repeat` order is kept for `ceo` but now says whether the class row was filed (`was filed as #N`) or REFUSED and why (`THE CLASS ROW WAS NOT FILED: row-file refused (…)`). Filing and the ledger read are opt-in through `ClassRepeatIo`; the work gate passes `liveClassRepeatIo()`.

## 0.101.0

### Minor Changes

- c739a38: The daily retrospective prints the chairman's corrections per UTC day beside the spend pace, with a day-over-day trend (`correctionsPerDay`, a11ign/a11ign#4453). An unreadable ledger reads as unknown, never `0`, and a day before the failure ledger existed has no baseline, so no trend fires for it. `chairman-correction` has no recorder yet (#4452 shipped only the `unidentified-caller-order` proxy), so until one exists the line reads `0` for every covered day and says so; the proxy is not counted as a correction.

## 0.100.0

### Minor Changes

- 4069462: The Acceptance is read from the file a pull request ADDS under `.acceptance/`, falling back to the body (a11ign/a11ign ADR 0044, row 1). The file holds the body's own grammar and goes through the same `acceptanceReport` and `extract*Section` functions; the report prints `ACCEPTANCE-SOURCE: file <path>` or `ACCEPTANCE-SOURCE: body (deprecated)`, and two added files are refused as two `Acceptance:` headers are. `pr:open`/`pr:edit` refuse a diff that adds no file, naming it (`.acceptance/<branch with / as ~>.md`) and writing it from a body that carries an `Acceptance:`; `checkBody` takes `readFile` and a diff's `added` list. `.acceptance/` is exempt from the Region check, `ownedPaths` and B4. The reader is exported as `agent-org/acceptance-file`, and `acceptanceSourceOfThisPullRequest` from `agent-org/acceptance-commands`, for a project's workflow to read the same text the commands come from. `Closes` stays in the body.

## 0.99.0

### Minor Changes

- 4ea173f: A MANAGER's gate order (`ceo`, `product-manager`, `orchestrator`) is asked about by the host's triage provider (`triageOrder`, a11ign/a11ign#4384) before it is delivered, and an answer of `digest` or `drop` HOLDS it (a11ign/a11ign#4385). Nothing is dropped: a held order sits in `triage-digest` beside the wake ledger, rides the same seat's next real order as a `HELD FOR YOUR NEXT ORDER` section, and is delivered alone by the work-tick once its oldest item is 60 minutes old (a quiet tick with a due item is no longer quiet). It enters the wake ledger only when delivered. A worker's or reviewer's order, a chairman-bound one, a resumed one, a `--needs-decision` one and every order with no `cause` are never sent to the provider. Below the host's `triage.minConfidence`, or on any provider error, the order is delivered as before; every asked order leaves a `triage: { route, via, confidence }` line. With `provider: "none"` (the one-line revert), or no `triage` block, nothing is asked or written and delivery is byte-identical; orders held under an earlier setting still ride or flush. The route never labels, comments, edits or sends.

## 0.98.0

### Minor Changes

- 329e654: The gate's product share now follows `adopterFacing`. A Region entry under a `dora` repository the project declares `adopterFacing: false` no longer counts as a PRODUCT row for the engineer pool's 6-of-10 floor (`offeredByShare`, `recordEngineerStarts`), so a sweep of such a repository reads as `org`, is recorded as an org start, and is held back while the share is below the floor and a product row is offerable. A row with any entry under an adopter-facing repository stays product, and a project that declares no `adopterFacing` is read exactly as before. The gate still never idles an engineer to hold the ratio: with no product row offerable it prints `NO PRODUCT ROW OFFERABLE` and offers every row. a11ign/a11ign#4399.

## 0.97.0

### Minor Changes

- 1ac70b4: `prompt:session` records every order it queues or delivers in the failure ledger (a11ign/a11ign#4452, move 3 of #4437): the order's class, from a `Class: <key>` token alone on a line of the text (`unclassified` without one), and `unidentified-caller-order` besides when the caller is not a session herdr lists, the measurable proxy for a chairman-session correction. Identity is never self-declared: a text that says it is the chairman, or names `chairman-correction` as its class, is not recorded as it. `chairman-correction` is written by nothing yet, because the host runs every session as one uid and holds no root-owned file naming the chairman. The ref is `<addressee>/<ms>-<digest of the text>`. A refused append is one stderr line (`failure-ledger: NOT RECORDED …`) and does not change the order's exit code; a refused order is not recorded.

## 0.96.0

### Minor Changes

- e38a66b: `team-access-drifted` can now be told that a team is deliberately kept at another level on one repository. A team in the project's access declaration may carry `exceptions`, `{ "<owner>/<name>": "<level>" }`, and the signal then expects that level there instead of the team's `layer`: a team held to `push` that is meant to stay off a repository (`"none"`) is clear when it holds nothing there and tripped when it holds anything else, so a repository kept off on purpose no longer trips for as long as it is declared. `admin` is still a trip anywhere and is refused as an exception's level; an exception naming a repository the declaration does not list, naming an unknown level or not a map is `CANNOT_TELL` with the reason, never ignored. A declaration with no `exceptions` behaves exactly as before. a11ign/a11ign#4467.

## 0.95.1

### Patch Changes

- 1872630: `pr:open` refuses a bare `Closes #N` in a layer repository's PR opened without `--repo` (a11ign/a11ign#4469, split from #4401). `checkRegion` read the PR's repository from the flag alone and fell back to the tracker, so lab#39's `Closes: #4305, #4372` passed from a lab checkout and B4 shelved #4372 for 71 ticks. With `--repo` absent it now reads the checkout's `origin` (the read `repoFlagHint` already made, now one `originRepoOf`) for the bare-number test only; the tree the Region is read against is chosen as before. The refusal names `Closes a11ign/a11ign#<n>`.

## 0.95.0

### Minor Changes

- d263bf0: A row B4 shelves against a pull request that waits on that row is a circle, and `org-health` says so (a11ign/a11ign#4401). `shelvedCircles` reads the gate's shelving list, the open pull requests and the open rows (no new `gh` call) and names a row whose `overlaps <PR>,` reason points at a PR that is held, parked or red AND leads back to the row by its `Waiting-for`, by `blockedBy` on a row it closes, or by that row's `Waits-on-done-when`; a PR that is unheld and green on the same file is a real collision and is not named, and a PR declaring `Closes` for the row is B4's own-PR exemption and is never shelved. The new `row-shelved-against-the-pr-that-waits-on-it` signal orders `product-manager` and `ceo` the tick it holds (the circle cannot clear itself, so no bound is waited), naming both numbers, the route, and why the PR is not counted as the row's own: `Closes: none`, or a bare `#N` in a layer repository's PR, which names that repository's issue and is dropped (write `owner/repo#N`). A refused read is `unknown`, never clear. `orgHealthNow` reads the shelving list once per tick and hands it to both this reading and `idle-with-open-rows`, and the signal is a `DIGEST` class for `ceo` in the suppression table (its first reader, `product-manager`, is ordered unfiltered).
- 4617631: A failure ledger: `failure-ledger` in the state directory, an append-only log of EVENTS that never become a closed row, one `<classKey>\t<ts ms>\t<ref>` line each, beside `wake-deferral-log` (a11ign/a11ign#4450, move 1a of #4437). `src/failure-ledger.ts` is a leaf with `recordFailure`, `recordFailures` (an event already logged under the same key and ref is not written again, so a red `main` seen by every tick is one line), `parseFailureLedger` (throws on a malformed line) and `repeatsIn` (class keys seen with two or more DISTINCT refs in a window). The work gate's primary tick now records three kinds: `main-red` (the red run, from the `readTrunkRed` reading the tick already makes), `owner-unresolved` (an open pull request `ownerOfPr` could name no one for) and `hand-reroute` (the hand-fix ledger's entries, read at most once a day). A recorder never throws into the tick; a refused append is reported on stderr as `failure-ledger: NOT RECORDED …`. The red `main` of a keyed scope is not recorded yet, and `pr-red`, `worker-excluded` and `chairman-correction` are seeded kinds with no recorder.

### Patch Changes

- 61d0412: `host:check` no longer calls a worker on a `tier:haiku` row "SESSION ON AN UNDECLARED MODEL". `sessionModelDrift` compared every live session with `DECLARED_CLAUDE_MODELS`, which holds Sonnet only, so each Haiku-tier worker (`claude-haiku-5-5` by design) sent a `host-units-stale` order for the intended state. A `worker-<n>` session is now expected on `HAIKU_MODEL_ID` when row `n` carries `HAIKU_TIER_LABEL`: Haiku there is clean, Sonnet there is the finding (naming the row and both ids), Haiku on an unlabelled row is still a finding, and a row that cannot be read keeps the old comparison. a11ign/a11ign#4457.

## 0.94.0

### Minor Changes

- 190770e: `row-file --board=<n> --lane=<owner>` boards an `epic`-labelled row (a11ign/a11ign#4456). An epic has no Region, Acceptance or Open-check, so the claimability refusal it shares with `--promote=` could never let it onto Project 1, `row-off-board` named it every tick, and a human boarded it with raw `gh project item-add`. An epic now skips the body check (and only that: a closed or claimed epic is still refused), boards at Status Backlog with `backlog` and its lane label, and never gets `ready`. `promoteGate` is split into `openUnclaimedGate` and `claimableBodyRefusal` to allow it. The `row-off-board` order now names `--board=<n> --lane=any` for an epic.

## 0.93.1

### Patch Changes

- c35caca: `arm-pr` reads a closed row's labels from the repository the row lives in. `labelArmedPr` and `labelsWanted` asked the PR's own repository, so an `a11ign/agent-org` PR closing `a11ign/a11ign#4386` printed `Could not resolve to an issue` and was armed without the row's `session:` label. Both now read `closedRowReferences(prBody, repo)` through one `readRowLabels`, and a bare `Closes #n` still reads the PR's own repository. a11ign/a11ign#4426.

## 0.93.0

### Minor Changes

- 216298e: `org-health` raises `node-cannot-strip` when the `node` a session's PATH resolves, or any `node` an `ExecStart` of a rendered unit names, does not print `strip` or `transform` for `process.features.typescript` (or cannot be run at all), so a distro Node without type stripping cannot quietly come back (a11ign/a11ign#4390, ADR 0043 Decision 8).

## 0.92.2

### Patch Changes

- f815a4f: The release checks its consumer before it tags (a11ign/a11ign#4412, b of #4407). `release.yml` gains a `consumer-check` job that the tagging job `release` `needs`: it runs `src/public-interface.test.ts` (every declared subpath and name is still delivered), then `src/release-consumer-check.test.ts` against a11ign/a11ign's current `main` (every `agent-org/<subpath>` and name a11ign imports is in the declared list). A red check leaves the tag uncut, so a rename that breaks a consumer, as v0.88.0's `.mjs` -> `.ts` did, is held at the merge and never ships. `release-consumer-check.test.ts` pins the job, its order and that nothing excuses it, with a negative control for each; `release-tag-on-merge.test.ts` and `release-triggers-itself.test.ts` now expect the two-job shape.

## 0.92.1

### Patch Changes

- 1638791: A pull request of another repository than its rows (agent-org's) is now owned by the worker its row names, and the fallback that still fires files its own defect (a11ign/a11ign#4386). `scopeTick` never ran the owner ladder, so agent-org#436 and #437 each ordered `ceo` with `NOBODY COULD BE NAMED` while `worker-4371` and `worker-4384` held their rows. A scope with no tracker of its own now reads its pull requests' owners from the primary tracker's rows: the PR's own `session:` label, then a `Closes`/`Fixes`/`Resolves`/`Row:` line or GitHub's closing reference written `<owner/repo>#<n>` (a bare `#n` there is the PR's own repository's issue and matches nothing), then the row number its branch `agent/<slug>-<n>` ends in; two different claimants are a split, not a guess. A pull request that still reaches `ceo`'s rung while naming exactly one live claimant is a resolver defect: the gate files one `resolver-defect` row and comments on it for each later PR, once per pull request. `pr:open create` refuses, before anything is sent, a PR whose owner it cannot name (no `.a11y-owner` stamp and no row in `Closes` carrying `session:`), where it used to skip the label without a word.

## 0.92.0

### Minor Changes

- 8a67f19: agent-org now declares a public interface, so a project reaches it by a NAME and not by a path under `src/` (a11ign/a11ign#4407). `package.json` gains an `exports` map -- `./acceptance-commands`, `./board-data`, `./board-document`, `./leak-patterns`, `./merge-guard-lookups`, `./newest-check-run`, `./pr-open`, `./project-config`, `./tree-wide-guard`, `./package.json` -- and `src/public-interface.test.ts` pins the list, the names each one must export (the ones a11ign's callers use) and the `bin` subcommands a project runs (`acceptance-commands`, `owned-path-signoff`, `board:document`, `worktree:whose`, `worktree:stamp`). A source file may be renamed or moved freely so long as the `exports` target follows it; removing a declared subpath or a declared name fails the test. Targets are `.ts` or `.mjs`, so a consumer imports them under `node --import tsx` exactly as `bin.mjs` runs its programs. Adding `exports` closes `agent-org/src/...` deep imports through the package name; paths read off the filesystem are unaffected. Minor, because while the version is `0.x` a minor is the level a pinned project reads.

## 0.91.0

### Minor Changes

- 333c788: The `gh` wrapper (`host/gh`) refuses `gh pr create` unless `A11Y_PR_OPEN` is set (a11ign/a11ign#4397), and `pr:open` sets it on its own `gh` child. A raw create skips what `pr:open` does (the session label, the `Acceptance:` and `Closes` check, the Region check), and agent-org#436 was opened that way. **A worker that types `gh pr create` now gets a one-line refusal naming `pnpm run pr:open` and exit 1**; it exits before `gh-real` and before the call ledger, so it writes no line. `pr list`, `pr view`, `pr edit` and every other call are untouched, and a runner (no wrapper, such as the release workflow's own `gh pr create`) is not affected. **`host:install` copies the wrapper, so the refusal reaches a host only when the host operator installs it.**

## 0.90.0

### Minor Changes

- 6602e95: A row labelled `tier:haiku` gets a `claude-haiku-5-5` worker (a11ign/a11ign#4382, the chairman's spend direction of 2026-10-09, part 2: a trial). `spawnClaimer` now answers `tier(claimed)` by reading the claimed row's labels and body, and `spawnInvocation` takes the resulting profile as its fifth argument; a row without the label is byte-identical to before. The Haiku launch is `--model claude-haiku-5-5 --effort low --autocompact 130000`, the window DERIVED in `worker-profile.ts` from a named `HAIKU_PROMPT_CEILING_TOKENS` (100,000, the prompt Haiku 5.5 accepts), a 5,000 headroom and the 35,000 compaction margin, so the trigger lands at 95,000 inside the ceiling and leaves a fresh worker about 30,000 of working room. `src/haiku-tier.json` (`{ "enabled": true }`) is the switch `ceo` flips: `false`, a missing file and a malformed one each give the ordinary profile and log the reason. A `tier:haiku` row that is `lane:ceo`, carries `needs:chairman`, names `.github/workflows/` in its Region or has no Acceptance command gets the ordinary profile and a logged reason; an unreadable row does too. `node src/trace/haiku-tier-report.ts` prints, for `tier:haiku` rows and the other rows closed in the same window, first-pass merge, review rejections per pull request, compactions and cost per closed row (turns per row beside them), each with its n ("n=<k>, not a rate" under 8 rows), and applies the stop rule's conditions (a) to (e) to them.

## 0.89.0

### Minor Changes

- eb4ba6b: The primary milestone holds adopter-facing rows only. A `dora` entry of the project declaration may carry `adopterFacing: false` (default `true`, absent stays absent, any other type is refused), naming a repository whose releasable change reaches no outside adopter. `row-file` then REFUSES an org row filed into the milestone whose description carries `Primary: yes`, naming the Region entry that made it org and the remedy (`--milestone "Out of release" --label out-of-release`); a row whose Region cannot be read is org by `rowKind`'s own word and is refused saying so. `milestoneClockFact` counts only the rows that read as adopter-facing, so a misfiled org row neither holds the milestone alarm quiet nor makes it fire; a row whose Region cannot be read counts as UNKNOWN (the clock reads unknown), never as product, and an `epic` is not judged. Both read one rule, `adopterRowKind`: #3820's `rowKind` over the `dora` repositories not declared `adopterFacing: false`. a11ign/a11ign#4378.
  
  DORMANT until a `dora` entry names `adopterFacing`: a project that declares none is read exactly as before, because without the key `rowKind` alone calls a docs-only Region org (the live declaration reads #4356, the outcome-3 measurement row, as org), and declaring it today would drop a real row from the milestone's count. `ceo` ruled (a11ign/a11ign#4378, 2026-10-09) that #4356 COUNTS, by declaring the one path an outside adopter reads (`docs/unfamiliar-ui-findings.md`) releasable for `a11ign/a11ign`, and NOT by widening the lab's `releasablePaths`; the follow-on declaration row (a11ign/a11ign#4396) carries that.
  
  NOT changed: the #3820 product share (the 60%) still counts by `rowKind` over every `dora` repository other than the tool, so `toolchain`, `control` and `lab` rows still count as product there. `ceo` ruled it SHOULD follow `adopterFacing`, in a separate row after a11ign/a11ign#4396 that posts the before/after count of offerable rows by kind first.

## 0.88.2

### Patch Changes

- c0d766b: A merge that renames or deletes a program an INSTALLED unit runs no longer stops the tick, which is the only thing that wakes the session whose job is to install the unit (a11ign/a11ign#4392; agent-org#435 crashed the tick at 06:05:02Z on 2026-10-09). `update-tool` now reads the programs the installed `<prefix>*.service` units and the installed `agent-org` launcher run (the `Exec*=` lines, resolved against the unit's `WorkingDirectory`, and the launcher's `exec` line), and HOLDS the tool's checkout, saying `host-install-pending`, when the release tag's tree lacks a tracked file they run at HEAD; a program already absent at HEAD is not counted, since the move cannot make it worse. `host:check` reports the same question as `host-install-pending` findings (one per unit, or the launcher), so the gate's existing `hostDriftOrders` wakes `orchestrator` with the unit names, from a tick that still runs; the finding's remedy is to install from a fresh worktree at the release and advance in one command line. It clears itself: once the units and launcher name programs the release has, the next update advances. A host that names no `tool`, or whose installed units cannot be read, moves as before and says so on stderr.

## 0.88.1

### Patch Changes

- 31c2d0d: Fix: a spare engineer's claim is recorded in the spare registry when `row-claim` makes it, so a row it claims and then releases (or sees close) before a tick still counts as its one row and a second claim is refused with `one instance, one row` (a11ign/a11ign#4387, after `worker-4069` held #4069 and #4274). The registry was written only by a tick's teardown, so a release in between left no label and no entry. If the registry cannot be read or written the claim still goes through and says so on stderr.

## 0.88.0

### Minor Changes

- ddad38a: The host declaration (`host.json`) gains an optional `triage` key: `{ "provider": "jev" | "none", "keyPath": "<absolute path>", "minConfidence": 0..1 }`. Absent, `"none"`, or a `jev` provider whose key file cannot be read all behave exactly as before (every order wakes; the unreadable key is recorded as one `triage-unavailable` line per process). `src/triage-provider.mjs` adds `triageOrder`, which returns a route (`wake`, `digest` or `drop`) as data and routes nothing itself. `provider: "haiku"`, any other provider, a `minConfidence` outside 0..1 and a `keyPath` that is not an absolute path are refused by name.

## 0.87.11

### Patch Changes

- cfb0f73: A stuck cause about a pull request is no longer filed as "`main` is red" (a11ign/a11ign#4360). `fileRepositoryRow` read nothing of the cause's kind, so `worker-4305/pr-checks-failing/pr-lab#39/fe4dce88` (a red pull request waiting on a native chain) was filed as "Stuck trunk-red: lab#39 -- `main` of a11ign/lab is red", and `ceo` spent a read proving lab `main` green. The wording now comes from the key's middle segment: `trunk-red` keeps its title and body; `pr-checks-failing` is titled "Stuck pr-checks-failing: lab#39 -- a pull request of a11ign/lab is red and nothing has fixed it" and asks whether the pull request is waiting on something; any other kind is worded by its own name. Each kind has its own title, so the dedupe by title is unchanged. Open `Stuck trunk-red:` rows are not re-titled.

## 0.87.10

### Patch Changes

- c81db1a: The top level of `src/` is TypeScript: 140 files renamed by `js-to-ts` and the residue fixed to a clean `tsc --noEmit` (a11ign/a11ign#4272). Every command that runs one names the loader (`node --import tsx file.ts`), `tsx` is now a runtime dependency because the installed tool and `bin.mjs` load it, and the ratchet baseline falls from 252 to 112 files. The sources a plain-`node` entry imports stay `.mjs`.

## 0.87.9

### Patch Changes

- 12b4891: The slice of the gate's subdirectories that plain `node` never loads is TypeScript: the rstest config, `update-primary-argv` and two work-gate tests are `.ts`, converted by `js-to-ts` (a11ign/a11ign#4271). The 29 sources a plain-`node` entry imports stay `.mjs`, and so do the CI scripts that run before any install.

## 0.87.8

### Patch Changes

- 12c0aa2: 41 of `src/messaging`'s 74 `.mjs` files are TypeScript (a11ign/a11ign#4270, sweep 2 of 4 of the chairman's third direction): `ask-ceo`, `check`, `correct`, `measure`, `provider-contract` and 36 messaging tests, renamed and rewritten by the toolchain's `js-to-ts`; the `messaging:measure`, `chairman:correct` and `chairman:ask-ceo` scripts now run `node --import tsx` because `/usr/bin/node` cannot load a `.ts`. The other 33 stay `.mjs` because a plain-`node` entry (`work-gate`, `wake`, `work-tick`, the `agent-org` command table, a unit) imports them, directly or through a file that stays. No behaviour changes.

## 0.87.7

### Patch Changes

- 39177d5: 18 of `src/lib` and `src/trace`'s 59 `.mjs` files are TypeScript (a11ign/a11ign#4269, sweep 1 of 4 of the chairman's third direction): `lib/fixture-symbols`, `lib/pin-ratchet`, `lib/sandbox-exhaustion`, `trace/clock-feed` and 14 trace tests, renamed and rewritten by the toolchain's `js-to-ts`. The other 41 stay `.mjs` because `/usr/bin/node` cannot load a `.ts` (ADR 0043): a plain-`node` entry imports them, or a unit, a project script or the `agent-org` command table runs them by path. No behaviour changes.

## 0.87.6

### Patch Changes

- 5724065: `row-file`, `row-file --promote` and `pr:open` now refuse an Acceptance command that `cd`s into the project's own primary checkout (a11ign/a11ign#4322, found on #4318). CI has no such path (the `acceptance` job died three times on `cd: /home/agent/repos/a11y-witness: No such file or directory`), and on the host the line reads the PRIMARY checkout, which carries the change only after the merge, so it passed or failed for the wrong tree; 21 open rows had it. Both spellings #4220 carries are caught, the bare `cd <path> && cmd` and the same inside `bash -c '...'`. The path is read from the host's declaration (`host.json`'s primary project), never typed into the check, and a host with no readable declaration (a CI runner) skips the check rather than guessing. A `cd` into another repository's checkout is not refused, and a body with a `Hand-run:` line keeps that declaration's meaning. `pr:open` refuses before the command is run.

## 0.87.5

### Patch Changes

- 3c44fd0: The retrospective's "Unwaited stock rows" no longer counts a `needs:chairman` row or a `meta` row. The 2026-10-09 report printed `2: #20; #2568` and could never read 0: #20 is the daily board report's standing `meta` row (`backlog` by design, no condition to wait for) and #2568 is a chairman wait that `chairman-blocked`'s daily reminder already moves, so a genuinely forgotten third row would have been invisible beside them. Each label is now read as the wait it is, before any timeline is fetched; the exemption is the label the row carries and not a list of numbers, so a new standing row needs no code change. The report's wording for a counted row is unchanged. a11ign/a11ign#4323.

## 0.87.4

### Patch Changes

- e69a686: A reviewer for a pull request in a keyed repository now starts when its install fails only because a declared package is not published. `a11ign/lab#38`'s reviewer was `UNDELIVERED` for 30 ticks: lab declares `@a11ign/control`, which no registry holds, so `pnpm install` in the review tree answers `ERR_PNPM_FETCH_404` and the start path read "cannot install" as "cannot review". The tree is now linked with what the clone has, and the reviewer's order says the dependencies were not installed because the named packages are unpublished, to judge the Acceptance from the repository's `checks` run on the head and to say so in the verdict. Any other install failure (network, lockfile, a version the registry lacks, a 404 for a name the tree does not declare, or a 404 beside another error) still refuses, unchanged. a11ign/a11ign#4321.

## 0.87.3

### Patch Changes

- 6349d7e: The board-truth audit's flag for a handoff written as prose now reaches its author as an order. `handoff-in-prose` and `reading-without-defect-row` were only listed in the day's table, which is read once a day, so the sentence moved nobody and neither did the flag. When the tick posts a day's table it now also adds `answer:<route>` to each row a finding names (the session the comment's first words name, else the row's owner), once per row and route, through `POST /issues/{n}/labels` (idempotent, and it creates a label that does not exist yet). The label goes before the table, so a table that fails to post is retried without a second label; a label GitHub refuses is logged and the others still go; a day whose table is already posted reads no comments and labels nothing. a11ign/a11ign#4250.

## 0.87.2

### Patch Changes

- 37f2245: The README names the `.mjs` ratchet and no longer gives a rise rule. Its source-file paragraph still said `src/packaging/mjs-source-count.test.ts` pins the count and that a shipped command's import may raise it; that test was deleted by a11ign/agent-org#419, and the ratchet (`mjs-ratchet.test.ts` against `mjs-ratchet.baseline.json`) has no raise: a new file is `.ts`. One comment in `worker-profile-headless.test.ts` named the same deleted test and now names the ratchet. a11ign/a11ign#4299.

## 0.87.1

### Patch Changes

- 6b178a3: The primary-milestone clock (`primary-milestone-idle`) starts at the milestone's real last move, not at the last merge anywhere. #4231 used the merge the tick already holds as a proxy, which is later than the milestone's own last move whenever something else merged (silent) and EARLIER than it when a claim was released or a pull request closed with no merge (a false alarm to `ceo`: the milestone had moved 30 minutes ago). When the proxy has ALREADY tripped, `exactMilestoneClock` now makes one conditional read (`readMilestoneMoves`) and takes the later of the proxy and the latest of: a `session:*` or claim label removed from a row of the milestone, a row of the milestone closed (both from the tracker's issue events), and a closed pull request of a declared repository that declares it closes an open row of the milestone (merged or not). A tripped tick makes 1 to 3 pages of the tracker's issue events plus 1 to 3 pages of closed pull requests per declared repository (core pool, each page 100 items), and a clear or unknown tick makes none. A refused read, or a list that does not reach back 120 minutes within three pages, is UNKNOWN (said on the log, no order), never clear; the other orders' `ALSO TRIPPED` line follows the clock's outcome. The exact read is the real one only when the merge read is (a caller that passes its own `lastMergedAt`, as every test does, reaches no remote). a11ign/a11ign#4295.

## 0.87.0

### Minor Changes

- 17bf9cc: `row-file` refuses a filing whose title an OPEN row in the tracker it files into already carries. A filing driver launched twice filed three layout rows twice, 18 s apart (a11ign/a11ign#4223 = #4222, #4225 = #4224, #4228 = #4227), and the tool never asked about the title; #4043's detector reads the board daily, after the copy is claimable. Before `gh issue create`, one `gh issue list --state open --search '"<title>" in:title' --limit 100` is read and the titles compared exactly after trimming, collapsing inner space and folding case; an equal one refuses, naming its number ("an open row #N already has this title; if this is a retry, #N is the row you filed"). A closed row's title does not refuse, a failed read refuses (an outage is not "no duplicate"), and `--allow-same-title` is the one override: stripped before `gh` sees it, refused beside `--promote`/`--board`, and in the known-flag list. Not here: a body-hash or fuzzy match (#4043, #4137) and a lock between concurrent runs. a11ign/a11ign#4294.

## 0.86.4

### Patch Changes

- c6c4134: CI now runs the shared layout check (a11ign/a11ign#4211, ADR 0043 Decision 7), so the flat shape this repository is the model for cannot drift into a monorepo unseen. One step in the `typecheck` job of `ci.yml`, which the required `gate` waits for, runs `@a11ign/toolchain`'s `layout-check` and fails on a workspace of one package, a package directory not named for its package, a second README for one package, or a `lerna.json` / `*-workspace` shell. The `@a11ign/toolchain` devDependency moves from `^0.1.4` to `^0.1.5`, the first version that ships the check. Measured on `d51ea83` with 0.1.5: `layout-check: ok (963 files read ...)`, exit 0. The step calls the file by path (`node node_modules/@a11ign/toolchain/dist/layout-check.mjs`) because 0.1.5's bin has no `#!` line and the published one-liner exits 2 under `sh`.

## 0.86.3

### Patch Changes

- 5423673: The count of `.js`/`.mjs`/`.cjs` source files the tool has is now judged by `@a11ign/toolchain`'s `checkMjsRatchet` (a11ign/a11ign#4249, adopting #4243), and the old pin is gone. `src/packaging/mjs-ratchet.test.ts` calls it against `mjs-ratchet.baseline.json` at the repository root, which lists the 315 files of agent-org at `9799faf` by basename (so a layout flatten that moves a file edits nothing) and needs no exception. It replaces `src/packaging/mjs-source-count.test.ts`, its `SOURCE_MJS_PIN` and `TEST_MJS_PIN`, and the rise rule under which a new `.mjs` that a shipped command imports could raise the pin: 18 of its last 30 rises used it, because node on the host cannot run a `.ts`, and how host-run code runs is the ADR 0043 amendment (a11ign/a11ign#4246). The test reads the same in a checkout and in the copy the gate lays: where `AGENT_ORG_TOOL_REPO` names the checkout it came from, that checkout is judged, so a project's helpers under `src/packaging/` are never counted. `@a11ign/toolchain` is `^0.1.4`, the release that exports `./mjs-ratchet`. No workflow file is edited.

## 0.86.2

### Patch Changes

- 36da702: A `parked` row is a wait the stall signals read. `waitFieldsOf` and `WAIT_FIELDS` now list `parked` (it clears only when somebody takes it off), so the stale-wait signal (8) reads a parked row's `Waiting-for:` like a held one's and the wait-without-reason signal (9) names a parked row whose wait is free text, unreadable or absent AT ONCE, not after the four quiet hours a `hold:*` earns: a park with no reason is the defect itself. A park is excused by an open `Waiting-for:`, a `Not-before:` the gate can read, an open `blockedBy` edge, an `answer:<session>` label or `needs:chairman`. `unpark-satisfied` ignores `parked` among the fields that keep a row where it is, so a parked row whose condition is true is un-parked exactly as before. The state-label repair prose no longer says `parked` REPLACES `backlog` unconditionally: the wait is read first, and a met, free-text or absent one leaves `parked` untrue. #4090 sat ten hours parked on a met wait (a11ign/a11ign#4230).

## 0.86.1

### Patch Changes

- 5d8a84f: `org-stalled` no longer counts a claimed row whose session herdr lists as `working`. `openRowState` counted every open row that declared no wait and read no claim, so on 2026-10-08T19:05Z nine claimed rows (two of their workers started minutes before) paged `ceo` as "could move and are not moving". `deadMansSwitch` now takes herdr's listing (`agents`), subtracts the reachable rows with a `working` `session:` label (`workingClaims`), and the order says how many it left out. It reuses the listing `readOpenRowFollowUps` already reads once per tick for `closedClaimsWhenWorkerListed`, so it adds no `herdr` spawn and no `gh` call. A session that is idle, `blocked`, absent from the listing, or a listing that could not be read (`null`) leaves the row counted, so a stall under a dead claim still pages. a11ign/a11ign#4205.

## 0.86.0

### Minor Changes

- a80bef1: `org-health` has a new signal, `primary-milestone-idle`: the primary milestone's own clock. The primary milestone is DATA, the one whose description carries the line `Primary: yes`; it trips an order to `ceo` when that milestone has an open row, no open row of it is claimed (`session:*`) and no open pull request declares it closes one, for more than 120 minutes (`MILESTONE_CLOCK_MINUTES`). The order names the oldest open row with its state and who owes the next move, and is keyed on the milestone and that row, so a changed named row asks again and a later tick naming the same one does not. No primary milestone reads clear and says why, two marked `Primary: yes` read unknown (the clock does not choose), and an unreadable open-row or pull-request list reads unknown, never clear. It adds no API call to the tick: it is read from the open rows, the open pull requests and the last merge the tick already holds. That last merge stands in for the milestone's own last claim or pull request ending, so it is later than the real start whenever anything else merged since, and the clock errs silent, never loud; the row records what a closer reading would cost. a11ign/a11ign#4231.

## 0.85.11

### Patch Changes

- 2da17bd: The board-truth audit's day table asks two more questions of the last day's comments by org accounts (a11ign/a11ign#4232, the chairman's root cause 1: a handoff written as a sentence moves nobody). `handoff-in-prose` flags a comment that hands off in prose (`goes to <session>`, `<session> will file`, `<session> to file`, `for <session> to`, `I will ask <session>`, `Asked of <session>`) when its author neither filed a row nor added `answer:<session>` within 15 minutes of it; `reading-without-defect-row` flags a reading (`reading N of M`, `Ruling`) with no `Defect-row: #N` / `Defect-row: none -- <reason>` line. A fenced block is never read. The comments are read once per edition day by `postDaysTable` (one paginated REST call, plus the evidence only when a handoff comment exists), never by the tick; a refused read leaves the day's table unposted.

## 0.85.10

### Patch Changes

- 6bc8131: The retrospective's "Unwaited stock rows" number no longer counts a `Waiting-for:` line outside the grammar as a wait. `parseWaits` keeps such a sentence as an `unreadable` wait, and the count asked only whether any wait line existed, so a row parked on "ceo's dispatched run ... ends" (#4090, ten hours) read as waited. A line counts when its state is not `unreadable` (`manual` still does); a row whose only wait is a sentence is counted and printed with `unreadable wait` beside it, and a real wait beside the sentence (an open edge, an `answer:*`, a future `Not-before:`, a readable `Waiting-for:`) still moves the row. `Waits-on-done-when:` is unchanged. The grammar is `parseWaits`'s own, not restated. a11ign/a11ign#4237.

## 0.85.9

### Patch Changes

- aaa8653: The tick runs `row-file --promote` from a linked worktree it owns (`role-work-gate`, beside the checkout it runs from, detached at that checkout's HEAD), so an un-parked row is promoted to `ready` and not left on `backlog` + `answer:product-manager`. The tick's working directory is the tool's primary checkout, which `row-file`'s launch guard (#1352) refuses, so every promotion was refused (a11ign/a11ign#4159 twice, #4182, #4183). The guard is unchanged. A stale registration is pruned, a directory of that name that is not a worktree is refused by name and never touched, and a missing tree routes the row to `product-manager` with that reason. The log line names the worktree that ran the script. a11ign/a11ign#4202.

## 0.85.8

### Patch Changes

- b342da2: `row-file` refuses a body whose `Waiting-for:` line is outside the grammar the gate reads (`closed #n`, `merged #n`, `labelled|unlabelled <label> #n`, `published <pkg>@<dist-tag>`, `<pkg> latest = next`, `tagged <tag>`, or `manual`), naming the forms and the `answer:<session>` label for a wait on a session's act. Filing, `--promote=` and `--board=` ask it through `fileRefusalReason`, so an old free-text line cannot be filed, promoted or boarded; `parseWaits` is the one reader, a fenced line is not read, and `manual` stays allowed. a11ign/a11ign#4229.

## 0.85.7

### Patch Changes

- 73eaf2f: The board-truth audit asks an eighth question, `parked-on-the-chairman` (a11ign/a11ign#4201, `ceo`'s class fix A: a wait on the chairman is never a date). An open `parked` row without `needs:chairman` whose `Blocked-on:` line names the chairman is a finding for `product-manager`, whatever `Not-before:` or other wait it carries: #4159 sat parked behind a date while its line said the chairman's session had to mint a token, and `parked-without-condition` could not see it because the date is a condition. A `Waiting-for: labelled needs:chairman #n` line is a data wait and is not flagged.

## 0.85.6

### Patch Changes

- cb414fc: The gate reads the holds of pull requests in the declared repositories beside the first. `orgHealthNow` was handed `prs`, the first repository's own list, and the keyed repositories' open pull requests (`pullRequestsOfOthers(otherScopes)`, tagged `repoKey`/`repo`) never reached the wait read, so a keyed pull request's `hold:*` with a TRUE `Waiting-for: merged` was neither lifted (#3479) nor ordered: agent-org#401 stood 77 minutes after its blocker merged. They now arrive as `keyedPrsRead` and feed the wait read only; every other reading (red, overdue, idle) is still about the first repository. a11ign/a11ign#4189.

## 0.85.5

### Patch Changes

- d7b4fb4: `node src/trace/headless-pilot.mjs --row <n> --named-on <issue> --max-turns <N> --max-budget-usd <D> [--dry-run]` works one named even row as `claude -p` over stream-json in a throwaway worktree off `origin/main` and writes one record (turns, the trace store's dollars beside the CLI's own figure, `result.subtype`, the row's Acceptance exit and `success`) to `~/.cache/a11ign/headless-pilot/<row>.json`. It is hand-run and outside the wake path: it claims, labels and comments on nothing, and a run that ends at a turn or budget cap is written with `success: false`. It refuses an odd row, a row `--named-on` does not list under `Pilot-rows:`, a claimed row, a row whose `## Fleet` is not No, and missing caps. a11ign/a11ign#4184.

## 0.85.4

### Patch Changes

- bc58d08: `org-health` raises `release-behind-main` (signal 21) when a `dora` repository's `main` holds a commit on its `releasablePaths` that no release carries and the oldest such commit is over 24 hours old, naming the repository, the latest release (name, version, time), the oldest unreleased commit (sha, time, pull request) and how many more there are. It sees what `release-run-failed` cannot: a release that never started (a repository that has not adopted `changeset-required`, a wrong `no-release:` line, a release that fails after the merge), the class behind a11ign/a11ign#4084. A test file, `.changeset/` and a merge commit do not count; a commit whose pull request body has `no-release: <reason>` is read as declared and named; a refused read of one repository is `unknown` and the others are still read; a repository with no release says `never released`. The facts are read at most once an hour (`release-behind-main.json` in the state directory) and judged against the clock on every tick. a11ign/a11ign#4128.

## 0.85.3

### Patch Changes

- 712e401: The daily retrospective prints how many `backlog` or `parked` rows have no wait that moves them, and names them (a11ign/a11ign#4175, #4055 item 5). A row counts when its stock label was applied more than 24 hours before the reading (the timeline's `labeled` event, so a comment cannot reset it) and it carries no `answer:*` label, no open `blockedBy` edge, no `Waiting-for:` or `Waits-on-done-when:` line and no `Not-before:` still in the future. `unwaitedStockRows` is the new `NUMBERS` entry (lower is better). A read the tool could not make (the issue list, a row's edges or its timeline) makes the number `unknown` and names the read; it does not drop the row, and it is never `0`. No `org-health` detector, no wake and no change to `idle-with-open-rows`.

## 0.85.2

### Patch Changes

- c326e26: A new per-row worker whose row number has an even `Math.floor(row / 2)` (`tripsArmOf` is `batched`) is sent `ROUND_TRIPS_PARAGRAPH` after the calm paragraph on its first-contact order, and nothing else is sent it; every other row's order is byte-identical to before. The arm is the row number's SECOND bit, so over any four consecutive rows each cell of calm-or-control by `armOf` and batched-or-control by `tripsArmOf` occurs once, and the two A/Bs are read as a 2 by 2. The claim-orders `arm` record gains `tripsArm`. The first line of the paragraph follows Anthropic's "Optimize parallel tool calling" guidance; the second (one script that prints a summary for fan-out work) is the chairman's and is not on that page. No saving is claimed. a11ign/a11ign#4182.

## 0.85.1

### Patch Changes

- 0ed32b5: The trace store prices `claude-haiku-5-5`: $0.10 input, $0.50 output, cache reads $0.01 per million tokens, from the claude-api skill's model docs (2026-10-08), `verified: false`. Its turns read `costUsd: null` before, so a report that summed cost counted them as not priced (found on a11ign/a11ign#4183). The row carries `maxPrompt: 100_000`: the page lists a second card ($0.50 / $2.50) for a longer prompt, and a request above it costs `null` rather than the wrong rate. a11ign/a11ign#4186.

## 0.85.0

### Minor Changes

- 1e0322d: `node src/trace/triage-sample.mjs --score <predictions.json>` scores a small model's `wake | digest | drop` triage of manager wakes against the 100 hand labels of a11ign/a11ign#4074, frozen in `src/trace/triage-labels-4074.json` (the sampler is never re-run). It prints the confusion by label, the missed wakes (a `wake` the model called `digest` or `drop`) per cause class, every figure with and without the six unreadable rows, and the declared bar per class (at least 5 readable rows and no missed wake: a `candidate`, never proved). `--prompt` prints exactly what the labeller had: the three definitions and the five printed columns. Nothing is routed and no alias or effort changes.

## 0.84.0

### Minor Changes

- ba6a9c7: `node src/trace/growth.mjs --from=<ISO> --to=<ISO> --by-command` adds a "Bash by command" table beneath the by-tool one: the `Bash` row split by the command's first word (`gh`, `git` and `pnpm` by their first subcommand, `node` by what it runs), over the same requests and the same derivation, so its rows sum to the Bash row and a sum check beside it says so. A piped or chained line is its first command; a bare assignment, `export`, `set` and a `cd <dir> &&` in front of it are setup and skipped (read literally they were 61% of a week's Bash growth and named nothing); a line the splitter cannot read is `(unparsed)`, and parallel Bash calls of different commands are `(several commands)`. Without the flag the output is unchanged. a11ign/a11ign#4181.

## 0.83.1

### Patch Changes

- d6851b3: A per-row Claude engineer launches with `--autocompact 200000`, not `300000` (a11ign/a11ign#4180, #4055 next wave item 1). `MIN_WORKING_ROOM_TOKENS` in `src/worker-profile.mjs` moves from 200,000 to 100,000 and the window, which is derived, lands as 35,000 margin + 65,000 base + 100,000. The headroom guard's floor in `worker-profile.test.ts` moves from 150,000 to 100,000 with it, 4.5 times the ~22k that thrashed in #2717. A literal pin now says the pane form carries 200000. The headless form and the managers' windows are unchanged.

## 0.83.0

### Minor Changes

- d1b832b: A standing lead whose previous order was recent AND whose window is over the fill line is now CLEARED, not compacted, when `state/<label>.md` exists beside the ledger's record directory and is within 8 KiB (`STATE_FILE_MAX_BYTES`, an unmeasured starting constant); with no state file it is compacted exactly as before. An empty, unreadable or oversized file is never used: an oversized one is refused with its size and left on disk untruncated, and the refusal rides on the delivery's `note`. A recent order under the line is still kept and an old one still cleared. Nothing writes a state file yet and nothing rehydrates from one, so this changes no delivery until a manager writes `state/<label>.md` at the end of a wake and a SessionStart hook reads it back (#4055 moves 5 and 6).

## 0.82.0

### Minor Changes

- 7c91c49: `org-health` wakes `ceo` once per signal class instead of once per rendered subject (a11ign/a11ign#4065, #4055 move 1b). `src/work-gate/org-health-suppression.mjs` declares each of the 27 classes an `org-health` order can carry as `page` (a (class, key) not let through inside 6 hours wakes) or `digest` (never wakes by itself; wakes once when its distinct keys inside the window pass 12, and again only after falling back), keys the subject set normalised (members sorted, ids kept, timestamps dropped), and holds only orders to `ceo`. Every held order is a line of `org-health-suppressed.ndjson` in the host's state directory (class, key, count, time, why), and the held ones ride, at most hourly, on the first order `ceo` receives for any reason, and are written to `org-health-digest.md`. A class in no table wakes (a new detector is loud) and fails the test. `A11IGN_ORG_HEALTH_SUPPRESSION=off` in a unit restores the old behaviour. The wake counts quoted in the row are measured from the trace store, not predicted.

## 0.81.0

### Minor Changes

- 9e12925: The workers' GraphQL hour stops being spent re-reading the same pull requests and rows (a11ign/a11ign#4148, part of #4055). `host/gh` answers an IDENTICAL repeated read from disk for 20 seconds (never more than 30; any write by the account drops the cache; `-i`, `-H`, `rate_limit`, `--web` and `--watch` are never cached; a hit is a `cache` line in the ledger and spends no point), and for a process the tick started it stays good while the repository's GENERATION has not moved. `work-tick.mjs` moves the generation once per tick through `tick-snapshot.mjs`: two REST probes per declared repository with `If-None-Match`, where an unchanged answer is a 304 that costs no point and an unreadable one counts as a change. `gh-ledger.mjs --per-hour` prints the account's calls, points read and floor points by UTC hour, and `host/gh` counts what each trim drops into `<ledger>.hourly`, so an hour is still readable after the 2 MiB bound. `api-pool-low` names the account's top spender of the last hour, and the gate's batch worker names itself so its calls stop reading `/usr/bin/node`. After install (`host:install`) the wrapper on the host is the new one; `host:check` reports DIVERGED until then.

## 0.80.3

### Patch Changes

- 2942a86: The board document counts the rows the chairman found, with the target zero beside the count. A row labelled `found-by-chairman` is counted in the UTC week its opening falls in (the seven whole UTC days before the run's day), and the line names the rows and the previous week's count with `better | worse | same | no baseline | unknown`. A refused read, or a labelled row whose opening cannot be read, prints `unknown` and never `0`; a week that begins before the label's first use (2026-10-02) has no baseline. The line sits in the appendix's source table, which the body's word cap does not cover. `ISSUES_QUERY` now reads `createdAt`. a11ign/a11ign#4124.

## 0.80.2

### Patch Changes

- a1596ff: A new org-health signal, `class-repeat` (a11ign#4126, child B of #4122): a SECOND closed row under one `class:<id>` label is a repeat, and a repeat means the guard failed. The gate reads the project's `.agent-org/failure-classes.json` (each class: `id`, `name`, `guard`) and the closed rows carrying a `class:` label (`readClassRepeat` in the new `class-repeat.mjs`: one REST call a tick, one more per class with an instance closed in the last 90 minutes), and offers `ceo` one order per class naming the class, its `guard` and the instances, with the instance counts of every class beside it. It is offered ONCE: the discriminator is the class and its newest row, the signal is tripped only while that row closed within 90 minutes (under the two-hour judgment TTL), and a third row is a new newest row and a new offer. A label naming no class in the index is `unknown class`, named and tripping nothing; a refused read of the labels or the file is `unknown`, never "no repeats"; an open row, and a pull request carrying the label, are not instances.

## 0.80.1

### Patch Changes

- 5912aff: A pull request whose `Closes` names a row labelled `defect` must carry exactly one `Class:` line, or it does not pass `pr:open` or CI's acceptance job: `Class: <id> — <where else it can occur>; guard: <what stops it everywhere>`, or `Class: none — <reason>` (em dash required, both halves non-empty, `<id>` kebab-case; a duplicated line is malformed). A refused label read is `UNKNOWN`, never a pass; a caller with no reader of labels prints `CLASS: NOT CHECKED`. `row-file --kind defect` adds the `defect` label (made in the repository first, and read back), and any other `--kind` is refused before anything is filed. CI's acceptance step is tracker-less by design, so it reads the labels from `ACCEPTANCE_ROW_LABELS` when a step before it supplies them. a11ign/a11ign#4123, child A of #4122.

## 0.80.0

### Minor Changes

- 05adf45: `src/trace/triage-sample.mjs` draws a SEEDED, reproducible sample of 100 manager wakes (`ceo`, `product-manager`, `orchestrator`) for a human to label `wake`, `digest` or `drop` before any model triages one (a11ign/a11ign#4074, #4055 move 8, first step only). It is stratified by cause: every cause with a wake in the window gets a place, the rest are shared in proportion, and a cause with fewer wakes than its share contributes all of them; a window with more causes than places is refused. The sheet shows only cause, causeKey, session and the wake's cost (a floor when a turn is unpriced, `no turn` and never 0 when none ran), in a seeded shuffle, and none of bytes, delivery lag or time. Run `node src/trace/triage-sample.mjs --seed <text> [--from <iso>] [--to <iso>]`; a run without a seed is refused. No model is called.

## 0.79.0

### Minor Changes

- 5c21eb1: `node src/trace/growth.mjs --from=<ISO> --to=<ISO>` prints how much each worker request grew the context window, summed by the tool before it and by session. Growth is the change in `cacheRead` from the previous request of the same thread, and it is attributed to the tool called two requests earlier, because a request WRITES what its tool result added and the next request READS it (measured: the delta equalled the previous request's `cache_creation_input_tokens`, to the token). The first request, the first after a compaction or a `/clear`, a request whose cache read fell and the one after it print as not derivable, never 0, and a subagent's requests are their own thread and are not counted into the parent's. It reads transcripts, because the store's turns name no tool. a11ign/a11ign#4073.

## 0.78.0

### Minor Changes

- 4940459: A cleared row is promoted by the gate when its filer declared it so (a11ign/a11ign#4064, #4055 move 1a). A body line `Ready-when-unblocked: yes` means "complete except for its edges"; when the last `blockedBy` edge closes, the tick (no model, `src/work-gate/ready-when-unblocked.mjs`) re-reads the row and, only if it is still a plain `backlog` row (no `parked`, `needs:chairman`, `answer:*`, claim or not-startable label, no future `Not-before`), still declares the line, passes the claim rule's template check on the LIVE body and has no merged PR already naming it, promotes it through `row-file --promote` (which re-runs the filing rule) and logs `PROMOTED #<n> (blockers cleared, Ready-when-unblocked)`. A row without the line, or one that fails any check, keeps today's `unclaimed-blocker-cleared` order to `product-manager` unchanged; a refusal logs `NOT PROMOTED #<n>` with the reason.

## 0.77.4

### Patch Changes

- e24b714: The trace map's `gh` reads of a row's record (`issues/N`), a pull request's record (`pulls/N`) and a head's `check-runs` send the ETag they were last given, and a 304 is answered from the body kept with it, which costs no point of the core pool. A row whose record answers 304 and whose `filed` event the store already holds skips its timeline read, which was 51 of the 105 calls a render spent re-reading the subjects the wakes name (measured on one render, 123 calls in all). The validators live in `.validators.json` beside the trace store; a missing or corrupt file means unconditional requests, never a skipped read. A subject whose reading was cut off (by the budget or a failure) forgets the validator of its own record (`pulls/N` for a pull request, `issues/N` for a row), so the next run reads it whole. The timeline and the lists are not conditional: their ETags were measured not to hold. a11ign/a11ign#4097.

## 0.77.3

### Patch Changes

- 4bc9fcd: The trace prices `gpt-5.6-luna`, the model the Codex reviewers run, from OpenAI's own rate: $0.2 input, $0.02 cached input and $1.2 output per 1M tokens, sourced in `PRICES` to `https://developers.openai.com/api/docs/models/gpt-5.6-luna.md` with the date it was fetched. The row matches that exact model name only, so every other `gpt-*` stays unpriced (`null`, never `$0`), and a request above 272K prompt tokens is also unpriced because OpenAI states no cached rate there. The aggregate report prints the priced Codex turns as a line of their own beside the unpriced ones. For the 7 days to 2026-10-08: 22,033 turns, $35.95 at list rate (arithmetic from the trace store, not an invoice). a11ign/a11ign#4076.

## 0.77.2

### Patch Changes

- f34e9e4: The board-truth audit's `closing-pr-merged` question no longer raises an open row whose closing pull request merged less than five minutes ago (`MERGE_GRACE_MS`, the filing grace's length; a11ign#4116, four transient trips on 2026-10-08 for a row GitHub closes a second after the merge). Both merged-PR reads (the first tracker's and each code repository's) now ask for `mergedAt`. A withheld row is counted, and the table prints `N merging, not judged` beside the count only when N is above 0. A PR merged longer ago, one that carries no readable `mergedAt`, and a row a settled PR also closes are raised exactly as before.

## 0.77.1

### Patch Changes

- 4eefc5f: The board-truth audit's `duplicate-or-superseded` question no longer reads sibling per-repository rows as one row (a11ign#4137, found on #4130 and #4132-#4135). Two titles that each name a repository in the form `a11ign/<name>` (lower-cased, a trailing `.` not part of the name) and name different sets of repositories are not near-duplicates. A title naming none, or two naming the same repository, are compared by words exactly as before, so a real twin is still found. `Superseded by #n` is unchanged.

## 0.77.0

### Minor Changes

- 5a107d4: `agentArgs(profile, { headless: { maxTurns, maxBudgetUsd } })` (`worker-profile.mjs`) returns the launch arguments for a worker run as `claude -p` over stream-json: `--input-format stream-json --output-format stream-json --verbose --max-turns --max-budget-usd --permission-prompts none`, with the model, effort, `--disallowedTools` and `--settings` the pane form already carries, and without `--dangerously-skip-permissions` or `--autocompact`. Without `launch.headless`, which is every caller, the arguments are the pane form byte for byte; the caps have no default and a codex profile or a cap that is not a positive number (a whole number for turns) is refused. No `PROFILES` entry carries the switch and nothing in the tool turns it on, so nothing changes for an installed host (a11ign/a11ign#4075, #4055 move 9). `--max-turns` is accepted by `claude` 2.1.294 but absent from its `--help`.

## 0.76.0

### Minor Changes

- 0cfa022: The board-truth audit, the ready-label audit, the tick's heartbeat, `wakes-per-row`, `ci-health-liveness` and the board report read EVERY declared tracker, not `tracker[0]` or one `--repo` (a11ign/a11ign#4080, row 2 of #4056). A row of a keyed tracker is named `agent-org#N` beside the first tracker's `#N`; a read that fails on one tracker is reported for that tracker and hides none of the other's rows; with one declared tracker every output is what it was.

## 0.75.0

### Minor Changes

- 0b018d4: A new per-row worker is assigned to a prompt arm by its row number (even rows `calm`, odd `control`), and the calm arm's first-contact preamble ends with the report's calm finish paragraph (no capitals, with its reasons); the control arm's preamble and every follow-up are unchanged. The arm is written once to a new `claim-orders` file beside the wake ledger when the worker is started. Separately, the gate's repeat orders to a live worker's claim (`claim-stalled`, `pr-checks-failing`, `pr-review-blocked`, `answer-label-unexplained`) are numbered per claim, and the third and later go to `orchestrator` instead of the worker, each logged with its claim, cause and number in the same file. A project that wants neither changes nothing: the paragraph is the report's text, and the cap is `MAX_CONTINUATIONS` in `claim-stall.mjs`. a11ign/a11ign#4070, #4055 move 2.

## 0.74.1

### Patch Changes

- 51261f4: `row-file` files a row in the tracker its Region names, and boards it on that tracker's board (a11ign#4078, row 1 of #4056). `rowTracker(regionEntries, dora, trackers)` in the new `row-tracker.mjs` is a pure function over `rowKind`: a Region with one entry under a `releasablePaths` entry of a `dora` repository other than `a11ign/agent-org` is a product row and goes to the project's own (first) tracker; every other row, an empty or unreadable Region included, goes to the `a11ign/agent-org` tracker. The `gh issue create`, the label creates and writes, the milestone read, the blocker read, `gh project item-add --owner`, the Status move and the board read-back all use that tracker's repository and board, and a read-back of the other board does not satisfy it. New flag `--tracker=<key>` overrides the choice (the home tracker's key is empty); an unknown key is refused naming the declared keys; a Region that could not be read prints one line saying so. An org row declares its release with `--label out-of-release` alone: no milestone is read, passed or expected in a tracker that is not the project's own. **With one declared tracker nothing changes**: every Region gives that tracker.

## 0.74.0

### Minor Changes

- 1b45761: Something now runs `host-kernel.mjs --reboot` (a11ign/a11ign#4053, follow-up to #4046): the shipped `kernel-reboot.service` (a oneshot whose `ExecStart` is exactly `--reboot`, with a 45-minute start bound for the 30-minute drain) and `kernel-reboot.timer` (`OnCalendar=*-*-* 05:30:00 Europe/London`, `ceo`'s hour, daily). The timer has NO `Requires=` on the service, so `host:install`'s `enable --now` cannot reboot the host, and no `Persistent=`, so a host that was down at 05:30 does not reboot at boot. On a day with no newer kernel installed the run is a no-op. The drain now excuses the reboot service's own `activating` state, which it counted as a host job and would have held every scheduled run for the whole drain bound.

## 0.73.0

### Minor Changes

- a864d4c: `src/trace/otel-receiver.mjs` receives Claude Code's OpenTelemetry on 127.0.0.1:4318 (OTLP/HTTP with JSON only; protobuf is refused with 415 naming the variable that fixes it) and appends one `source: "otel"`, `kind: "api_request"` record per `claude_code.api_request` to the trace store, with `org.role`, `org.pane`, `prompt.id`, the token counts and Claude Code's own `cost_usd` (kept as `clientCostUsd`: the client's estimate, not the store's repriced figure). The id is `otel:<request_id>`, so a retried export is one record; a payload with no `org.role` is stored as `unattributed`. `host/otel-receiver.service.in` is shipped as a long-running service no timer starts (`LONG_RUNNING_TEMPLATES`), so `host:install` enables it with `--now`; a pane already running keeps the environment it started with and is not seen (a11ign/a11ign#4071, step zero of #4055).

## 0.72.4

### Patch Changes

- 86e0585: The trace store and `wakes-per-row` name a transcript's session from a follow-up order's `[order:<wake id> session:<session> cause:<cause>]` header as well as the old "You are `<session>`" phrase, the earlier match winning (a11ign/a11ign#4083, found in #4068). Both used to keep their own copy of the old phrase, so a transcript whose only wake was a follow-up was unattributed once the header changed; they now import `token-audit`'s `sessionOf`.

## 0.72.3

### Patch Changes

- 5f6ae72: A follow-up order opens with an order id, not an identity line (a11ign/a11ign#4068, #4055 move 5). The header `wake.mjs` types to a session whose window was kept is now `[order:wake:<session>:<ms> session:<session> cause:<cause>]` instead of "You are `<session>` -- a follow-up order to your session."; the staleness clause of a kept or compacted standing seat follows it unchanged. `deliver` mints the id from its clock (new `now` dep) before it prompts and hands the same instant to the ledger writer as a fourth argument to `record`, so the id typed into the header is the number in the ledger line. `token-audit`'s `sessionOf` reads `session:` from the new header and still reads the old "You are `<session>`" phrase, taking whichever comes first in the text, so a transcript that opens on either form stays attributed. A `prompt:session` follow-up is never recorded in the ledger, so its header names no `order:`. A first-contact order is unchanged. `src/trace/store.mjs` and `src/wakes-per-row.mjs` keep their own copy of the old phrase and are not touched here.

## 0.72.2

### Patch Changes

- 0fa5bbe: `trace-publish` asks GitHub less and redraws less (a11ign/a11ign#4077, #4055 move 11). The head of `main` of each repository is a conditional GET (`If-None-Match`, the ETag kept in `.validators.json` beside the pages), so an idle ten-minute run is eight 304s, which GitHub does not charge to the primary rate limit. The closed-rows list is read newest-UPDATED first and stops once no unread issue can displace the answer (an issue closed at T was updated at or after T): one page where creation order needed thirteen, MEASURED 2026-10-08 against `a11ign/a11ign` with the same six rows. A row's swimlane is redrawn only when its issue's `updated_at` moved since the page was drawn, or the page is a day old; the map is drawn each publication as before. A missing, corrupt or ill-shaped validator store sends no validator, an unreadable stamp or one from before this change redraws every page, and a row named by `--row` that is not in the recent set is always drawn. The journal line now ends with the reads asked and the share answered 304.

## 0.72.1

### Patch Changes

- 0d203f0: A row being filed is not read as having no state label (a11ign/a11ign#4048). `row-file` adds the state label last on purpose, so every filing has a 12 to 13 second gap with none, and a tick that read in it tripped `row-without-exactly-one-state` and `board-disagrees-with-reality` three times on 2026-10-08. `stateLabelFindings(rows, { now })` now excuses a `NONE` row younger than `FILING_GRACE_MS` (5 minutes); `MANY` is a finding at any age, and a `createdAt` that is absent or unparseable is judged, never excused. `rowsBeingFiled` names the excused rows, `boardTruthAudit` returns their count as `filing`, and the daily table says `N filing, not judged` beside `N disagree`. A caller that gives no `now` excuses nothing. The tick's own reads (`readOpenRows`, `stateLabelReading`) do not yet carry `createdAt` and `now`: that wiring is outside this row's Region and is named on the row.

## 0.72.0

### Minor Changes

- d4133b8: `trace -- --wake-cache` prints each seat's 5-minute and 1-hour cache-write totals and the cold-wake rate of #4055 move 3 (a11ign/a11ign#4062): the share of first requests after an order whose cache write is MORE than half of input + cache read + cache write. The rate is printed over all of a seat's first requests, per window action (kept, compacted, cleared) and per gap, so a cold first request after a window the gate emptied reads apart from one after a cache that lapsed. A seat or class with no first request prints `not derivable` and never 0%.

## 0.71.0

### Minor Changes

- d28b3ba: The trace pricer charges a Sonnet 5.5 cache read at the pricing page's $0.10 per MTok (it charged $0.20, which is what Claude Code 2.1.289's own `cost_usd` agrees with and the page does not), Fable 5.1 at $0.25 and Fable 5 at $1 (one `claude-fable-5` prefix priced both at $0.25; the page lists them apart, so `claude-fable-5-1` stands first). `claude-sonnet-5-5` is no longer marked `verified`: a figure that disagrees with the page does not verify the row, and Haiku 4.5 is the one verified row left. Every report restates the whole stored history at the new rates with no re-ingest (`repriceEvents`). The weekly report prints the Codex turns it could not price (no OpenAI rate is sourced) as a line of their own, with their count and tokens, and not inside a total.

## 0.70.0

### Minor Changes

- 4b5a07c: `host:check` notes `newer kernel installed, not running: <installed> over <running>` (a11ign/a11ign#4046, from #3846), and `node src/host-kernel.mjs --reboot` does the drained reboot the chairman's host needed by hand on 2026-10-08, when `7.0.0-34-generic` ran for two days with `7.0.0-38-generic` installed. The kernels are compared by VERSION order, not string order (`7.0.0-100` is newer than `7.0.0-38`), against the newest `vmlinuz-*` of the running flavour in `/boot`; a refused read of either side is `NOT READ`, never clear. The reboot stops `a11ign-work-tick.timer` (stopped, not disabled: a boot starts it), waits up to 30 minutes for no seat mid-turn and no `a11ign-*.service` still activating (a herdr that cannot be asked holds it), then runs `sudo systemctl reboot`, the ONE passwordless command granted: `runPrivileged` refuses every other argv, and a test counts the `"sudo"` literals in the source. A busy host past the bound DEFERS: the timer is started again and the deferral is said, never forced. It writes `kernel-reboot.json` in the state directory before it reboots, and a second reboot inside 24 hours with the note still true is REFUSED and raised as a `host:check` finding (`REBOOTED INSIDE 24 H, NEWER KERNEL STILL NOT RUNNING`), naming whether the boot loader chose the old kernel or a newer one arrived. After boot a `REBOOT NOT READ BACK` finding is raised until `node src/host-kernel.mjs --read-back` posts `uname -r`, the five `/proc/sys/kernel/` panic values, the tick, the standing seats and the trace pages on the row that asked (`--row <n>`).

## 0.69.3

### Patch Changes

- 6001a3c: `no-merge-while-work-exists` reads the org's LATEST merge across the project and every keyed code repository the declaration lists, not the project's alone (a11ign#4047). It tripped falsely twice on 2026-10-08 while four `agent-org` pull requests merged and the product rows were date-held. `readLatestMerge` makes one `gh api` call per repository; a refused or unparseable read of any of them is `null` (unknown, stated) and never another repository's older time, and a repository with no merged pull request says nothing about the others. A trip's detail now names the repository of the last merge. The core-pool cost of the read is one call per declared code repository a tick instead of one.

## 0.69.2

### Patch Changes

- b29030b: The tick now passes `boardTruth` to `org-health` and posts one table a day on #928 (a11ign#4045, the follow-up of #4043). `orgHealthNow` builds it from the open rows the tick already read, the claimed rows' comments page and the wait facts its own wait pass built (so `wait-already-true` is read, not `NOT READ`); a refused open-row read is `null` (unknown), and a caller that gives no `readBoardTruth` gets no reading, as for the other optional facts. `boardTruthNow` adds the closed rows, the merged pull requests and the herdr listing (two `gh` list calls a tick, the closed rows without bodies) and `postDaysTable` comments `boardTruthTable` on #928 once per London edition day: the record is asked first (a `since=` page of comments) and a heading already there posts nothing. Only a complete reading is posted, since a day's table cannot be replaced; a failed ask or post is said on stderr and never stops the tick.

## 0.69.1

### Patch Changes

- 35d77a6: An unanswered `epic-finished` or `epic-unfiled` order is now escalated to `ceo` like the other standing causes (a11ign#4044, found on a11ign#4042). `STUCK_SUBJECT` matched `row-<n>`, `pr-<n>`, `pr-<key>#<n>` and `trunk-<key>-<sha8>` but not an epic's cause key (`product-manager/epic-finished/epic-<n>`), so `escalateStuck` could not read the epic as a row and the order went silent at `MAX_DELIVERIES`. It now reads `epic-<n>` and the keyed `epic-<key>#<n>`; the primary's epic is labelled `answer:ceo`. A keyed epic is reported as `STUCK ... cannot be escalated` rather than labelled on the primary (the same number is another row there) or filed as a `Stuck trunk-red` row (it is not a red).

## 0.69.0

### Minor Changes

- d7f613c: `org-health` can read the board against reality (a11ign/a11ign#4043, the chairman, 2026-10-08, point 4). A new leaf, `board-truth-audit.mjs`, asks six questions of rows the caller already read, each a pure function with a typed finding naming the row, the field that disagrees and who reads it: an open epic whose children are all closed (#2899 was 13 of 13), an open row a merged pull request `Closes`, an `in-progress` row with no live holder and no claim record inside four hours (or a claim-only label such as `no-code-left` on a row that is not claimed, #3425's shape), a `parked`/`backlog` row whose `Waiting-for:` or `Not-before:` is already true, a row in no state label or two, and a near-duplicate or `Superseded by` a closed-completed row. `boardTruthTable` prints the count first and says `0 disagree` when it is true; a fact that could not be read is named `NOT READ` and never counted as agreeing. `org-health.mjs` gains the `board-disagrees-with-reality` signal (`boardTruthReading`), read when the caller passes `boardTruth`, first read by `product-manager`. The gate does not pass it yet and nothing posts the daily table: both are the next row.

## 0.68.0

### Minor Changes

- 8b50204: A finished epic is raised to `product-manager` on every tick, whatever is Ready (a11ign/a11ign#4042). `finishedEpicOrders` used to return nothing the moment one row was Ready, and the epics were not even read unless the shelf was empty, so an epic with every child closed (a11ign/a11ign#2899 at 13 of 13, #69 at 23 of 23) sat on the board, counted as backlog, until a person noticed. The epics now come from the all-open list the tick already reads (`readOpenRows` asks for `subIssuesSummary`; `epicRowsOf` filters the `epic` label), so the tick makes one `gh` call fewer on an empty shelf and none more on a busy one; `readEpics` and `GH_READS.conditionalOnEmptyShelf` are gone and `finishedEpicOrders(epics)` no longer takes the shelf. The order quotes the epic's own `## Done-when` lines (capped at 12 lines) beside the children count, or says the epic has none, so the answer is to each line and not only "are the children closed". It is still an ask, keyed per epic, and a waiting epic stays excluded. `epic-unfiled` keeps its empty-shelf bound.

## 0.67.1

### Patch Changes

- a29a441: `agent-org dora` reads the two channel metrics (`Lead time, next to latest` and `Versions qualified`) as `undefined`, not `unknown`, for an npm package that publishes straight to `latest` (a11ign#4040). It assumed every npm repository has a `next` channel and looked for a `Promoted to latest:` line in each version's Release; four of the five declared packages have registry dist-tags of `{reserved, latest}` and nothing else, so there was no promotion to record and the figure read `unknown` for as long as they published that way, with a reason that sent a reader to fix Releases. The package's dist-tags are now asked first (a new optional `distTags` reader): no `next` tag is `undefined` with "its releases publish straight to `latest`: it has no `next` channel", and a package with a `next` reads as before, including `unknown` for a version with no Release. A dist-tags read that is refused stays `unknown` and names the registry, since a registry that cannot answer is not evidence that a package has no channel. A package with no `next` is also no longer asked for its Releases to find a promotion. A reader without `distTags` is read as before.

## 0.67.0

### Minor Changes

- 9f79e7b: A wait that clears can ASK THE CHAIRMAN. A row declares the ask in advance with a `Then-ask-chairman:` block (the lines the alert source requires of a brief, plus `Declared: YYYY-MM-DD`) beside its `Waiting-for:` conditions; when EVERY condition is true the tick posts the declared brief (opening `BRIEF for the chairman`, with a `Condition true at <time>: <reading>` line and the declaration's date), puts `needs:chairman` on the row, removes the declaration it used, and tells `ceo` once. A condition it could not read, a row already labelled, and a malformed block raise nothing (a malformed block is reported to `product-manager` by name, since a brief missing a line sends no alert); `row-file` refuses a block that could never fire. `Waiting-for: published <pkg>@<dist-tag>` gains a floor, `>= x.y.z`, so "a real release" can be written down. #2885 and #2887 sat parked three days after their packages shipped. a11ign/a11ign#4020.

## 0.66.3

### Patch Changes

- 531b703: The reviewer door's second-review refusal no longer counts a verdict its own account's LATER dismissed review superseded (a11ign#4029, found on agent-org#358). GitHub reads `reviewDecision` from each account's latest non-`COMMENTED` review, so after the door's `APPROVED`, a hand-run `gh pr review --approve` duplicate and its dismissal left the account's latest review `DISMISSED`: `REVIEW_REQUIRED` and `BLOCKED`, while the door still saw a standing approval at an equal patch and refused (exit `3`) the one post that clears it, leaving a push, which voids the verdict, as the only exit. The door now reads `DISMISSED` reviews of any body too, and a verdict by an account whose latest review is a dismissed one does not stand, so ONE fresh approval posts; an `APPROVED` with no later dismissal, a dismissal by another account, and a dismissal that predates the approval are all still refused. The by-hand duplicate itself is not prevented here: the door is the narrow place a rule can refuse, and a hand-run `gh pr review` never passes through it.

## 0.66.2

### Patch Changes

- c33f3d1: An idle holder whose own pull request is younger than `STALL_INTERVAL_MS` is no longer sent the idle nudge (a11ign/a11ign#4017). Five `claim-stalled` nudges in three days were typed while a pull request closing the row was open (#3560, #3591, #3719, #3787, #3993): the #2999 overlay's N of 45 minutes was derived from the gap between a claim and its first pull request, and fired 52 to 74 minutes after the pull request opened, before the gate had asked anybody to review it, while the review took 69 to 162 minutes. A pull request with no readable age, one past the interval, and a holder with no pull request are nudged as before.

## 0.66.1

### Patch Changes

- 091482d: `wakes:per-row` prints its reading when run as a command. Since `c2d79f8` its entry module sat in a top-level `await main()` while `main` imported `trace`, which imports the module back, so node exited 13 ("unsettled top-level await") with nothing printed and nobody could take the after reading. A test now runs the command end to end. a11ign/a11ign#3452.

## 0.66.0

### Minor Changes

- 319a231: A wait names the CONDITION, not an umbrella row. `Waiting-for:` gains three release states, each read off the registry or the remote and each clearing itself: `published <pkg>@<dist-tag>`, `<pkg> latest = next` and `tagged <tag>` (a failed read is an unknown, never true). The tick orders `product-manager` for a `ready` row held on a satisfied condition (`held-on-satisfied-<n>`) and for one held by a native `blocked-by` edge onto an open row of more than one done-when that names no condition (`umbrella-edge-<n>`). `row-file` refuses a new `--blocked-by` onto such a row unless the body says `Waits-on-done-when: <n>.<k>` or waits on a `Waiting-for:` condition, and `ready-label-audit` names such edges added from 2026-10-08. Seven `ready` rows sat behind #3778 after `0.3.0` reached `next`. a11ign/a11ign#4005.

## 0.65.1

### Patch Changes

- 97783e7: `release.yml` is now a call of the shared per-merge release workflow in a11ign/toolchain (`kind: tag`, pinned by full sha) instead of a release job of its own. The tag is still `v<version>`, cut from a release commit on no branch with the CHANGELOG entry as the Release notes, so what a project pins and what `update-tool` follows are unchanged. No lockfile, `packageManager` or `@changesets/cli` dependency is added: the call names the pnpm and the changesets version, which the shared workflow runs through `pnpm dlx`. The guard tests that ran the old steps now pin the properties of the call, and say where the rest moved.

## 0.65.0

### Minor Changes

- 938e897: The "Do it for me" button is drawn (a11ign/a11ign#3982, the gap under #3431 Done-when 3). `answers.mjs` handled a `forme` press and no keyboard carried one, so no brief could ask for it. A brief that NAMES the act it would do, in one line `Do it for me: <the act>` (read by `parseChairmanAct`, `sources/requests.mjs`, as the other brief lines are), now draws a fourth button after Later, and the alert shows the same line so the chairman's OK is for an act he read. A brief that names no act draws none, as before, because a press would then OK an unnamed act (D1, a11ign/a11ign#3427). All or nothing, as the options are: the button counts against the keyboard's room, so a request whose options leave none for it carries no keyboard rather than one missing it. A procedure brief's keyboard is unchanged, and `doItForMe` is untouched.

## 0.64.0

### Minor Changes

- 944ed9e: `trace --aggregate` cuts each week BY REPOSITORY, reads agent-org's and lab's weeks BEFORE and AFTER their move apart (the week that holds the move is on neither side), and prints for each cut the FIRST-TURN SIZE of the per-row sessions and the TOOL-READ TOKENS (`Read`, `Grep`, `Glob` results, measured from the window's growth, stored on each turn as `toolRead`) apart from the start-up context. The ingest state is version 4, so every transcript is read again once to carry the new field. A figure the store cannot hold prints `not held`, never 0 (a11ign/a11ign#3967).

## 0.63.0

### Minor Changes

- 8e4cb29: `dora` reads the two release channels beside the four metrics: the lead time from a version's publish on `next` to the moment `latest` moved to it, and the share of the versions published in the last 14 days that `latest` has pointed at. The registry's `time` map does not record when a dist-tag moves, so the moment is the `Promoted to latest: <time>` line the promotion leaves in the version's GitHub Release notes; a version never promoted is counted at its current age and marked unpromoted, and a version whose record cannot be read (no Release, or `latest` names it and its Release records no time) leaves both readings `unknown`, never 0. The chairman's targets print beside the numbers from the one `DORA_METRICS` table (lead time for changes, now merge to `next`, under 30 minutes; `next` to `latest` under 24 hours); the share of versions qualified has none. `DORA_METRICS` grows from five rows to seven, so the retrospective trends two new numbers per npm repository, and a repository whose releases are tags prints both as `undefined`. A reading kept before this change prints the two as `unknown`. A project's own `dora.mjs` readers need no change: a reader without `promotions` leaves the channels `unknown`.

## 0.62.0

### Minor Changes

- c9915ae: Idle is a signal (a11ign/a11ign#3943). `org-health` gains `idle-with-open-rows`: when NO engineer holds a row (a `session:<engineer>` label, or an `in-progress` claim naming no session, which is not proof of an idle org) and open rows exist that are not waiting on a `Not-before:` date, the tick orders `ceo` in the same tick with one line naming each row and why it is not being built, grouped by reason with counts first (`31 unoffered (8 date-held, not counted): 16 BACKLOG, 5 PARKED, ...`). The reasons are a closed list: `NO_STATE_LABEL`, `TWO_STATE_LABELS`, `BACKLOG`, `PARKED`, `EPIC`, `BLOCKED_LABEL`, `BLOCKED_BY #n`, `WAITING_FOR <condition>`, `ANSWER_OWED <session>`, `LANE <owner>`, `B4 overlaps #n`, `SHELVED <reason>` and `READY_UNOFFERED`, the one that is a defect and not a state (a `ready` row the gate has no reason to withhold while nobody works). `idle-with-open-rows.mjs` is the pure reading (`idleWithOpenRowsReading`); it adds no `gh` call (the open rows and the gate's own `partitionUnclaimed` shelving list are already in hand) and a refused read is `unknown`, never an idle org. It clears the tick an engineer holds a row, and its order is keyed on the KINDS of reason so a backlog row filed while idle is not a second order.

## 0.61.0

### Minor Changes

- bc48dd2: Every open row is in exactly one state (a11ign/a11ign#3942). `claim-labels.mjs` gains `STATE_LABELS` (`ready`, `in-progress`, `backlog`, `parked`, `epic`, `blocked`) and `stateLabelFindings`, which names each open row with none (`NONE`) or more than one (`MANY`); a closed row is never a finding. The decline path stops writing a row to no state: `decline --answer=<session>` added only `answer:<session>`, which clears by being removed, so the answerer's correct act left fourteen open rows with no state label (read 2026-10-07 from each row's timeline; a fifteenth was a bare `gh issue create`). It now adds `backlog` in the same edit (the one state the gate does not offer and nobody has to remember to remove; `ready` beside `answer:` would be offered), keeps a state the row already holds, and its re-read refuses to report DECLINED over an open row that holds none. `ready:audit` gains a `state labels` check printing `NO STATE LABEL  #<n>` / `TWO STATE LABELS  #<n>  <labels>` against the count GitHub reports open (`labelless rows` could not see these rows: each still held `lane:any` or `out-of-release`). The org-health tick gains `row-without-exactly-one-state`, read from the open rows it already holds (no new call) and ordered to `product-manager` and then `ceo` the tick a row appears. `row-file` refuses a `--label` naming a second state beside the `backlog` or `ready` it writes itself. Pinned in `state-label-exactly-one.test.ts`, one case per shape, each beside a row that is in one state.

## 0.60.3

### Patch Changes

- ecc4a7a: The suite slots move from `~/.cache/agent-org/suite-slots` to `/tmp/agent-org-suite-slots-<uid>` (a11ign/a11ign#3935, found on #3932). Under `codex sandbox` with `writable_roots = ["/tmp"]` the home is read-only, so `pnpm run verify` stopped at the slot (`cannot create .../slot-0.lock: Read-only file system`) having run nothing, and a reviewer could not run it. The path is the same for every caller whatever its `HOME`, `XDG_CACHE_HOME` or `TMPDIR` (a literal `/tmp`, never `os.tmpdir()`, which follows `TMPDIR`), so the limit stays host-wide (#3536), and the directory is made 0700. `waits.log` moves with it. For the one run in which an older checkout is still holding a slot under `~/.cache`, up to four suites can overlap; `/tmp` is cleared at boot, which takes the wait record with it. Pinned in `suite-slots.test.ts`: the default is one path whatever those three variables say, and a caller with a read-only home and a private `TMPDIR` takes a slot without writing under the home.

## 0.60.2

### Patch Changes

- e769620: The gate prints `NO PRODUCT ROW OFFERABLE (share N/10)` when its state changes, and once a day while it stands, not on every tick the shelf is empty (124 lines in 3 h, which the repeating-lines detector rightly offered as a fault). `offeredByShare` remembers the last line in `product-share-line.json` beside `engineer-starts.json`; a tick that stocks the shelf (a product row on offer, or the share at the floor) clears it so a recurrence prints, and a memory that is absent, empty, unparseable or unwritable prints and never throws. The line's text is unchanged. a11ign/a11ign#3929.

## 0.60.1

### Patch Changes

- dc27525: The DORA lead-time read no longer spends one `compare` per release. A repository that releases on every merge read `Lead time for changes: unknown -- ancestry of #304 could not be read`: 317 releasable changes asked about nearly all 184 releases in the window, one ~4 s `compare` each, and the 240 s repository budget (89 s of it spent resolving the releases) ended after 34. The newest release's range now lists the history from the oldest change in order, so ONE read places every release, by its own commit or else by its only parent (a tag is usually a one-commit "Release x.y.z" cut from a main commit and never merged back); a release or commit that history does not place is asked of its own range, as before. When every release is placed the first containing one is found by the same walk in time order as ever (free, and exact for a backport published after a newer release); when some release needs a read the releases are bisected, `O(log n)` reads per change, and a release answered once is remembered for every later change. A refused `compare` in the middle still ends `unknown`, never the neighbouring release's answer. A metric refused after the time limit was hit now says `(<call> hit its time limit)` on its reason, whichever metric it is, instead of blaming an ancestry. The budget now also binds an injected `range` reader. a11ign/a11ign#3910.

## 0.60.0

### Minor Changes

- c311f3d: A reply can say how many rows are open: `{{open.count}}`, the number of open issues, pull requests not counted (a11ign/a11ign#3909). Until now no reader returned a count of open rows, so a liaison asked "how many issues are open" guessed placeholder names (`{{open.count}}`, `{{issues.count}}`, `{{issue.count}}`) until it typed the bare figure under `My read:`, an opinion where a fact was asked for. The free-text filter is unchanged: a figure typed in the words is still refused, including the one the reader returned. The liaison's brief restates the vocabulary, so a project that pins it learns `open.count` from `PLACEHOLDER_NAMES`.

## 0.59.1

### Patch Changes

- 75bd8b8: The work gate takes the claim labels off a CLOSED row whose only listed holders are standing seats once it has been closed more than 24 hours. A standing seat is always listed, so the #3883 rule (a listed holder keeps its closed row) kept a seat's closed row for ever and the gate said `keeps its claim labels` on every tick, until the repeating-lines check ordered the seat. A row closed within the day, a row with a listed `worker-<n>` holder, and a row with a missing or unparseable `closedAt` are still kept. `readClosedClaimLabelRows` now reads `closedAt`. a11ign/a11ign#3900.

## 0.59.0

### Minor Changes

- a44be06: The tick's last completion is also written to one standing COMMENT (a11ign/a11ign#3896), because the control plane's token has no scopes and GitHub answers it `403` for the Actions variable `GATE_LAST_TICK` while it reads every public object. `writeHeartbeat` now EDITS comment `HEARTBEAT_COMMENT_ID` on the closed issue a11ign/a11ign#3880 (authored by `a11ign-ai-workers`, the identity the work-tick unit runs as, since only the author may edit), so the comment's `updated_at` is the last completion on GitHub's own clock and `curl` reads it with no `Authorization` header. The body differs on every tick (`<!-- gate-heartbeat -->`, the epoch milliseconds and an ISO stamp): measured, an edit that changes nothing does NOT move `updated_at`. The variable write stays, and the two fail separately: a failed comment write says one `HEARTBEAT COMMENT NOT WRITTEN` line on stderr, never changes the tick's exit, and never creates a comment (a missing one fails loudly).

## 0.58.3

### Patch Changes

- b06144e: The work gate takes the claim labels (`in-progress`, `started`, `session:*`) off a CLOSED row whose `session:` holder herdr does not list. The close path strips only a close it drives itself, so a row closed by hand, as not planned, or by a `Closes` GitHub resolved with another actor kept its claim for ever. The gate reads the closed rows carrying `in-progress` (one call, labels only), compares each holder with the herdr listing it already reads (and only a complete one), and strips through the close path's own decision; a row whose holder is listed is named on stderr and left alone. `labelsToStrip` and the strip itself move to the leaf `claim-label-strip.mjs`, which `close-rows-for-merged-pr.mjs` re-exports, so the gate need not import the close path. a11ign/a11ign#3883.

## 0.58.2

### Patch Changes

- 481cf8a: A `gh` call inside the gate's batch is cut at 30 s, as `defaultRun` cuts one run on its own. `BATCH_WORKER`'s `execFile` had no `timeout`, and the `execFileSync` around the worker had none either, so a stalled `gh` held the whole batch (the gate's, the claim's and the wake's pre-claim read) until the tick's own `TimeoutStartSec`. A cut call now answers as a refused one (`failed`, `status: null`, `code: "ETIMEDOUT"`, its stderr), so every caller's fail-open verdict and log line stand and the other calls' answers are intact. The worker's own wait is 5 s longer than the call's; if the worker is killed anyway, `runBatch` throws and the caller runs its calls one by one, as it already did. a11ign/a11ign#3843.

## 0.58.1

### Patch Changes

- c99d7fd: The tick's stuck escalation writes the question it asks, and asks again once (a11ign/a11ign#3874). `escalateStuck` labelled #3289 `answer:ceo` as the tick's own account with no comment, so `ceo` found no question, guessed one, removed the label, and the worker read the guess as an answer to a question it never asked; the key was then recorded as escalated and 31 later ticks said `ALREADY ESCALATED` to nobody. Now the label is preceded, in one call site, by a comment naming the cause key, the `MAX_DELIVERIES` count, that no session has acted on it, the target session's state read from herdr, and who can answer; a comment that fails is a `COULD NOT ESCALATE` with no label and no record, so the next tick retries. A cause whose label was removed and is still true 60 minutes later (`REASK_AFTER_MS`) is asked once more: one comment carrying a `stuck-reask` marker, the elapsed time and the earlier answer's comment id, and the label back. The row is the state, so nothing is added to the ledger: the label's last event says when it came off and the marker says it was re-asked. The seam is `escalateStuck`'s `ask`, which `escalationMemory` (now exported) always supplies; a test pins that wiring. A label that fails after its comment landed is retried as the label alone (a `stuck-escalation` / `stuck-reask` marker newer than the label's last event), never a second comment.

## 0.58.0

### Minor Changes

- dec5e27: The gate offers the engineer pool a product row first until at least 6 of the last 10 engineer starts were product rows (the chairman's capacity order, a11ign/a11ign#3820). A row is a product row when a Region entry lies under a `releasablePaths` entry of a `dora` repository other than agent-org's own, so a row cannot claim to be product without naming its files; an empty or unreadable Region counts as org and is named. When no product row is offerable the gate offers org rows as before and prints one `NO PRODUCT ROW OFFERABLE (share <n>/10)` line: an engineer is never left idle to hold a ratio. The last ten starts are kept in `engineer-starts.json` beside the gate's other state, read from the open rows the tick already has (no extra `gh` call). A project's `.agent-org/project.json` needs nothing new: the rule reads its `code` and `dora` lists.

## 0.57.0

### Minor Changes

- 9416eb4: The gate's tick writes its last COMPLETION to one GitHub object, so something off the agents host can read it without an ssh into a machine that may be frozen: the Actions variable `GATE_LAST_TICK` of the project's tracker repository (the declaration's first), set to the same epoch milliseconds `work-tick-completion.json` holds. It is written once, from `finish()`, AFTER the file and only on a tick that reached the end of `main()` (never on a `CRASH`), so it means what the file means. A write that fails says one `HEARTBEAT NOT WRITTEN` line on stderr naming the repository and variable, and never changes the tick's exit: the reader then sees a stale value. The variable must exist already (`gh api -X POST repos/<tracker>/actions/variables -f name=GATE_LAST_TICK -f value=0`); the tick only overwrites it.

## 0.56.9

### Patch Changes

- c9fb312: `src/private-tmp.test.ts`'s `LIVE` test is skipped, with its reason stated, when it is not reading a run of agent-org's own rstest config, instead of failing the file: under `tsx --test` (what `pnpm run verify`'s `agentOrg` step runs) `A11Y_PRIVATE_TMP_RUN` is never published, and in ci.yml's `agentOrg` layout `scripts/` is not copied, so the file's static import of the config died at load. The config is now imported only when it is on disk, and `liveSkipReason` is pinned both ways (each reason, and no skip when the config and the run root are both present). Under agent-org's own rstest run the `LIVE` test still runs and passes.

## 0.56.8

### Patch Changes

- b2c049f: The gate's `gh` runner is cut at 30 s (`GH_READ_TIMEOUT_MS`, the same bound `wake.mjs`'s `defaultGh` uses). `defaultRun` ran `gh` with no `timeout`, so one `gh` that never returned held the whole tick until the unit's `TimeoutStartSec=600` killed it, and every lane's reads went with it; `systemctlRun` and `herdrRun` already had one. A call that hits the bound is killed and thrown as the `ETIMEDOUT` refusal every reader already turns into `null` for its own lane, with one line on stderr naming the subcommand (`GH CUT in <repo>: \`gh pr list\` ran past 30 s and was killed`); the other lanes' reads go on. The batched path (`BATCH_WORKER`) is not bounded by this change and is the row after it (a11ign/a11ign#3843). This does not say a hung `gh` caused any of the 600 s kills in the journal; the line it writes is how a next one will be told.

## 0.56.7

### Patch Changes

- e11e05f: `prune-tmp.mjs` prints `tmp-entries: <N>` as the first line of every run (a11ign/a11ign#3868, from #3849's done-when 2): the number of entries directly under the directory it was pointed at, read at the start of the run, so the next run reads what this one's removals left. The unit runs every minute, so `journalctl --user -u a11ign-tmp-prune.service --utc` becomes the daily record of the count, with no new unit or file. The count comes from the one `readdir` the run makes: the doomed, fixture and review lists now share it instead of each reading a directory of ~120,000 entries again (three reads before, one after). It counts dotfiles too, which `ls /tmp | wc -l` does not. A root that cannot be read prints `tmp-entries: unknown`, never `0`.

## 0.56.6

### Patch Changes

- 683137a: A test that spawns `wake.mjs` as a process no longer waits the real five-second `/clear` settle. `wake.mjs` reads `AGENT_ORG_TEST_SETTLE_MS` for the blocking sleep behind the settle; the spawning tests set it to `0`. It is absent in production (no file under `host/` names it, pinned in `wake.test.ts`), it can only shorten the wait (a larger or malformed value is ignored), and `CLEAR_SETTLE_MS` stays `5_000` with the two `THE DEFAULT IS REAL` tests unchanged. Eleven spawning tests across five files each paid one real wait, about 55 s of test wall in all; measured before and after on the same machine. a11ign/a11ign#3769.

## 0.56.5

### Patch Changes

- 631675c: `auto-arm.yml`'s per-PR `arm` job no longer arms a pull request that carries a `hold:` label (a11ign/a11ign#3867). The job armed on the event alone, so a hold stopped `arm-pr.mjs` and `auto-arm-sweep.mjs` (both read `armabilityOf`) and did not stop the path that fires first: a11ign/agent-org#311 was marked ready with `hold:worker-3853` on it and armed eight seconds later. The step now reads the event's labels through `env:` (never interpolated into the script), prints one `AUTO-ARM: not arming` line naming the holders and `armabilityOf`, and exits 0, since a refusal is a done. The prefix is a `HOLD_PREFIX` env literal mirroring `pr-hold-state.mjs` (the job runs on `actions/checkout` alone and cannot import it), and `auto-arm-workflow-honours-hold.test.ts` runs the step's own script with a recording `gh` and fails if the two prefixes drift. A label that merely contains `hold` (`on-hold`, `holdout`) does not hold. Lifting a hold still arms nothing (`unlabeled` fires no arm).

## 0.56.4

### Patch Changes

- b51fe53: The gate names a refused read of one sha, and a stale evidence head says nothing (a11ign/a11ign#3724). `readPatchId`, `readCommitShas` and `readFailingChecks` handled a refusal and returned `null`, but `defaultRun` inherits stderr, so `gh`'s own bare `gh: Not Found (HTTP 404)` reached the journal beside it, naming no repository, pull request or sha (30+ ticks from one review of a11ign/lab#4 naming a head a force-push had removed). The three now read with `gh`'s stderr captured. A 404 or 422 on a compare or commit path is a sha that resolves to nothing and prints nothing: the pull request is read at its head alone, as before. Any other refusal (403, 5xx, a timeout, a 404 of a pull request's commits) is ONE line per tick naming the repository, the path (the sha elided, so every head is one line) and the status. Every other `gh` call is unchanged, and no call or phase is added (#3566's freeze).

## 0.56.3

### Patch Changes

- 00fb55e: The wake-drain overlap test (#3566 9b) no longer races the scheduler. Its stub `gh` paused 100 ms or 400 ms and the test asserted every read had started before any ended, which failed at host load 24 to 33 when a Node start-up outlasted 100 ms (4 of 6 `verify` runs red on correct code). The stub now answers only after every declared repository's read has stamped its start, and the first repository's read also waits for every other's end, so overlap is a condition the reads must meet rather than a margin; a one-by-one reader runs out a 15 s give-up and fails. Test only: no shipped code changes. a11ign/a11ign#3861.

## 0.56.2

### Patch Changes

- 40a4767: The gate's `pr-codeowner-review-missing` no longer names a pull request on the strength of another repository's with the same number (a11ign/a11ign#3720). It matched each PR to its files by number alone, so `lab#3` (one file, `packages/lab/package.json`) was named because `toolchain#3` touches a workflow, and `ceo` was ordered to review a dependency bump twice; the same defect could also leave a PR that does touch an owned path unnamed. The files are now keyed by repository and number (`subjectRef`, the gate's own spelling), so a tracker PR and a sibling's with one number stay two entries. The other number-keyed maps in `work-gate.mjs` read one repository each (the tracker's rows, the primary's open PRs) and are unchanged.

## 0.56.1

### Patch Changes

- ab89963: A keyed review tree links the clone's `.pnpm` along with its `.bin`. pnpm's shims in `.bin` find their package by `$0`-relative path without following the symlink, so a tree that linked `.bin` alone had shims pointing at a store that was not there, and a keyed reviewer of a pnpm repository could not run `pnpm exec <bin>` and posted an escalation instead of a verdict (screenreader-fleet#2). The clone is still never written, and its other dot entries are still not linked. a11ign/a11ign#3728.

## 0.56.0

### Minor Changes

- 6d59292: `worktrees:prune` releases a HELD tree whose row has closed, and a run removes a bounded number (a11ign/a11ign#3850, found in #3846). A stamped tree that `heldByOwner` refuses (no commit of its own, or detached) is now removable when every row it names is CLOSED (`rowsClosed`, read over `gh` only for such a tree) and git has not touched it for `CLOSED_ROW_RELEASE_AGE_MS` (six hours), with the same dirty, unmerged and `runs/`-record refusals as before: the 2026-10-06 run refused 269 of 336 worktrees because `.a11y-owner` is a copy of a claim nobody releases. One run removes at most `MAX_REMOVALS_PER_RUN` (25) trees with `PAUSE_BETWEEN_REMOVALS_MS` (250) between them, stops walking there, and the report says how many worktrees it did not examine; `worktree-prune.service` now runs under `Nice=19` and `IOSchedulingClass=idle`. No cap on live worktrees is added to `row-claim claim`: 356 worktrees against 7 open claimed rows, measured 2026-10-06, is a backlog of finished trees, and a claim-time cap would stop every claim until this prune drained it.

## 0.55.3

### Patch Changes

- 65c57ea: A row CLOSED while it still carries the claim has its claim released by the gate, and its per-row `worker-<n>` interrupted when herdr reports it `working` (a11ign/a11ign#3535). A new `closed` release reason sits beside `stalled`, `blocked`, `merged` and `gone`; the interrupt is an Escape with no prompt (a stop, so no wake is spent), after which `spareDecision` ends the instance as it ends any that holds no open row. A standing seat is released and never interrupted; a row closed by its OWN pull request (the claimed branch, the row suffix or the title reference, as `ownsPr` reads them) keeps the merged release it has, while a row closed by somebody else's pull request is still released. The read is ONE aliased `api graphql` call for the rows of the listed `worker-<n>` instances (`issue(number: n)` each), made ONLY when herdr lists at least one and asked inside the follow-ups' wave, so a tick of an org running no instance pays nothing (`GH_READS.conditionalOnListedWorker`, not an unconditional read). It is asked by number and not by `--label in-progress`, which today returns 264 closed rows that nobody holds.

## 0.55.2

### Patch Changes

- 5ca2d78: The `tick-cost` line names the GitHub-status call as a phase of its own (a11ign/a11ign#3730, split out of #3723): `work-tick` reads the wall from the line the gate already prints on stderr (`github-status: operational (call N ms).`, `github-status: UNKNOWN (...; N ms)`, or the `GITHUB INCIDENT:` line) and reports it as `phases["github-status"]` beside `gate`, so the call is readable on every tick against #3566's target without a person grepping the journal. The phase has a `wallMs` and no `cpuMs`, because the gate timed it and nothing measured its CPU; it sits inside `gate`'s wall, so the two are read beside each other and never added. A line that is absent, or says `wall not read`, adds no phase and no failure. Nothing else changes: no new call, no new order, and the status fetch, its timeout and its cache are as #3723 left them.

## 0.55.1

### Patch Changes

- b2d6d22: Every test run gets a private `TMPDIR`, and a test file that leaves anything in it is named in the run's report (a11ign/a11ign#3854, from the #3846 host-hang incident, where `/tmp` held ~121k test temp dirs that nothing removed). The rstest config's `globalSetup` (`src/private-tmp.ts`) creates `~/.cache/a11ign/tmp/run-<stamp>-<pid>-<random>` before the first file; each test file's worker (`src/private-tmp-setup.ts`) gets its own directory inside it and `TMPDIR` points there, so `os.tmpdir()` and every child process land in it. When the run ends, pass or fail, the teardown names each file that left an entry (on a passing run too), then removes the run one entry at a time, never with one recursive `rm`. Every removal refuses an empty or unset path and anything not under `<base>/run-*`. A leak turns the run red (#3848's fixes have landed, and a full run reports none); `A11Y_PRIVATE_TMP_LEAKS=report` downgrades it to the report alone. tsx's and V8's own `tsx-<uid>` and `v8-compile-cache-<uid>` caches are not a test's and are not named. #3849's tmpfiles rule ages out the `run-*` of a killed run. Test tooling only; no shipped command changes.

## 0.55.0

### Minor Changes

- 99d30e4: `org-health` raises `fleet-auto-off-refusing` when the fleet's auto-off timer has refused to power workers off for more than 15 minutes (a11ign/a11ign#3853, incident #3846, 2b). On 2026-10-06 that timer refused 2,569 times over about twelve hours and nothing that raises read the record it keeps, so idle workers stayed on. `autoOffRefusalReading` trips on a refusal whose FIRST tick (`refusal.since`) is over `AUTO_OFF_REFUSAL_MINUTES` (15) old, naming the reason and the age in the order `ceo` gets. The tick reads `runs/fleet-auto-off-mirror.json` (`AUTO_OFF_MIRROR_PATH`), shaped `{ readAt, record }`, which `fleet-watch` writes after its hourly ssh read of the control plane's own record (a11ign/a11ign#3860); the tick itself never ssh-es and the control plane's file stays root-only. `readAutoOffRefusal` is what `orgHealthTick` calls when the caller gives no `autoOff` fact. It is a stated unknown, never a clear, when the mirror is absent or unparseable, when it was read over `AUTO_OFF_MIRROR_STALE_MINUTES` (120) ago (the watcher did not look), when the record's last tick was over `AUTO_OFF_RECORD_STALE_MINUTES` (5) before `readAt` (the timer had stopped; judged against `readAt`, not the tick's clock), or when the refusal carries no `since`: `at` is rewritten every ten seconds and would read every standing refusal as brand new. `since` is the producer's to write (`fleet-auto-off.mjs`, a11ign/a11ign#3859, outside this repository) and a tick that proceeds ends the run, so until both rows land the signal reads unknown on every tick.
- 8f17a31: `prune-tmp` is now run by a timer and removes in small batches (a11ign/a11ign#3849, incident #3846). A third family is classified: a directory directly under `/tmp` carrying one of the prefixes the repository's own test fixtures use (`FIXTURE_PREFIXES`), removable when its newest write is over an hour old and no process holds it. A run removes at most `MAX_REMOVALS_PER_RUN` (300) filesystem entries, one call each from the leaves up with a pause after each, and never a recursive delete of a whole tree; a fixture is first renamed `.prune-tmp-doomed-*`, so a tree the budget stopped inside, or a run that was killed, is finished first by the next run. A run over an empty `/tmp` prints `nothing to remove`, and a run's report tallies thousands of young fixtures by reason instead of listing them. The new `tmp-prune.service`/`tmp-prune.timer` run `prune-tmp.mjs --apply --fixtures-only` every minute under `Nice=19` and `IOSchedulingClass=idle` (the review and scratchpad families still wait for #2166's announced cycle), and `a11ign-tmp.tmpfiles.conf` is a user tmpfiles rule that ages `~/.cache/a11ign/tmp` (the private root #3854 and #3855 create per run) out after one day; `host:install` copies it to `~/.config/user-tmpfiles.d/`.

## 0.54.24

### Patch Changes

- 3135203: A test that makes a temporary directory removes it, and a guard fails the suite for one that does not (a11ign/a11ign#3848, incident #3846 1a). On 2026-10-06 `/tmp` held 121,411 entries and 14 GB, 6,448 of them `verify-stamp-test-*` from one test file that called `mkdtempSync` and never removed. `src/lib/tmp-fixture.ts` gives a test `tmpDir(prefix)` (removed in `afterEach`, so a killed run leaves at most the directory in flight) and `tmpDirForFile(prefix)` (for one every test in the file shares, removed in `after`). `src/tmp-fixtures-are-removed.test.ts` reads every test file and the support modules that build fixtures, and names each that calls `mkdtemp`/`mkdtempSync` or runs `mktemp -d` with no removal reachable from an `after`, `afterEach`, `afterAll`, `.after(` or `finally`; a removal named only in a comment, at the end of a test body, or on `process.on("exit")` does not count. It was red on 20 files and each is fixed, along with `host-units.test.ts` and `prune-tmp.test.ts`, whose partial cleanup left 26,000 and 4,309 entries. A live test runs the fixed files under `node --test` with a `TMPDIR` of its own and asserts it is empty afterwards. No change to what the tool does.

## 0.54.23

### Patch Changes

- 6106dc3: The wake's check before it starts an engineer (`spawnClaimability`) reads each declared repository's open pull requests together instead of one after another: the eight `gh pr list` calls, 3.9 to 5.3 s one at a time on the live host, now cost the slowest of them. The read goes through the batch the claim and the gate already use (`readWithFirstWaveTogether`), only for the wake's own `gh`, so a test's fake `run` still sees its calls one at a time. Same commands, same repositories, the list in the repositories' own order, and the same fail-open: a refused repository leaves the read inconclusive with the `row-claim: could not read <repo>'s open pull requests` line and the wake's `could not read the open pull requests` line unchanged. The read still happens before the worktree and the instance are made.

## 0.54.22

### Patch Changes

- 767375a: `row-claim claim` makes its four `gh label create --force` together instead of one after another. They create-or-update each label to the same colour and description every time, so none depends on another; on one real claim tick they were 3,168 ms of the claim's 15,662 ms, and the same four measured 3.3 to 3.7 s one at a time and 0.9 to 1.6 s together. The commands are unchanged, they still run before the fresh label read, the label `PUT` and the re-read after it stay one at a time and in order, and a create GitHub refuses (or a batch that cannot start) is said aloud and then asked one at a time, which throws the error the claim always threw before any label of the row is written. a11ign/a11ign#3566, slice 9 of the tick's cost.

## 0.54.21

### Patch Changes

- 0dd3ec8: A review tree is now given the registry's `@a11ign/*` packages of the tick's checkout, not only the workspace's. `linkReviewDependencies` linked third-party entries, skipped the root `@a11ign` directory whole, and then deleted every entry of the tree's scope that was not a workspace package, so since the split (`@a11ign/screenreader-fleet`, `@a11ign/screenreader-worker`, `@a11ign/toolchain` are the registry's) a reviewer of a PR importing one died at `ERR_MODULE_NOT_FOUND` before its Acceptance ran (#3806, #3834). Each entry of the tick's root scope that does not lead into `packages/` is now linked to the tick's own, kept by the stale sweep, and removed again once the tick's checkout drops it; a package the reviewed head declares in its workspace still wins by name, so the tree's source is what is reviewed. It reads the one directory the tick already holds. Measured against the live primary at `8940cc2b6`, a fresh tree's `node_modules/@a11ign` held six workspace entries before and those six plus the three registry ones after, and the link took about 12 ms either way.

## 0.54.20

### Patch Changes

- a9a2f54: The isolation gate's copy leaves out the checkout of a layer that has a repository of its own (`layers.json`, a layer with a `remote`) and says how many it left out, because that layer publishes from its own repository and its `prepack` needs a `pnpm` the lab does not have. This matches the original, which `agent-org-wiring.test.ts` compares (a11ign/a11ign#3830).

## 0.54.19

### Patch Changes

- 365cb79: `primary:update` no longer rebuilds the primary checkout when nothing moved. The build ran on every tick (the `work-tick` unit runs this step first, about 30 times an hour) and cost 11.6 to 12.4 s of wall clock and 27.6 to 29.9 s of CPU for a build that changed nothing, measured on a scratch clone at an idle host; that CPU is outside the tick process, so the `tick-cost` line never counted it. The build is now skipped only when ALL of these hold: HEAD did not move, the last SUCCESSFUL build was of this exact sha, and every `packages/*/dist` that build left is still there and not empty. The record is a stamp at `.git/primary-build-stamp.json`, written only after a build returns, so a failed build leaves none and is retried on every tick as before, and a `dist` somebody deleted is rebuilt. A project needs to do nothing to take it; the first tick after the release builds once and writes the stamp.

## 0.54.18

### Patch Changes

- 2bf31d8: The gate reads the NEWEST comments of a claimed row, not only the first 100. `gh issue list --json comments` returns a row's first 100 comments, oldest first, and says nothing about the rest, so on a row with more the claim-stall pass took an old claim record for the newest and read an already-merged pull request as "merged after the claim": #3566's claim was released twice within two minutes each time. A row that comes back at the cap is now re-read from its end in ONE batched GraphQL call for all such rows (`comments(last: 100)`, handed on in the same oldest-first shape); a tick with no row at the cap makes no extra call. A capped row whose end cannot be read is left out of the page, so the claim-stall pass skips it instead of releasing it. a11ign/a11ign#3821.

## 0.54.17

### Patch Changes

- 1261c99: A `trunk-red` order for an author who has ended, refused only because every engineer seat is `working` or holds its one row, is a DEFERRED capacity wait under the half-hour limit and no longer a fault from its first tick (a11ign/a11ign#3814). `routeWithFallback` writes `no workspace labelled "<author>"; and the fallback "engineers": no engineer is idle ...`, which the anchored `CAPACITY_REFUSAL` did not match, so the order was `UNDELIVERED` and counted as `nowhere to go` for 30 ticks on 2026-10-06. Only an ABSENT author and only the `engineers` fallback are accepted; an idle seat, a `; no spawn:` tail, an author that is merely `working`, or any other fallback stays a fault.

## 0.54.16

### Patch Changes

- 441bf3b: The `tick-cost` line gains `phaseCalls` (a11ign/a11ign#3566, slice 7): for the calls the tick's own process starts inside a phase (`tearDownSpares`, `tearDownReviewers`, `recover`, ...), the same count and wall per `<program> <subcommand>` that `subcommands` gives for the whole tick, so the 8 to 10 s the two teardowns take can be read as the calls that make it. A census record carries the phase the meter had set when the child started; the meter sets it around each step and clears it in a `finally`, so a throwing step cannot leave a stale name. The gate's and the wake's own children are another process and stay counted whole-tick. Nothing in the tick changes: no new call, no new order.

## 0.54.15

### Patch Changes

- 5de1abd: The gh call ledger's caller test no longer fails under a long `TMPDIR` (a11ign/a11ign#3807). The ledger keeps the first 160 characters of the parent's command line, so a fake caller spawned by an absolute path under an agent session's scratchpad was cut before its script name. The test now spawns it as `fake-caller.sh` from inside its directory. Test only: `host/gh` is unchanged, because a caller line cut at 160 characters is its documented shape.

## 0.54.14

### Patch Changes

- 9148deb: The gate asks the tracker's lanes and the other repositories' lists as one wave instead of two. `readTrackerLanes` (three `gh issue list`/`label list` calls) and `readOtherScopes` (one `gh pr list` per other declared code repository) each made their first reads together but one after the other, and neither needs the other's answer: in a gate run with its spawns traced the first was one batch of 1.7 s and the second the next of 1.3 s. `readLanesAfterOutageCheck` rehearses both once, sends the calls of both as one batch (`readWithFirstWaveTogether`, the seam slices 2 to 5 use), and replays each reader its own answers, so the commands, their parsing and every verdict are the readers' own and only when the waiting happens moves. It is asked where the tracker lanes already were, after the check that both of `readPrs` and `readReadyRows` were refused, so an outage tick asks no more refused questions than before, and those two reads stay outside it. What a rehearsal cannot foresee (a chairman row's events, read once the list is in hand) still runs on its own. a11ign/a11ign#3566, slice 6 of the tick's cost.

## 0.54.13

### Patch Changes

- c92f324: The test for an unreadable deferral record no longer fails under a long `TMPDIR` (a11ign/a11ign#3792). The log line keeps the first 160 characters of the error, which names the record's path before what was wrong with it, so an agent session's scratchpad cut the assertion's text away. The test now gives the ledger as a relative path from inside its directory, so the path the message names is `./wake-deferred` whatever `TMPDIR` is. Test only: `wake.mjs` is unchanged.

## 0.54.12

### Patch Changes

- b080069: The claim asks what it checks before it writes together instead of one after the other. `claimRow` read the row's body, its `blockedBy` edge, the rows the session already holds and then each declared code repository's open pull requests through the synchronous `gh`, one round trip after another (15 synchronous reads and 9.2 to 10.4 s in a read-only run at load 50 to 58). The checks now run once as a rehearsal against empty answers, the reads they make first go out as one batch through `readWithFirstWaveTogether` (the seam the gate's slices use), and the checks run again against the real answers: 4 synchronous reads and 3.6 to 4.0 s, the same 15 calls in all. The commands, their parsing and every verdict are the checks' own and no rule file is edited. Nothing from the first write on is batched: the labels the claim reads before the checks and again right before the write stay fresh and sequential, and a write is never rehearsed. A refused read replays as the throw it was; what the rehearsal cannot foresee (the claimed rows' Regions, which wait for a Region that names a file) still runs on its own. The one difference is on the failure path: B4 stops at the first repository whose list is refused, while the batch had already asked the others'. a11ign/a11ign#3566, slice 4 of the tick's cost.

## 0.54.11

### Patch Changes

- 892cdbf: The gate asks for its tracker lanes together instead of one after the other. `main` read the backlog, `needs:chairman` and open lists, then the claimed rows' comments, the closed-answer label list and the recently closed rows, each through the synchronous `gh`; they now go out as two batches (`readTrackerLanes` after the outage check, `readOpenRowFollowUps` once the open rows are in hand) through `readWithFirstWaveTogether`, the seam slices 2 and 3 use. The commands, their parsing and the orders are unchanged, no read is added (the conditional ones stay conditional on the rows in hand, and the lists are still asked after the check that both pull-request and Ready reads were refused), and a refused read is that lane's `null` and nobody else's. What a batch cannot foresee (a chairman row's events, the closed-answer searches built from the label list) still runs one at a time. a11ign/a11ign#3566, slice 5 of the tick's cost.

## 0.54.10

### Patch Changes

- b79753b: The three process-form sweep tests (`arm-refuses-an-ejected-pr`, `arm-refuses-open-blocker`, `pipeline-lane-authorship`) no longer wait the sweep's real 2 s between re-reads (a11ign/a11ign#3768). They spawn the whole `auto-arm-sweep.mjs` against a fake `gh` that never changes its answer, so no injected `sleep` reached the wait and each read exhausted its retries in real time. `waitBetweenReads` now takes the wait from `AGENT_ORG_SWEEP_WAIT_MS` when it is a whole number of milliseconds, and the three tests set it to `0` in the spawned sweep's environment. Unset, empty or malformed is the real wait (`CONFIRM_ARMED_WAIT_MS` and `MERGED_MEANWHILE_WAIT_MS`, both still `2_000`), so production is unchanged: no unit, workflow or non-test source sets it, and `sweep-wait-override.test.ts` pins that, the default and the garbage-is-not-zero rule. Measured with an `Atomics.wait` preload on the same host: 33 waits of 2 s before (12, 12 and 9), the same 33 calls at 0 ms after; wall 25.5 s, 26.0 s and 19.4 s before, 3.3 s, 4.1 s and 2.7 s after.

## 0.54.9

### Patch Changes

- d2067cd: The gate asks for the timelines of the answer-given lane together instead of one after the other. `answerGivenOrders` read one `issues/{n}/timeline` per touched claimed row through the synchronous `gh`, so the lane cost the sum of its reads; the reads now go out as one batch (`readWithFirstWaveTogether`, the one the other repositories' reads use), and the commands, the orders and their order are unchanged. Every touched live row is read, even where the 8-order cap would have stopped the old loop early, because a row's order count is known only after its timeline is read; the orders returned are still the first 8. A refused timeline is that row's silence and nobody else's. a11ign/a11ign#3566, slice 3 of the tick's cost.

## 0.54.8

### Patch Changes

- 9adf2bb: The gate's per-tick `github-status: operational (call N ms).` reading (a11ign/a11ign#3723) is an expected repeating line: `repeating-lines.allowlist.json` names it, so the detector stops offering it to `orchestrator` after 30 ticks. Its other two states, `github-status: UNKNOWN (...)` and `GITHUB INCIDENT: ...`, stay offered.

## 0.54.7

### Patch Changes

- 84373b3: The daily DORA read can no longer stop a tick (a11ign/a11ign#3736). It kept nothing until every declared repository was read, so a tick killed at `TimeoutStartSec=600` (23:59:18Z on 2026-10-05, 00:10:21Z the day before) wrote nothing and the next tick began the whole read again, every tick, until the UTC date changed. Now each repository's reading is written to `dora-reading.json` the moment it is taken (`resumableDora`), every repository is read at the first one's `now`, and a tick spends at most `DORA_TICK_BUDGET_MS` (60 s) before it stops between repositories, always reading at least one. The retrospective is offered only when every declared repository has a reading, and a tick that has not reached them all offers nothing and logs `the DORA read has N of M repositories`; the merged-list, journal and transcript reads are not made on such a tick. Every child `dora.mjs` and `org-retro.mjs` start carries a timeout (`READ_TIMEOUT_MS`, 90 s; `REPOSITORY_BUDGET_MS`, 240 s for one repository in total), so a hung call ends at the bound, names itself in the repository's `unknown` reason, and is never a 0. A cache of the old shape (`{ date, report }`) is read as a miss.

## 0.54.6

### Patch Changes

- 1826c34: `org-health`'s `runner-behind-newest-release` reads the CI runner from the run that gates `main` today, and an unreadable runner says the same thing on every release. The reader asked `ci.yml/runs?branch=main&status=completed&per_page=1`, which on a repository whose `ci.yml` runs on `merge_group` (on a `gh-readonly-queue/...` branch) answers the last `push` to `main` for ever: `a11ign/a11ign`'s was 2026-09-18, a failed run whose log names no version, so the reading was UNKNOWN on every release with no event that could clear it. It now asks for the newest completed `merge_group` run first, and falls back to the newest completed run on `main` for a repository with no queue. Three things had to change with it. The resolver notice since #3534 is `##[notice]resolved vX.Y.Z, the newest stable of N tags, into <dir>` and not `agent-org resolved vX.Y.Z`, so `RESOLVER_LINE` reads both, and a CI that cloned the newest tag at run time is `current` (a release cut after its last run is what its next run takes, so it is never `behind`, which with a release every 23 minutes it would otherwise be nearly always). The log of a real run is megabytes (5.0 MB measured), past `execFileSync`'s 1 MiB default, which ended the read in `UNREAD`, so `gh` reads up to 64 MiB. And the unknown's text named the newest release (`no runner is behind v0.54.4, but 1 could not be read`), so the same unreadable runner was a different line on every release; it now says `the newest release`. A repository with no completed run on either question is still `UNREAD`, and a run whose log names no tool is still UNKNOWN.

## 0.54.5

### Patch Changes

- 4b79426: A claim is no longer refused by a local branch that holds nothing `origin/main` lacks (a11ign/a11ign#3745). `row-claim claim --branch=<b> --worktree=<p>` asked only whether `refs/heads/<b>` existed, so the first slice's leftover branch of a multi-slice row refused every later claim of the row: #3566 was offered and refused on 93 ticks in 24 hours. It now asks what the branch holds. A tip that is an ancestor of `origin/main`, with no worktree holding the branch, is recreated at `origin/main` (`git worktree add -B`), after the fetch re-checks that the old tip is still an ancestor, and the claim line and result (`replacedTip`) carry the old sha. Every other state is refused as before, and the refusal now says which: "merged into origin/main" or "NOT merged into origin/main, N commit(s) ahead", plus the holding worktree's path; a merge state or worktree list git cannot give counts as NOT free. `claimLineFor` is exported for its test.

## 0.54.4

### Patch Changes

- 9802532: The scan behind `#2174: no test file joins the history-requirement population` reads each module once per run (a11ign/a11ign#3549). `deriveClosureRequirements(entry, memo)` takes an opt-in `createClosureMemo()` that keeps a file's source, parse, reachable scope, pattern matches and import edges, so a module reached from many entries is read once; omitted, each call gets a fresh memo and answers exactly as before (all 190 `src/packaging` entries return byte-identical hit lists to the unmemoised code). `lib/pin-ratchet.mjs` gains `changedSince`, which `judgePin` passes to the scan, so the scan of the base re-reads only entries whose walk touched a changed file, and the whole base after a deletion or rename. One pass over the packaging directory was 182 CPU-s, twice per run.

## 0.54.3

### Patch Changes

- 86795a2: A `blocker-cleared` order is dropped for a holder who claimed after the clearing even when a cleared blocker closed outside the closing list's reach (a11ign/a11ign#3706). #3534's blocker #3509 was absent from `readRecentlyClosed`'s list, so the gate logged `order KEPT -- the closing time of #3509 was not read` on every tick from 18:38Z and deferred an order telling a worker in the middle of the row to pick it back up. The list was never "the 100 most recently closed": `gh issue list --state closed` orders by CREATION, and 15 rows closed after its oldest listed closing were absent (measured 2026-10-06). `readRecentlyClosed` now asks the same single call with `--search sort:updated-desc --json number,closedAt,updatedAt`, which bounds an absent row from above (`closedAt <= updatedAt`, so it closed no later than the oldest listed `updatedAt`), and returns that as `closedNoLaterThan` beside the map, only when the listing is checked to be sorted by `updatedAt` (`gh` silently ignores a sort key it does not know). `staleClearing` compares the claim with the newest of the listed closings and that bound, and names the bound in its log line when it decided. A refused read, an empty list, a map without a bound, and an unsorted listing still keep the order and say which read was missing.

## 0.54.2

### Patch Changes

- 9ac42bb: `org-health`'s red-PR signal no longer counts a red the gate is holding for a runner start (a11ign/a11ign#3731). #3723's `holdForGithubIncident` withholds a `pr-checks-failing` order whose failure is a runner start while GitHub reports an incident, but `main` handed `orgHealthNow` the orders from BEFORE that hold, so the same red still tripped `red-pr-unattended` two hours later: a second alarm for a failure the org had chosen not to act on. `holdForIncidentNow` now returns the hold's `held` beside the kept orders and `main` passes it to `orgHealthNow`, which leaves the pull requests it names out of the red-PR facts. Nothing is recorded: the first tick after the incident clears holds nothing, so the same red counts again by itself. A red that RAN and failed, and one the gate cannot classify, are counted as before. Only a rollup red (`FAILURE`, `TIMED_OUT`, `STARTUP_FAILURE`) can ever trip the signal, so a hung check or an ejection was never double-counted.

## 0.54.1

### Patch Changes

- 2ce35c3: `resolveTypescript` accepts a `typescript` only if it exposes the JS compiler API the tool calls (`createSourceFile` and `ScriptTarget`), and otherwise tries the next place (a11ign/a11ign#3729). TypeScript 7 is the native compiler: its `typescript` entry point loads without throwing and has no `ScriptTarget`, so a project pinning `typescript` 7.x had its copy returned first and `pr:open` crashed at `ts.ScriptTarget.Latest`, the fallback to the tool's own tree never taken. When no place has the API the error now names each candidate rejected and why. A project with a working `typescript` 5 or 6 still resolves to its own, first. `lib/tree-wide-guard.mjs` is a declared copy and is not changed here.

## 0.54.0

### Minor Changes

- b438912: The gate reads GitHub's own status once a tick, and a runner outage is held as ONE signal instead of woken as a hundred reds (a11ign/a11ign#3723, `ceo`'s exception to #3566's freeze, 2026-10-05). `https://www.githubstatus.com/api/v2/summary.json` is fetched by a child `node` that `main` starts BEFORE its first read and collects after the orders are decided, so its wall overlaps the tick's own and adds none (3 s bound, plus the worker's boot; a worker that cannot start, a timeout, a non-200, a body that is not JSON, one naming none of the three components, or a component status the gate does not know is `unknown`, which holds nothing and raises nothing). While `Actions`, `API Requests` or `Git Operations` is not `operational`: (1) ONE `org-health` order to `ceo`, subject `github-incident`, keyed on the incident's id (no new order kind), names the incident and every order it holds; (2) the `pr-checks-failing` orders whose failure is a RUNNER START are withheld, not printed, so nothing is labelled and nothing needs lifting: a red check that is an Actions job with no steps and no runner (EVERY red check must be one, so a red that ran goes out), a hung-check whose check is still `QUEUED`, and a merge-queue ejection whose `merge_group` run failed only in such jobs (found by its branch and by ANY conclusion, so a run whose one job was cancelled is read). A failure the gate cannot classify (a refused job read, a check with no job link, no run found for an ejection, an `IN_PROGRESS` hang) is NOT held. It clears itself: the next tick's reading with all three operational prints the same orders again and they are delivered whole, with no call beyond the status read. The reading and its wall are one stderr line per tick (`github-status: operational (call N ms)`), and the job reads that classify run only inside an incident, once per job. Measured against the real jobs of 2026-10-05 (`cancelled`, `runner_name: ""`, zero steps); over 15 real runs of the worker from this host the median fetch wall was 251 ms (the worker's own timer, node boot excluded) and starting it cost the gate's thread 5 ms, so the 5-minute cache the exception asks for above 1 s is not built.

## 0.53.2

### Patch Changes

- a2ac95b: The gate asks the other repositories' first reads TOGETHER (`src/work-gate.mjs`): each other repository's open pull-request list, its merged list and its `main`'s `ci.yml` runs go out as one batch (`readWithFirstWaveTogether`, `runBatch`: one synchronous spawn of a `node` that starts the `gh` calls at once), where they used to wait one after another. The commands, their parsing and every order are the same: the readers run once against empty answers to name what they ask, the batch answers those, and a call that was not foreseen (the widened page after a full first one) still runs on its own. A call is answered once; a refusal reaches its reader as the throw `execFileSync` made, so a lane that could not be read is still `null`. Measured 2026-10-05 on one host, four gate runs each way alternated at the same load, `gh` timed by a shim on PATH: 35.8 to 41.9 s before (mean 38.7 s), 28.5 to 30.0 s after (mean 29.5 s), 46 to 68 `gh` calls either way. The tick-cost line's `gh` wall now excludes these calls (they are counted by the batch's own `node`, which is timed); their count by repository is unchanged. a11ign/a11ign#3566.

## 0.53.1

### Patch Changes

- aa1ff0c: `hostDriftOrders` no longer orders `orchestrator` on a drift set whose findings are ALL `manualFix` (a11ign/a11ign#3703). Its only remedy is `host:install`, which writes no line of a person's `gh` login (#3643), dotfile or Codex trust grant, so the order was declined every tick and the stuck breaker logged `cannot be escalated` for 30 consecutive ticks (its subject is `host-units`, not a row). `host:check` still reports every such finding; a set holding one finding `host:install` can clear keeps its key and its full prompt. The cost, stated in the function's header: a new manual-only finding wakes nobody on its own.

## 0.53.0

### Minor Changes

- e2556cd: `host:check` now names a clone declared in `host.json`'s `clones` that the reviewers' Codex does not trust: a `CLONE NOT TRUSTED BY CODEX` finding per clone with no `[projects."<path>"]` table whose `trust_level` is `"trusted"` in `~/.codex/config.toml`. An absent or unreadable config is a finding that says which, never "trusts everything". The check READS ONLY and its remedy says so: a trust grant is a ruling per repository, so `host:install` writes nothing here. Without it a new clone left its keyed reviewer refused at startup on every tick, and the pull request behind it unreviewed. a11ign/a11ign#3702.

## 0.52.7

### Patch Changes

- 05b5aba: `trace --aggregate` (and `--map`) survive a transient GitHub 5xx (a11ign/a11ign#3700). One `HTTP 500` on a check-runs list killed a 1,500-call pass with an uncaught stack and no report. `budgetedGh` now tries a 500, 502, 503 or 504 again after a pause (2 s, then 4 s), up to 3 tries in all; EVERY try is a counted, paced and floor-checked call, so the budget line's total includes them. A 4xx (404, 403, 422) is an answer and is never retried. A call that outlasts its tries stops the run like the budget or the floor does (`reason: "failure"`): the pull request in hand is named unread, what was read before it stays in the store, the footer says `STOPPED AT THE GITHUB ERROR: stopped at gh api <url>: HTTP 500 after 3 attempts`, and a failure while listing the merged pull requests (where there is no report to give) is that message on stderr with exit 1, no stack. The single-number `trace -- <n>` reads through `ghApi` and is not changed.

## 0.52.6

### Patch Changes

- 7a3b850: `messaging/selftest.mjs --tick` no longer exits 13 ("Detected unsettled top-level await") when it has work to do, so the check that follows a messaging release reports `PASS`, `RED` or `sent` and not `MESSAGING SELFTEST NOT RUN` (a11ign/a11ign#3701). The entry ended in `process.exitCode = await main(...)`, and `main` -> `tickSelftest` -> `realQueue()` imports `wake.mjs`, which imports `selftest.mjs`: the entry, still waiting on its own `await`, was a module in that cycle, so each waited for the other and Node drained the loop. The entry now sets the exit code in a `then`. Every test called `main` with an injected queue, which skips `realQueue()`, the one call that closes the cycle; `selftest.test.mjs` now runs the entry as a process (an isolated `HOME`, a state file that says a run is already waiting, so nothing is queued) and asserts it does not exit 13, its last stdout line is JSON, and a refused flag still exits 2. What `tickSelftest` decides and writes is unchanged.

## 0.52.5

### Patch Changes

- c0a0b70: The `tick-cost` line names each `gh`, `git` and `herdr` call by its SUBCOMMAND (`src/lib/spawn-census.mjs`, `src/work-tick.mjs`): a new `subcommands` object, keyed `gh pr list`, `gh api repos/a11ign/a11ign/issues/#/timeline`, `git rev-parse`, `herdr agent list`, each with `n` and `wallMs`, the ten slowest by wall and the rest summed into `other` so the total still adds up. A digits-only path segment is `#` and a query string is dropped, so an issue number does not make every call its own key. Until now the line said `gh` was 66 calls and 50 s per tick and could not say which of them, so the gate's `gh` reads could not be cut in the order of the profile. A record with no `sub` (a `node`, or one written before this) is left out, not counted under an empty name. a11ign/a11ign#3566.

## 0.52.4

### Patch Changes

- a0d32cd: `trace-publish` reads the rows closed in the last seven days from the REST issues list, not the search API (a11ign/a11ign#3695). `recentClosedRows` lists `repos/<repo>/issues?state=closed&since=<ISO time>` on the `core` pool, which holds every issue closed since the time, and filters by `closed_at` and by the absence of `pull_request`, so the record issue (#928: commented on all day, closed in September) is updated inside the window and still not returned. It reads one counted call per 100 issues where the search read one, and a list not finished in 30 pages is refused rather than cut short. `NO SEARCH` in `trace.test.mjs` no longer names an exception: no source of `src/trace/` reads the search API.

## 0.52.3

### Patch Changes

- ee97f5a: The chairman-messaging listener can now read `{{fleet.workers-up}}`, `{{fleet.workers-down}}` and `{{gate.last-tick.age}}` in a `Verify:` (a11ign/a11ign#3646). `createWatchReaders` built its readers with neither the fleet-watch files nor the gate record, so those three placeholders refused ("this host named no fleet-watch state files") and a walk-through over a worker power-on never advanced. `createWatchReaders(repo, now, files)` now takes what the new `hostFiles({ root, err })` names: `runs/fleet-watch-state.json` and `runs/fleet-captures-state.json` under the project's checkout, and the tick's completion record beside the wake ledger. `listen.mjs` and `watch.mjs` pass it. A host that cannot name the completion record costs `{{gate.*}}` alone, said on the journal. `chairman:watch` is unchanged: a fleet cannot be watched.

## 0.52.2

### Patch Changes

- 09a6acc: `wakes-per-row` reads the merged pull requests of its window from the REST pull-requests list (a11ign/a11ign#3692), through the reader `trace` already uses (`listMergedPulls`), not the search API through `gh api --paginate`, which is 30 calls a minute per user, one call per page in one unpaced burst, and cut at 1,000 results without saying so. `readMergedPulls` keeps its signature and takes the reader as an optional third argument, so its cases run with no GitHub. A window the list cannot finish in its 30 pages is refused, and the refusal names `--from` (this tool's flag) where the reader's own message names `--since`.

## 0.52.1

### Patch Changes

- b757970: `trace -- --aggregate` and `--map` read the GitHub events of every row and pull request the window's wakes name (a11ign/a11ign#3688). The store held a record only for the rows a pull request MERGED IN THE WINDOW closed, so a repeat of an order about an open row, a row closed another way or in an earlier week, or a pull request that was not one of the week's merges had nothing to be judged by and read `unexplained`: 349 of the 599 repeats of the week of 2026-09-28 (measured 2026-10-05, `trace -- --aggregate --since 2026-09-28`). `githubEventsOfNamed` reads them after the merged reading, through the same budgeted `gh` (`--calls`, the pool floor, the pace), oldest naming first, so a stop leaves the NEWEST wakes' subjects unread, and returns what it did not reach by name. A subject the store already settles (a closed row, a merged or closed pull request) is not read again; an open one is read on every run, because its record grows and a stored reading of it can be stale (a stale reading would print `unchanged` for a repeat that did follow a change, which is worse than `unexplained`). A subject GitHub refuses is named in the footer with GitHub's words and the next is still read. A key that names no subject (`ready-queue-empty`, `org-health`) reads nothing and stays `unexplained`, correctly. The footer's GitHub line gains `subjects the wakes name, not yet read: N` and the subjects it could not read.

## 0.52.0

### Minor Changes

- 13d8a75: The organisation checks the chairman's path end to end after a messaging release (a11ign/a11ign#3540). `agent-org messaging:selftest` sends ONE synthetic inbound through the real `createInbound(...).handle()`, the real `converse.forward`, the real queue port and herdr's real roster, with a RECORDING provider (it imports no provider and calls no `fetch`, so nothing reaches his chat), an order text that says it is synthetic and asks the seat to take no action, and its own ledger (`selftest-ledger.jsonl`, never the chairman's, so `messaging:measure` does not count a check). It reads the line back and judges four stages, naming the first that failed: `listen`, `queue`, `seat` (typed in at once, or the queue entry left the queue within 10 minutes, a bound measured from 385 ticks) and `back` (the acknowledgement came through the recorder). An order that went to `ceo` and not the liaison is a DEGRADED pass, never green. The work tick runs it once on the first tick after the checkout moves to a tag whose changes touch the messaging code, the queue or the roster's readers (`selftestDue`, a pure function of two tags and a file list), records the version only when it PASSED, retries a red after a 10-minute back-off, and queues a red or degraded report for `ceo` once and never for the chairman. `converse.mjs` exports `realQueue` so the self-test reuses the one queue loader.

## 0.51.0

### Minor Changes

- df2ead4: `trace -- --aggregate` and `trace -- --map` no longer read GitHub through the search API (30 calls a minute per user, 1,000 results at most), and `trace -- <row-or-pr>` finds a row's pull requests without it too. The merged pull requests of a window come from each repository's pull-requests list, newest update first, read until a page reaches a pull request last updated before the window (a list not finished in 30 pages is refused, naming `--since`, rather than cut short); the pull requests that close a row come from the row's own timeline. The first line a run prints, before its first call, now says what it may spend: at most `--calls` `gh api` calls, all on the REST `core` pool (a reply from any other pool is refused), at least 250 ms apart, and a stop when `X-Ratelimit-Remaining` falls under 500. At that floor a run stops, says "STOPPED AT THE FLOOR" in its footer beside the `X-Ratelimit-Remaining` it saw at its first and last reply, and the weeks that depend on what it did not read are PARTIAL, exactly as when `--calls` is spent; with `--json 1` the line goes to stderr so stdout stays the JSON. Merged pull requests are taken in order of merge, so the rows a report lists (and the first eight of a "and N more" list) no longer depend on the order GitHub happened to return them. The weekly figures of a complete week are unchanged: measured on one store, the old and the new reader print the same 73 non-row-list lines of the complete week and the same current week, and differ only in which rows the truncated row lists show first.

## 0.50.0

### Minor Changes

- 19ba2dd: The trace pages are regenerated after each merge and at least hourly, into one directory a host act then serves privately over Tailscale (a11ign/a11ign#3515, the last slice of #3494). `src/trace/publish.mjs` reads the head of `main` in every code repository the project declares (one `gh api repos/<repo>/branches/main` call each) and regenerates only when one moved since its last stamped publication or the stamp is older than `--max-age-minutes` (default 60); a run that finds neither does nothing and exits 0. It writes `map.html` (`trace -- --map` over the last seven days, `--calls 300`), one `row-<n>.html` swimlane per row closed most recently in the tracker repository (`--recent`, default 6, plus any `--row <n>`) and an `index.html` linking them, into `--out` (default `~/.cache/a11ign/trace-pages`). Every page is rendered into a staging directory and checked to be non-empty before it replaces the served one; a page that fails to render or to write is listed on the index and makes the run exit non-zero WITHOUT writing the stamp, so the unit shows failed and the next tick retries, never a green run over an empty directory. `host/trace-publish.timer.in` runs it every ten minutes (`OnBootSec=2min`, `OnUnitActiveSec=10min`) and `host/trace-publish.service.in` runs it as the workers account; both are installed and started by `host:install`, which makes one run at install (a first publication, or nothing when no head moved). Nothing here opens a port: serving is `tailscale serve --bg <out>`, run by the host's operator.

## 0.49.2

### Patch Changes

- ce3206c: `trace` gives a turn stored before `toolMs` existed its tool time, by moving the ingest state to version 3 (`src/trace/ingest-state.mjs`). A state of another version is already a cold start, so the first run after this release reads every transcript from byte 0 once, and `appendToStore` supersedes each stored turn with the copy that carries `toolMs`; until then a worker's old tool time printed as `unexplained`. Measured 2026-10-05 into a SCRATCH store (never the live one), over the transcripts changed since 2026-09-28 with no wake ledger, gh ledger or deferral log: 1,733 transcripts, 1,339,543,558 bytes read, 21.1 s wall-clock, 702 MB peak RSS, 63,225 events. That is inside the tick; the supersede appends only the turns whose copy differs. The state is trusted again from the run after. a11ign/a11ign#3680.
- b7c2a42: The trace store's `opened` record for a pull request now carries `draft`: `true` when it was OPENED as a draft, `false` when it was opened ready, `null` when this read cannot say (a11ign/a11ign#3670, follow-up of #3511). The pull object's own `draft` is the state NOW, so a draft marked ready later reads `false` there; the timeline's first `ready_for_review` (a draft) or `convert_to_draft` (ready) event says what it was at the opening, and only a pull request with neither takes the pull object's value, `null` when the object has none (never `false` for "not read"). The waterfall's verify phase reads it: with no `ready_for_review` event it prints "opened ready, no draft stage" only for `draft: false` (queued or not), "still a draft" for `true`, says the ready mark is missing for a draft that was queued or merged without one, and keeps saying the store does not know for `null`. An `opened` written before this change has no `draft` and reads as `null`; the store is not re-ingested.

## 0.49.1

### Patch Changes

- 6fca28c: The work gate is ruled to REQUIRE the project's roster (a11ign/a11ign#3675): `work-gate.mjs` loads only where `.agent-org/roles` exists, and refuses naming `roles.dir` where it does not. It imports `arm-pr.mjs` through `auto-arm-sweep.mjs` and `work-gate/org-health.mjs`, and `arm-pr.mjs` reads `sessions.json` at import. The #2174 constraint that it load without the roster is retired, and the two comments that designed around it (`work-gate/pr-owners.mjs`, `work-gate/pr-orders.mjs`) are corrected; no behaviour changes. `src/work-gate-loads-without-roles.test.ts` pins both directions.

## 0.49.0

### Minor Changes

- f98418b: A seat the roster marks `persistent` must be running, and the organisation starts it (a11ign/a11ign#3539). `host:check` names each persistent seat that herdr does not list (`seat <name>: PERSISTENT SEAT NOT RUNNING`, the check's failing exit), and says `persistent seats: UNKNOWN` when the roster or herdr could not be read, never clean. A new first step of the work tick, after `update-tool` and before the gate, starts an absent seat: one workspace labelled with its name in the project checkout, the agent started from the seat's roster brief with `SEAT_START_FLAGS` (`ceo`'s hand-start values for `liaison`, model `sonnet` and effort `medium`, which are a choice and not a measurement), and herdr read back that the seat is listed. A seat that is listed in ANY status gets no write at all, a second reading at the moment of the write confirms it is still absent, a listing without the standing panes starts nothing, and a start herdr refuses closes the workspace it opened and prints `SEAT NOT STARTED` on every tick until it succeeds. The first tick after a release tag moves reads that tag's roster, so a seat a release adds is started by the next tick (at most the tick interval, two minutes plus `AccuracySec`, after the tag moves).

## 0.48.0

### Minor Changes

- 98662ff: `trace -- <row> --html --out <path>` writes the row's swimlane timeline as ONE self-contained HTML file (a11ign/a11ign#3512, slice 5 of #3494): no script, no stylesheet, no image, no font, readable from a file with no network. Time runs left to right on a linear axis; one lane per actor (gate, product-manager, ceo, orchestrator, one per `worker-<n>` and `reviewer-<n>` with something to draw, CI, merge queue) and no other, a turn by a session with no lane being counted in the footer rather than given one. Each turn is a bar coloured by its dollars in five steps up to the dearest turn of the row (a turn with no price is grey and says `$?`, never the cheapest step), labelled with its cost, cause and model in its title and in a table under the picture. Waits are hatched and name what was waited on: an order deferred for a busy seat, a label held, a review not yet posted, and the approved draft not yet marked ready, which is dashed and worded INFERRED with the waterfall's own words and evidence (#3511). An arrow joins each order on the gate lane to the turn it woke. The waterfall's repeats (a second review at a head, a re-queue at a head, a CI re-run, a re-wake with the same order, a compaction) are outlined in red on their bar and listed in words. A number naming several rows writes one file per row. `--html` takes no value and needs `--out`.

## 0.47.6

### Patch Changes

- 12c6e05: `trace --aggregate`'s by-cause table splits each cause's re-delivered repeats into **after a change**, **unchanged** and **unexplained**, with the repeats and dollars of each and a closing row for the class, so the dollars of an order re-sent are visible apart from a row worked a second time (`ready-row-unclaimed` repeats are mostly a spawn that did work). A change is read from the store's GitHub record and never guessed: between the previous delivery of the key and the repeat, a `claimed`, `released`, `labeled` or `unlabeled` event on the row or pull request THE KEY names, or, for a key that carries a head sha, a `head_moved` to a different head. A repeat with no such record is `unchanged`; one whose subject has no GitHub event in the store at all (or whose key names none) is `unexplained` and in neither column. The re-delivered line keeps its definition and its total. a11ign/a11ign#3661, from #3626.

## 0.47.5

### Patch Changes

- e7a18da: `trace` names the time a worker's tool call ran, where it used to print it as `unexplained`. A turn in the store now carries `toolMs` (`src/trace/store.mjs`): from the last block of the message that made a tool call to the call's result record, `null` when the message follows no tool call (an order, a prompt), never 0. `store.mjs` had said a turn's `wallClockMs` includes the tool that preceded it; measured on a real transcript it does not, because the record it is counted from is stamped after the tool finished (five calls of 365-524 s were followed by messages of 3-7 s), so a long `pnpm test` was in no turn's span. The comment and the `DEFINITIONS` entry are corrected. The waterfall (`src/trace/waterfall.mjs`) gives that stretch to a WAITING source, `tool running (<session>, N calls)`, claimed AFTER every recorded wait, so a deferral, a hold, CI or a queue entry that covers the same moment keeps it. On worker-3641's row the build phase reads `WAITING 31m03s + unexplained 18m15s` where it read `WAITING 0s + unexplained 49m18s`. **A turn already in the store has no `toolMs` and claims nothing**: the field reaches it only when its transcript is read again, because the store supersedes a stored turn with a differing copy. a11ign/a11ign#3669.

## 0.47.4

### Patch Changes

- 382e0bb: A review tree gets each package's own `node_modules`, so `tsc -p packages/cli` (and `pnpm run build`) resolves a registry-installed `@a11ign/*` dependency there. pnpm puts a package's own dependencies under `packages/<dir>/node_modules`, not at the root, and `linkReviewDependencies` linked the root's only: in a review tree the build died at `TS2307: Cannot find module '@a11ign/documents'`. Every package of the tick's checkout that has a `node_modules` now gives its same-named package of the tree one, with the same entry names: a third-party entry and a registry `@a11ign/*` entry link to the tick's store, a workspace entry links to THIS tree's package of that name (a link to the tick's own would make the tree measure `main`), a scope directory is made real and linked child by child, and `.bin` is not linked (a package's `.bin` holds the shims of its own workspace bins, which run the tick's source). A package the tick has no `node_modules` for gets none, a package the pull request removed or renamed is skipped, a `node_modules` that is itself a link is replaced and never written through, and running it again changes nothing. What an earlier head linked and this one does not is removed on the next re-point (a dependency the pull request dropped from a package, a workspace package it removed or renamed, the `node_modules` of a package that no longer has a counterpart in the tick's checkout), so a re-pointed tree never resolves a dependency its head does not declare. No action to take: a host picks it up with the release and the next re-point of a review tree links the missing directories.

## 0.47.3

### Patch Changes

- c0b5f13: The gate reads each code repository's open pull-request list 20 at a time and asks again at 100 only when the first page came back full. A GraphQL request is priced by the page it asks for times the nested connections each pull request carries, so the same query costs 7 points at 100 and 1 at 20 (measured by replaying what `gh` sends with `rateLimit { cost }`). The gate asked for 100 of each of six repositories every two minutes, for lists holding 0 or 1 pull request: 42 of the 49 points its 13 `pr list` calls cost per run, now 6 of 13. The answer is the same list: a page with room left is the whole list, a full one is read again at 100, and a refused second read is `null`, never the first page standing in. `GH_READS` states the three `pr list` reads per non-primary repository. a11ign/a11ign#3674.

## 0.47.2

### Patch Changes

- 286f901: `trace` and `trace --aggregate` price every stored turn from `PRICES` as it stands when they READ it (`repriceEvents`, `src/trace/store.mjs`), not from the `costUsd` the line carried when it was ingested. The store is append-only and an unchanged transcript is not read again, so a price added later (the Sonnet 5 and Opus 5 rows, a11ign/a11ign#3582) never reached the turns stored before it: 147,675 turns kept `costUsd: null` and two weeks of the aggregate printed no dollars. A model with no price (the Codex model, `<synthetic>`) stays `null` and its row stays a floor; the stored lines are not rewritten. The waterfalls, `--map` and `--wake-cache` read the same repriced events. a11ign/a11ign#3638.

## 0.47.1

### Patch Changes

- 1b2bc80: Seven packaging test files pass from a clean checkout of this repository, not only from inside the project's layout (a11ign/a11ign#3671, follow-up of #3511). Measured at `f52921a` with `AGENT_ORG_HOST` set, `node --import tsx --test` over the seven files: 314 tests, 295 pass, 19 fail; after, 327 tests, 327 pass, 0 fail (the 13 more are `tracker-leak-refusal.test.ts`, which failed as a whole at import and now runs its 14). The same seven files run laid out the way CI lays the tool into the project (`packages/agent-org/`, the project's `packaging/` siblings copied beside them, `AGENT_ORG_HOST` unset): 327 and 0. The whole suite on this branch: 6077 tests, 0 fail, 1 skipped (the `codex` one, which skips itself).
  
  Each failure was a test that took the project's directory layout for its own, and none is skipped or moved: the count of tests that now run only in the project is zero.
  
  - `closes-mismatch-check.test.ts` (7): the CLI harness named `packages/agent-org/src/closes-mismatch-check.mjs` from the working directory; it resolves the script from the test file.
  - `stranded-branches.test.ts` (2): `fixtures/open-prs-lifetime.json` was never committed here; it is, byte-identical to the project's copy (and to the one on the unmerged `agent/agent-org-gate-exclusions-3002` branch).
  - `row-file.test.ts` (5): the four `#2035` closure-warning tests and `#1193 clause 4` read `packages/lab/...`, `packages/agent-org/...` and `docs/adr/` from the working directory. They now run inside a throwaway git repository holding exactly the files they name (`inScratchProject`), so they no longer pass or fail on the project's contents.
  - `reconstitution-drill.test.ts` (2): the drill ran against `process.cwd()`; it runs against `HOME_CHECKOUT`, the project the tool serves, which is the same directory in the project's layout.
  - `acceptance-exit-code.test.ts` (1): `npm test` is read from the working directory's `package.json`, and this checkout has no `test` script. The test builds a project whose `test` glob holds one test that needs a token (an empty suite needs nothing and is not refused). It also declares `// no-token: gh`, proved by a run with no token and a fake `gh` first on `PATH` that was never called (23 pass): the file imports `pr-open.mjs`, so without the declaration the capability gate refused every Acceptance that runs it, the row's own included.
  - `board-snapshot-scope.test.ts` (1): the file path and `board-snapshot.mjs` were typed from the project's root; they are resolved from the test file. The first assertion, that this file's closure needs no token, had been passing on a path that names no file, which the walk answers with `[]`.
  - `tracker-leak-refusal.test.ts` (the file): it imported `./leak-patterns.mjs`, which this checkout does not have; it imports `../lib/leak-patterns.mjs` and iterates `leakPatterns()`. The mutation test, which spliced the product's `LEAK_PATTERNS` array empty, empties the two sources the tool splits it into (the generic list's entries and the declaration's list) and puts them back; it now also asserts the list it loops over is not empty.
  
  Mutation checks, each restored byte-identical: with the closure warning never firing, five `row-file` tests fail, and with every Region file reading as unread, three fail (including the no-warning direction); with the scratch project's corpus entry deleted, three fail; with `board-snapshot.mjs`'s `gh` call removed, or with `board-snapshot-scope.test.ts` importing it, the positive control fails alone; with the scratch suite's token test deleted, or `checkBody` gone, `acceptance-exit-code.test.ts` fails alone, and with a `gh(` call added to it the walk refuses its `no-token` declaration; with `leakRefusalReason` never refusing, nine fail, and always refusing, ten; with the neutering left out of the emptied-patterns test, that test fails alone. No production file changed.

## 0.47.0

### Minor Changes

- c682cd8: `agent-org trace -- <row>` prints the row's waterfall above its events (a11ign/a11ign#3511, slice 4 of #3494): eight phases (spec, claim, build, verify, review, CI, queue, merge), each with its wall-clock split into WORKING (the union of the turns' spans), WAITING (a record, named: a deferral span, a hold label, an order delivered after it was typed, a merge-queue entry or ejection, CI running, a review not yet posted) and `unexplained` (a gap with no record, never folded into WORKING), with tokens and dollars per phase and per session. A phase with a start and no end prints OPEN and is read to the time of the reading; one never ended before the row closed is CUT at the close; one with no start record says `not held`. The phases overlap, so each also prints an EXCLUSIVE time (each moment in the latest-started phase running at it), which adds up to the row's wall-clock, as do the dollars of the turns that ended in each phase. Dollars are the store's own `costUsd` and a turn with a `null` cost is counted unpriced, never as zero. One wait is INFERRED and marked so: a draft approved and not yet marked ready is named, from the review, the order delivered about it and that session's turns in the gap, as waiting on whoever the order went to (measured on a11ign/a11ign#3406: 2h13m39s from the approval to the ready mark, waiting on the orchestrator). Every repeat is flagged in the phase it happened in with its evidence: a second review at the same head (both review ids), a re-queue at the same head (both queue entries), a re-wake with the same cause key, a CI re-run at the same head (a check of a later wave whose name already ran at it; two triggers of one check overlapping are not a re-run, measured on #3406), and a compaction. `trace --aggregate` gains, per week, each phase's share of the merged rows' wall-clock and dollars, and for each of the ten dearest rows the phase that cost most and the phase with the most wall-clock to itself; a share table whose parts do not add up to the whole throws instead of printing, and a row with no GitHub record in the store is counted apart and is in no share. `--json` carries the waterfalls.

## 0.46.2

### Patch Changes

- 1a87ef4: A run that had to wait for a suite slot leaves a record that outlives it (a11ign/a11ign#3664, found reading #3608). `src/suite-slots.mjs` printed `all N slots ... are held; waiting for one` to the waiter's own stderr and kept nothing, so nobody could read afterwards whether a third contender ever queued. When a waiting run gets its slot it now appends ONE tab-separated line to `waits.log` in the slot directory (`~/.cache/agent-org/suite-slots/waits.log`): ISO time, waiter pid, cwd, milliseconds waited, slot, label. A run that took a free slot first time writes nothing; a record that cannot be written is said on stderr and the suite still runs. A waiter killed while still waiting writes nothing (the line is written on acquire). Three cases are pinned in `suite-slots.test.ts`: three contenders against two slots find exactly one record, naming the third; one contender, and two against two, find none.
- b6bc9f6: An order that asks nothing of a lead seat never wakes or clears it (a11ign/a11ign#3562, chairman's order of 2026-10-04). An order with no declared decision (`--fyi`, or no flag, which already read as FYI) to `ceo`, `product-manager`, `orchestrator` or `liaison` is now QUEUED by `prompt:session` even when the seat is idle, with a `HELD` line saying so; the tick holds it, lets it ride in the seat's next real order (a declared decision's batch, or a gate order addressed to that seat, as a trailing `WAITING FOR YOUR NEXT ORDER` section) and retires it only when that delivery is recorded. One past `FYI_STALE_MS` (4 h, an unmeasured starting constant) is dropped with a `DROPPED FYI` line, on a quiet tick too, and a held FYI is not counted in the backlog the tick reports or the stall orders it raises. A lead seat is a roster role that is not an engineer (`isLeadSeat`): a `reviewer-<n>` or a spawned engineer still gets an undeclared order at once, because that is the re-review request. `recordDirectDelivery` now records `decision` so a later reading can tell a wake an FYI caused from one a decision did. Three existing tests that sent an undeclared order to a lead seat and expected delivery now declare it a decision. The cleared first-turn cache write does NOT fall because of this (it is 35% the auto-memory index, measured; a11ign/a11ign#3663).

## 0.46.1

### Patch Changes

- 77cd374: `declaredGhAccount` answers UNKNOWN, naming the wrapper's refusal, for a call with neither `HERDR_WORKSPACE_ID` nor `GH_CONFIG_DIR` (a11ign/a11ign#3665). Since #3642 the `gh` wrapper refuses that call, but STEP 3 still read `~/.config/gh` and returned the human account, so `work-gate.mjs` named the human for a call the wrapper will not make. The workers README that `host:install` writes no longer says "only a shell with no workspace id is a person and uses the default config"; it says that call is refused and a shell outside a workspace must export `GH_CONFIG_DIR`. Both are pinned by a test that fails on the old text.

## 0.46.0

### Minor Changes

- 7fb6b10: `src/ci-health-liveness.mjs` answers whether a project's weekly CI-health report arrived, as a gate question rather than a sentence (a11ign/a11ign#3659, #3212's done-when 4): did a `schedule` run of the declared workflow start for the latest cron slot, and is its `## CI health, week of <date>` comment on the report issue. Five verdicts, and only `PRESENT` is a pass: `NOT YET` (the slot plus a 6-hour grace has not passed, the grace being #965's recorded five-hour scheduler lateness with an hour over), `SILENT` (grace passed and no `schedule` run; a comment posted by a dispatch does not stand in, and the workflow's `state` is printed beside it because GitHub disables a schedule after 60 days without activity), `NO COMMENT` (a `schedule` run, no comment) and `CANNOT TELL` (a lookup failed, or the workflow's cron is not one plain `m h * * d`: never read as healthy, and no order is raised for it). The heading is the run's own UTC day minus seven, which is how `scripts/ci-health.mjs` writes it (the Monday 2026-10-05 run posts `week of 2026-09-28`), and a test pins the rule against that script's text. The slot is read from the workflow file's cron, and the repository, workflow and report issue come from the project's declaration (`tracker[0].repo`, `units.ciHealthWorkflow`, `units.ciHealthIssue`), or from `--repo`, `--workflow` and `--issue` together; an undeclared project reads `CANNOT TELL` naming the missing field, so nothing is defaulted. `ciHealthOrders` returns the gate's order shape for `SILENT` and `NO COMMENT` only, to `product-manager`, keyed on slot and verdict. The wiring into `work-gate.mjs`'s `decide` (beside `rowOffBoardOrders`) and the project's declaration are not part of this release.

## 0.45.0

### Minor Changes

- 3d4759b: `host:check` now fails on two more ways the agents host can act as a person. (a) A shipped `.service` that declares no `Environment=GH_CONFIG_DIR=...` is a `NO IDENTITY DECLARED` finding whether or not a `gh` spawn is reachable from it: reach analysis says what a unit spends today, not what it is one `pnpm run` away from spending, and the `gh` wrapper sends a unit with no declaration to `~/.config/gh`. (b) A login in `~/.config/gh/hosts.yml` that is not one of the two org accounts' (read from `<workers>/gh` and `<leads>/gh`, never a literal name) is a `HUMAN LOGIN ON THE HOST` finding; a missing file passes and an unreadable one is a `HOST GH LOGIN UNREADABLE` finding, never "clean". Both remedies name the two account directories; (a)'s says `pnpm run host:install`, (b)'s is a manual `gh auth logout` because `host:install` writes no line of a person's config. A project whose units are fixtures passes `readGhHosts` to pin the second check. a11ign/a11ign#3643.

### Patch Changes

- ecdb3a5: `answer-owed` is an `ACTION` cause, not a `JUDGMENT` one (a11ign/a11ign#3652). A delivery held its causeKey for two hours even when the `answer:<session>` label had been removed and applied again, and the key carries no label time, so a question labelled inside that window never woke the session it named (`product-manager/answer-owed/row-3566`, four deliveries two hours apart and none at a label time). It now takes the documented twenty-minute cadence. A label that stands unanswered is offered every twenty minutes and trips `MAX_DELIVERIES` about two hours in.

## 0.44.0

### Minor Changes

- 75bde8d: `org-health` reads each org team's level on every repository it reaches and trips `team-access-drifted` when a team holds `admin` anywhere, or a level other than the declared one on a declared repository (a11ign/a11ign#3634, the class gap of #3587: the `bots` team held `admin` on two repositories and no tick read it). A project opts in with `teamAccess.declaration` in `.agent-org/project.json`, a path inside the project to a file whose `teams.<slug>.layer` gives each team's level and whose `repositories` keys name the declared repositories (their common owner is the org); a project with no such key makes no call and gets no reading. The read is one paginated `orgs/<org>/teams/<slug>/repos` call per declared team on the core pool each tick (30 an hour per team at the 2-minute tick, 0.6% of 5,000), and the discriminator names `team:repository`, so a second repository is a new trip. A read that cannot run is `unknown` with its reason and never clear: a 404 (a token that cannot see the team), an empty listing, a partial line, an unreadable declaration and a malformed `teamAccess` key each say CANNOT_TELL.
- c36f02f: The `gh` wrapper (`host/gh`) refuses a call that has no `HERDR_WORKSPACE_ID` and no `GH_CONFIG_DIR` (a11ign/a11ign#3642), instead of falling through to the human's own `~/.config/gh`. Rule 5 was written for a person at a terminal, but a plain ssh shell and a unit that declares no `GH_CONFIG_DIR` look identical to that person, and both acted as the org owner with admin (one spent his search limit). The refusal exits non-zero before `gh-real` and before the call ledger, prints one line (`git push` shows its credential helper's stderr) naming both bot config dirs, and says to `export GH_CONFIG_DIR=...` or run in a workspace; the explicit-`GH_CONFIG_DIR` and workspace routes are unchanged. **A host that installs this wrapper must have every unit declare `GH_CONFIG_DIR` first**, or that unit goes from acting as the human to failing; `host:install` copies the wrapper, so installing it is the host operator's act.

## 0.43.1

### Patch Changes

- d246d50: The reviewer door (`src/reviewer/pr-review-verdict.sh`) no longer attaches a verdict to a commit it was not written at (a11ign/agent-org#3640, found on a11ign#3623). `gh pr review` has no commit option and posts to whatever the head is when it runs, so a review headed at `61389c15` and submitted after the author pushed was recorded on `0af5fe4a`, a different patch, and satisfied `reviewDecision` for a changeset its text did not describe. The door now reads the commit the opener names (the sha after `at`, in backticks, the spelling the gate already reads; an abbreviation resolves) and compares it with the head at post time: the same commit, or an earlier one with an equal patch id (a merge of `main`), posts; a different patch is refused with a new exit code, `5`, that names the head to review, and a verdict line that names no commit exits `2` before any `gh` call. A diff that will not read is exit `4`, could not tell, never "unchanged". The second-review refusal (exit `3`) now reads each review at the commit its body names, falling back to `commit_id` only when the body names none, so a review headed at an old commit but attached to the new head no longer blocks a fresh review of that head. The gate's own reading (`review-verdict.mjs`) already keys a verdict on the sha its body names and needed no change. A reviewer whose verdict line names the head they read sees no difference.

## 0.43.0

### Minor Changes

- 79427ba: Removing `answer:<session>` from a claimed row now orders the claimant once, with the answer (`answer-given`, a11ign/a11ign#3632). The gate had a cause for the ANSWERER while the label stood (`answer-owed`) and none for the ASKER when it came off, so an answered claimant that had gone idle waited for `claim-stalled`'s next nudge, up to 120 minutes: `#3566` sat 44 minutes past its answer and tripped `overdue` as `idle-no-wait`, and `ceo` sent `#3566`, `#3385` and `#3573` one `prompt:session` each by hand. The order names the label removed, the account that removed it and the newest comment by that account at or before the removal, by id. It is keyed on the removal's time, so one answer is one order and a label re-applied and removed again is a second; it is read only from a claimed row updated in the last 90 minutes (`ANSWER_GIVEN_WINDOW_MS`, under `JUDGMENT_TTL_MS` so the ledger cannot resend it), from the row's own timeline, whose projection now also carries `unlabeled` events, the writing account and a comment's id. No order goes to a row with no claimant, to a claimant herdr says is not live, for a label named for the claimant itself, for a removal from before the claimant took the row, or for a label put back; a closed row is never read. A new cause, so a project that pins its cause list takes `answer-given`.

## 0.42.0

### Minor Changes

- 7acedc8: The gate keeps each deferral that ENDED in a durable log, `wake-deferral-log` beside `wake-deferred`, one line `<causeKey>\t<startMs>\t<endMs>\t<delivered|gone>` appended by the tick that found the order no longer deferred, and the trace store reads it as `kind: deferral` (`source: deferral-log`), keyed to the cause key's row or pull request and ingested incrementally through the ingest state: `trace` prints each wait's span and its footer names the waits before the log's first tick as unrecorded (a11ign/a11ign#3510, slice 3 of #3494)

## 0.41.0

### Minor Changes

- 9d3bf99: The weekly token-efficiency report is posted on the project's record issue every Monday at 07:30 London, by a timer (a11ign/a11ign#3627): `host/trace-weekly.timer.in` (`OnCalendar=Mon *-*-* 07:30:00 Europe/London`, `Persistent=true`, after the 07:10 board edition so the two do not share the work tick's API minute), `host/trace-weekly.service.in` and `host/trace-weekly-post.sh`, installed by `host:install` like the board dispatcher's pair and not started by it (no `Requires=`: a start at install would post a report). The script runs `agent-org trace -- --aggregate` in passes of at most 1,500 `gh api` calls until nothing is unread, a pass reads no more than the one before, six passes have run, or the core pool is down to a 1,000-call reserve (the work tick spends the same account's pool), reading the pool off a real call's `X-Ratelimit-*` headers; it asks for the Monday two weeks before the current one, because the four-week default holds more merged pull requests than GitHub's search returns (measured 2026-10-05: more than 1,000 on `a11ign/a11ign`) and `trace` refuses a list cut short. It posts under a one-line header carrying the week reported (the one before the week in progress) and `COMPLETE` or `PARTIAL (<why, as the report prints it>)`, with the passes run and what stopped them; a report over the 65,536-character comment limit is split into numbered comments and never truncated. **A project must declare the issue**: `units.traceWeeklyIssue`, a positive integer, beside `units.boardReportWorkflow`; the repository is `tracker[0].repo`. A missing or malformed declaration, a `trace` that exits non-zero, a footer the script cannot read, a pool it cannot read and a comment GitHub refuses each leave the script non-zero, so the unit shows failed and is never green with nothing posted.

## 0.40.0

### Minor Changes

- 20030cc: `pr:open` labels a new pull request with its owner when the tree carries no `.a11y-owner` stamp (a11ign/a11ign#3639). agent-org's trees are made by hand with `git worktree add` and nobody stamps them (5 of 207 on the agent host, 2026-10-05), so three of the four open pull requests that day had no `session:` label and a red one could not be routed to anyone. The owner is now read from the row the pull request names (its `Closes` line, or an `owner/repo#N` in its title): exactly one `session:` label across the named rows labels the pull request, and no row, a row with no `session:` label, or rows naming two different sessions leaves it unlabelled as before. A stamped tree is unchanged and never reads a row. The label is also created in the repository when GitHub says it is absent, since `gh pr edit --add-label` of a label that does not exist is "not found"; a failure to read the row, to look the label up or to create it is printed, never swallowed.

## 0.39.2

### Patch Changes

- aa7d91b: An `answer:<session>` label is called unexplained (`answer-label-unexplained`) only once it has stood `ANSWER_LABEL_GRACE_MS` (5 minutes) with no comment after it (a11ign/a11ign#3618). A session that labels first and comments second was ordered to "post the question" while it was typing it: on #3566 the label was set 06:32:28Z, the order to the labeller went out 06:34:23Z and the question was posted 06:34:30Z, and the same race hit `worker-3543` and `worker-3573`. `bareAnswerLabel` takes the caller's clock (`nowMs`, default `Date.now()`) and returns `null` for a younger label; `bareAnswerLabelOrders` passes the gate's own. A label past the window with no comment is called exactly as before, and a comment at or after the label still answers it.

## 0.39.1

### Patch Changes

- 10d6d86: `instanceCacheRead` (the wake's read of an instance's context size, once per order delivered) no longer parses every transcript on the host. It reads transcripts newest first and stops at the first that names the session, which is the one that already won ("the most recently written transcript naming it"), and it skips a file whose first 64 KB already names another session without reading the rest. A head that names nothing, or cannot be read, still falls through to the whole-file read, so no answer changes. Measured: one call read 3.3 GB across 4,256 transcripts, 22.5 s wall and 23 s CPU, 554 MB RSS. a11ign/a11ign#3566, slice 6 of the tick's cost: the `wake` phase.

## 0.39.0

### Minor Changes

- 9133599: `trace -- --aggregate` prints, under the re-delivered line of each week, the re-delivered orders BY GATE CAUSE (a11ign/a11ign#3626): the repeats of each cause, its distinct keys, the median gap between a repeat and the previous delivery of its key, and dollars (a floor, `not derivable` when every turn is unpriced), most repeats first, in the same week as the class and adding up to it. A repeat whose key carries `@deferred` is the same order re-sent after a deferral and is its own row (`<cause> @deferred`), since a deferral retry and a wake delivered anyway are different defects. A week with no repeats prints no table, and `--json 1` carries the rows as `causes` on the class.

## 0.38.1

### Patch Changes

- e391102: The gate asks a reviewer for a pull request that is red only on a check `main` does not require (a11ign/a11ign#3597). `reviewableHead` and `reviewWait` read every check on the head, while `failingChecksOrder` reads the required set, so a pull request green on `gate` and red on `typecheck` was nobody's work: it earned no `draft-awaiting-verdict`, no `reviewer-agent-org-<n>` was started, and agent-org#211, #212 and #213 each waited for a review nobody had been sent for. Both now take the required list `draftOrder` already holds and read only the required checks for red and for running, and `withPatchIds` takes the same list, so the patch is read for the pull request the question is open for. A required check that is red is still `pr-checks-failing` and not a review's question; a required check still running is still `running`; a check outside the required set that is still running no longer holds the question. An unreadable required list counts every check, as before. The tick reads the list only when some check is red or a draft is green, so a head whose only open check is a non-required one still running, with nothing red anywhere, is still read as `running` until it settles. A project takes this with the next release; nothing to change.

## 0.38.0

### Minor Changes

- 2101793: A physical or account ask is WALKED THROUGH, one step at a time (a11ign/a11ign#3425, C2 of #3409, chairman point 3). A brief for the chairman with a `Steps:` list (numbered items, each optionally followed by `Verify: {{placeholder}} is|contains <value>`) is sent as ONE step: the brief and step 1 under Done / Stuck / Explain more, never the later steps. On Done the step's `Verify:` is READ through the checked-facts vocabulary (`walk.mjs`, one read, the words built from it and stamped `as of`), and only a read that shows it sends the next step; a read that shows something else, or cannot be made, says plainly that it cannot see it, does not advance, and offers Done again, Stuck and Later. A step with no `Verify:` is confirmed on Done alone and says "I can't check that one from here". Stuck orders the liaison once per step. After the last verified step the request is answered on its row through the answers path (comment, `needs:chairman` removed, `answer:ceo` set) and the closing message carries the brief's `Unblocks:` line. State is the ledger: one `direction: "walk"` line per step transition keyed `walk:<request key>` (`confirmed`, `unseen`, `shown`), so a restart resumes at the right step and a repeated Done writes once. A typed reply under a walk is conversation and never the answer. A listener built without readers (or with no readable tracker, which is logged) refuses a procedure and writes nothing; every other request is answered as before. A brief with both `Steps:` and an options block, or an unreadable list, sends no alert and says why (`alert not sent: steps: ...`). `Answered` replies may carry `actions` and `recordSent`, which `createForwarder` passes on, so a reply can be a message with buttons whose ref the ledger learns.

## 0.37.1

### Patch Changes

- 561bbf2: `row-claim claim` asks GitHub for the row's `body` and its `blockedBy` edge once each, not twice. The template check and B4's Region lookup both read the body, and the claim's own check and B2/B4's both read the edge; the checks before the first write now share one `gh issue view`/`list` per distinct read. The labels are still read fresh before the checks, before the write and after it, a read that fails is retried, and no check or refusal changes. Measured against a live row through a proxy `gh` (writes faked): 16 reads before, 14 after. a11ign/a11ign#3566, slice 5 of the tick's cost.

## 0.37.0

### Minor Changes

- 0dc65b2: The tool no longer carries a test selector (a11ign/a11ign#3573). `agent-org select-changed-tests` is removed from the command table with its `src/lib/select-changed-tests.mjs`, and the declared copy of `ci-changed.mjs` loses its test-selection half (`testPackages`, `dependentsOf`, `readWorkspaceDependencyGraph`; `classify` now takes `(files, packages, { repoRoot, getPackedFiles })`), because the product's PR `ts` job runs the whole suite and `rstest run --changed` is the one selector left. Job gating is unchanged. `src/lib/walk-scope-discovery.mjs` is a new declared copy of the product's `packages/guards/src/walk-scope-discovery.mjs` (`packageIndex`, `sourceClosure`), which `walk-scope.mjs` now imports in place of the deleted selector. A project that still calls `agent-org select-changed-tests` must stop before taking this release.

## 0.36.0

### Minor Changes

- 9b68243: A tick that runs over `TICK_SLOW_SECONDS` (180) or is killed by the timeout now tells `ceo` (a11ign/a11ign#3567). The slow one reports in its own tick, from its `tick-cost` line: wall (with `ExecStartPre`, which `TimeoutStartSec` also counts), CPU and the phase that took longest. The killed one is read by the NEXT tick: every tick writes `tick-running.json` beside the ledger and clears it whenever its process ends by itself, a crash included, so a marker still standing was left by a signalled process and is reported once with its start time and the most it can have run. One new cause, `tick-overran`, keyed per tick start. Known gap: a kill during `ExecStartPre` happens before the marker exists. `src/work-tick-health.mjs` is new.

## 0.35.2

### Patch Changes

- 16f9f10: The tick's spawn census reads each synchronous spawn's CPU, and the `tick-cost` line carries `hottest`: the 5 command lines that used the most CPU, beside `slowest`'s 5 by wall. A spawn's `cpuMs` is the move in the tick's `cutime + cstime` while it was blocked, so it includes the child's own children; `null` when `/proc` cannot be read. `childrenCpuMs` moves to `lib/spawn-census.mjs` (the tick re-exports it). It exists because the `wake` phase of a waking tick is 15 to 55 s of CPU and nothing yet says whose. a11ign/a11ign#3566, slice 4 (the profile first).

## 0.35.1

### Patch Changes

- fe24f07: The trace store prices turns of `claude-sonnet-5` and `claude-opus-5` (a11ign/a11ign#3582). `PRICES` matched by `startsWith` and its prefixes began at `claude-sonnet-5-5` and `claude-opus-5-5`, so the older ids matched none and every such turn had `costUsd: null`: 97% of two weeks' turns on the private store. The new rows are the published rates ($2 / $10 and $5 / $25 per million tokens, cache reads $0.20 and $0.50), marked `verified: false` because neither was reproduced against Claude Code's own `cost_usd`, and they stand after the `-5-5` rows because the first matching prefix wins. A Codex model still has no row: no rate for it is sourced, so its turns stay `null` rather than carry an invented figure.

## 0.35.0

### Minor Changes

- 28cb82d: `trace -- --wake-cache` prints the cache write of the first turn after each wake, per standing seat (a11ign/a11ign#3563). Each wake's window is classed kept, compacted or cleared, and its gap since the seat's previous turn is classed up to 5 minutes, up to an hour or over an hour, so the two candidate causes of a re-wake's ~30k-token cache write (the window emptied, or the cache's lifetime lapsed) read as separate figures. What a wake did to the window is derived, not read (`last-order/` holds the last order's time only): a compaction between the turns is `compacted`, a new transcript file (a /clear starts one) is `cleared`, the same file is `kept`. A class no wake could be placed in prints `not derivable` and never 0; a Codex reviewer's request, which has no cache-write field, is counted apart; every definition is printed once at the top. `src/trace/wake-cache.mjs` is new.

## 0.34.1

### Patch Changes

- aaf41fd: The gate reads each other repository's open pull-request list once a tick, not twice. `readOtherScopes` read it for the lanes and `readElsewherePrs` read it again for the claim-stall facts; the second now takes the first's list (a refusal stays a refusal). Measured by the census: 5 of 53 `gh` calls, about 4.6 s of a 34 s gate. The tick-cost line also carries `ghRepos`, the `gh` reads and their wall per repository, and a census record names the `GH_REPO` a `gh` call was aimed at. a11ign/a11ign#3566, slice 2 of the tick's cost.

## 0.34.0

### Minor Changes

- c8c134b: `agent-org trace -- --map --out <path> [--repo <r>] [--week <n>] [--cause <c>]` writes the across-rows process map as one self-contained HTML file (a11ign/a11ign#3514, slice 7 of #3494): a directly-follows graph of the chairman's ten phases (filed, boarded, claimed, build, verify, PR, review, CI, queue, merged) over the rows merged in the window, with an edge per step and the number of rows that took it as its width, each node's median wait and median dollars (the colour darkens with the dollars), and the three loops that are the waste drawn red and dashed with their counts and dollars: review -> rework -> review, queue -> eject -> queue and wake -> compaction. Everything on the drawing is also in a table beneath it, and a list of the repos, weeks and wake causes the window holds says what can be asked for. `--repo` keeps the rows whose last merging pull request is in that repository, `--week` the rows merged in one Monday-first UTC week (`2026-W40`, `40` for that week of this year, or any day in it), and `--cause` the rows with a wake of that cause, so a week before a fix and a week after can be set side by side. The page has no script, no stylesheet link and no URL. `boarded` is drawn as `not held` with no edge and no figure, because the store keeps no event for it (a board status change is a GraphQL project field and the store is REST only); `build` and `verify` are inferred from commit dates and named so on the page. `--since` for the map is the start of the merge window and is not rounded to a Monday, so a map of the last 7 days is one. `trace --aggregate` is unchanged: its ingest and listing now run in a function it shares with `--map`.

## 0.33.2

### Patch Changes

- 2b7cfe4: `callerScript` names the unit behind a preload and a session's shell for what it is (a11ign/a11ign#3590). It took the FIRST `*.mjs` in the caller's command line, so a unit started as `node --import file:///.../crash-exit.mjs /.../work-gate.mjs` or `node --import=./src/lib/crash-exit.mjs src/work-tick.mjs` read `crash-exit.mjs` (2,756 of one host ledger's 7,510 calls), and a session's `zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-<ms>-<id>.sh` read as its snapshot file, one name per Claude Code process. `callerScript` now skips `--import <module>` and `--import=<module>` and names the shell `(a session's shell)` (exported as `SESSION_SHELL`), so `topCallers` and the trace ingest agree; the two lines `src/trace/gh-calls.mjs` kept to work round this are deleted.

## 0.33.1

### Patch Changes

- d9dcc71: An order is never sent to a seat the same tick released, and herdr is asked about a gone seat once (a11ign/a11ign#3568). The tick of 2026-10-04T21:49Z released row #2702's claim, which closed `worker-2702`'s workspace, and then delivered three orders to it from the roster it had read before: seven `agent_not_found` lines, six `UNDELIVERED`, and #3536 offered to a dead seat. `performRelease` now reports `gone` when it closed the workspace, and `deliver` takes `goneSeats` (label to reason, returned by `deliver` and `deliverHandoffs` so the tick's second delivery inherits it): such a seat is not in the roster the router reads, so a pool order (`ready-row-unclaimed`) goes to a free engineer, an order a cause declares `mayRelane` goes to one through `relaneTarget` with no age bound, a derived cause is DROPPED with a `DROPPED` line (the gate derives it again from the row), and an authored order is left in the queue with a `LEFT QUEUED` line; none counts as `nowhere to go`. A refusal that says `agent_not_found` adds the seat to the same map, so one refusal per seat per tick is the most herdr is asked. A seat that dies between the roster read and the prompt still costs that one refusal.

## 0.33.0

### Minor Changes

- 1046e66: The `gh` call ledger names the session that made each call, and the trace keys a call by it (a11ign/a11ign#3589, the exact key under #3516's weak one). `host/gh` appends `CLAUDE_CODE_SESSION_ID` (a Codex session's `CODEX_THREAD_ID` when that is what is set; `-` when neither is, as in a unit) as a NINTH field after the caller. It goes last so that a line written before this one, with 8 fields, is read unchanged: `parseLine` returns the same entry it always did, with no `sessionId` key, and a 9-field line is that entry plus `sessionId`. Only `[A-Za-z0-9-]` survive into the field, so an odd value cannot add or remove a tab.
  
  A turn now carries `transcript`, the file name of the transcript it was read from (a Claude session's `CLAUDE_CODE_SESSION_ID` is its transcript's name; a Codex turn's is the uuid ending its rollout's file name, which `CODEX_THREAD_ID` holds: read in `~/.codex/sessions` rollouts, where the value a tool shell printed is the id in the rollout's own file name). `trace/gh-calls.mjs` keys a call to the session whose transcript has that name and, through that session's NEXT turn (the first that ended in a later second than the call's, so never the turn that issued it), to its row: exact, however many sessions were waiting on a tool at its second. The time rule (`toolWindows`, `keyCalls`, `viaShell`, `ambiguous`, `candidates`) is deleted; it keyed 27 of 11,751 calls on this host (a11ign/agent-org#209). A line with no id is `unkeyed: script` and is never joined by time; a line naming a session with no later turn in the store is `unkeyed: no-turn` and is asked again on every run.
  
  **What this does not do yet.** `host/gh` is installed by `host:install`, which is not run here, so until it is every NEW line is still an 8-field one and is `script`; and a turn already in the store has no `transcript`, so a call can be keyed only to a turn read after this version (a store record the time rule left `ambiguous` or `no-turn` is corrected once to `script`). Both age out as the ledgers (2 MiB, newest half kept) and the store turn over.

## 0.32.0

### Minor Changes

- f176091: A host-wide limit on concurrent full test suites, and a chairman message that no longer waits for the tick (a11ign/a11ign#3536, the chairman's urgent order of 2026-10-04). **`src/suite-slots.mjs`**: a full suite takes one of 2 `flock` slots under `~/.cache/agent-org/suite-slots/` (`SLOT_COUNT`, the one place the number is written) and the rest queue; the wait prints at the start and every minute which slots are held, by what and for how long, and a holder that dies frees its slot with no clean-up. Every suite runs under `nice -n 15 ionice -c 3` (`NICE_LEVEL`, `IONICE_CLASS`). A missing `flock`, `nice` or `ionice` is a refusal naming it, never a silent run without the limit; a run with `CI` set takes no slot and is not reniced. Two entry points: `node src/suite-slots.mjs suite` runs the full agent-org suite (it had no single command), and `runUnderSlot` is what a11y-witness's `pnpm run verify` calls on itself, so the whole run holds one slot. A project takes the change by nothing at all for CI, and by running `verify` from a checkout of this repository that has the module. **`converse.mjs`** calls `prompt:session`'s `promptOrQueue` instead of `queueOrLose` alone: a chairman message (or button order) for an idle liaison, or for `ceo` when the liaison's seat refuses, is prompted at once and queues only for a busy seat; the recipient is still the two constants, and the ledger line carries `delivery: "delivered" | "queued"` (`verdict` keeps its words, and a direct delivery has no `handoff`). The `QueuePort` a test supplies now has `promptOrQueue`, `run` and `NOT_QUEUED_PREFIX` where it had `queueOrLose`.

## 0.31.0

### Minor Changes

- c341d1a: The trace store holds every `gh` call, as one `source: "gh-ledger"` record each (`trace/gh-calls.mjs`, a11ign/a11ign#3516, slice of #3494), read from the `gh-calls.tsv` ledgers `host/gh` writes in each account's config directory (`~/workers/gh`, `~/leads/gh`, `~/.config/gh`). Each ledger is read incrementally through the ingest state (a trim past 2 MiB reads as a shrink, is read again from byte 0 and said, and adds nothing already held), and the newest two seconds of a ledger are held back to the next run so that identical lines of one second keep their order. `trace -- <row>` prints, beside the tokens and dollars, the calls keyed to the row and the GraphQL points they spent (a response's cost read, a call without one counted as a one-point FLOOR, and a pool only inferred from the call's shape marked), then every call keyed to no row, listed apart with the callers spending most, and from when the store holds calls per account. The footer's `NOT_HELD` no longer names the ledger.
  
  **The key is inferred, and weak, and the report says so.** A ledger line names an account, a workspace and the calling process, not a session. A call is keyed to a session only when it came from a session's shell and exactly one session's tool window (the gap between a turn and the next of the same wake, up to the tool_result) covers its second. Measured on 2,731 calls of the leads' workspaces, whose session is known: the turn's own span named one session 900 times and was wrong 763; the tool window names one for under 1% of calls, because several sessions are always waiting on a tool (on this host, 27 of 11,751 calls). So per-row figures are a LOWER BOUND, and a call with two covering sessions is `ambiguous` and names neither. The exact key is a session id in the ledger line, which `host/gh` does not write yet.

## 0.30.5

### Patch Changes

- befb746: The outcome clock reads what an idle claimed row's holder waits on, wherever the pull request is: a review requested, checks pending, an approval the queue owns, `awaiting-evidence`, and now a `hold:` put by `pr:hold --until` for an event outside the repository (the new `pr-held` kind) all read as a declared wait, where such a holder used to be `pr-owned` and never read. A per-row holder idle for 80 minutes with NO readable wait is raised as `idle-no-wait`, and `never-started` and `wait-premise-gone` are raised at their own measured 80-minute bound instead of the claimed row's 135: `boundOf` reads a per-item bound. A standing seat idle between orders is not read (a11ign/a11ign#3569)

## 0.30.4

### Patch Changes

- 51ac745: `org-retro` counts merged pull requests across every repository the project declares (a11ign/a11ign#3593). Its 2026-10-05 reading, "PRs merged: worse, -56" and a doubled "tokens per merged PR", came from a read with no `-R` (the primary repository alone: 48 merges, where `a11ign/agent-org` merged 82) divided into a token total summed over EVERY session. The population is the primary plus every `dora` entry (`mergedPopulation`), each read with `-R` (`readMerged`); PRs merged, the median open-to-merge and tokens per merged PR are computed over all of them, and each repository's own count prints beside the total. A repository whose list cannot be read makes the total `unknown`, never a 0. The read limit is 1,000 rather than 200, and a read that returns that many is `unknown` and says it hit the limit. The first reading after the change prints the old (primary only) and the new total once: each reading now records the repositories it counted in `org-retro-readings.jsonl`, and a previous reading without them was the old definition.

## 0.30.3

### Patch Changes

- 404eff7: `chairman:reply` makes the road to a fact easy without loosening what it will say. A refusal for a `#3542` in free text now READS the row itself (`issue`, then `pr`, because the issues endpoint refuses a pull request) and names the fix with the real kind, number and value in it: `write #{{issue:3542.number}}; it is a row and reads "closed" now`, and for a state word the exact `{{issue:3542.state}}`, in place of a template with `N`. When those placeholders are the only thing in the way, the refusal prints the writer's own text with them in, on a `corrected, send this instead:` line, and that text sends (`--dry-run` prints the same line). Nothing a reader did not return is stated: `#3542 is merged` over a row that reads `closed` is still refused, and the reason says what the reader returned; a number neither reader can return is refused with why; a state word in a text about two rows is not guessed for either, and a text with any other number or secret-shaped string in it gets the per-row fixes but no corrected text. A text with no `#N` in it causes no extra read, and at most five rows are read for one refusal (a11ign/a11ign#3565).
- d529dda: The gate no longer reads every Claude transcript on the host to count a row's calls. `liveClaudeTurns` skips a transcript nothing has written to within a day (`LIVE_TRANSCRIPT_HORIZON_MS`), and reads one that has been touched whole. Measured on the live `~/.claude/projects`, 3.3 GB over 4,221 files: 50.2 s wall and 38.1 s CPU before, 3.6 s and 3.4 s after, at host load 42. The tick-cost census also stops recording an asynchronous `exec` twice, and `util.promisify(execFile)` resolves `{ stdout, stderr }` under the preload again. a11ign/a11ign#3566, slice 3 of the tick's cost.

## 0.30.2

### Patch Changes

- 644754e: `dora` places an npm release that has no `gitHead` and no tag by its provenance attestation, so Lead time for a package published through CI provenance reads a number instead of `unknown -- ancestry could not be read`. The commit is the `gitCommit` of the version's `slsa.dev/provenance/v1` statement (`/-/npm/v1/attestations/<package>@<version>`), tried only after `gitHead` and the tag; a release whose attestation cannot be read is still `unknown`, never `false`. It costs one request per release inside the window that has neither of the others. A version `0.0.0-...` (a name reservation) is no longer a release for any metric, so a package that holds only reservations reads `no release yet`. `npmReleasesFrom`, `commitFromAttestations` and `isNameReservation` are exported for the test (a11ign/a11ign#3591).
- d3c4726: `pr:open` no longer refuses a row's own `cd <dir> && …` Acceptance with "an `&&`" (a11ign/a11ign#3596, found on #3593). `testFileArgumentsResolve` asked `unparseableConstruct` about the UNSTRIPPED line, so the `&&` that #3026 had declared legitimate was the construct it refused, and every agent-org row written in the shape the engineer brief prescribes had to be rewritten at PR time. It now asks about the line without its leading `cd`, and looks the runner's file arguments up in the `cd` target (not this process's directory); a SECOND `&&` is still refused.

## 0.30.1

### Patch Changes

- c8f660f: The number of `.mjs` source files the tool has can no longer rise (a11ign/a11ign#3556, toolchain row 4d of #3550). `src/packaging/mjs-source-count.test.ts` pins 209 non-test `.mjs` files (under `src/`, `host/` and `.github/`, `src/packaging/` included where the tool's own repository lists the file, so the project helpers the gate copies in are not counted and a new production `.mjs` there is) and 44 `*.test.mjs`, read at `21eb99c` (210 and 44) less the one file this change converts, and fails when either count rises, naming the files the change added against its base (the merge group's first parent, or the merge-base with `origin/main`) where that base can be read. A drop passes and says the pin can be lowered, so two conversions merged together stay green. The refusal and the README carry the rule: a new source file is `.ts`, unless a shipped command imports it; then raise the pin in the same diff and say why. A touched `.mjs` may convert in the same pull request.
  
  `src/messaging/fake-provider.mjs`, the in-memory provider only tests import, is now `fake-provider.ts` and its 18 importing tests (and `docs/messaging.md`) point at it. The ADR's worked example, `src/messaging/sources/watched.mjs`, is not converted: a `.ts` a shipped command imports cannot load under the host's `node` (measured on `/usr/bin/node` 22.22.1: `ERR_NO_TYPESCRIPT`, and `agent-org messaging:watch` dies on `ERR_UNKNOWN_FILE_EXTENSION`). The same fault is already present in `select-changed-tests`, which imports `lib/source-text.ts`.

## 0.30.0

### Minor Changes

- f993805: Every `work-tick` appends ONE line to `tick-cost.jsonl`, beside the wake ledger, saying what the tick cost: wall, CPU (its own and its children's, read from `/proc/self/stat`), peak memory, the load at the reading, the wall and CPU of each phase (`startup`, `version`, `gate`, `roster`, the three tear-downs, `queue`, `wake`), how many wakes it made, and every process it started, by command, with the five slowest command lines by wall. Under systemd the line also carries how long `ExecStartPre` took and the unit's peak memory, the figure the journal prints. A preload (`src/lib/spawn-census.mjs`) is how the gate's `gh`, `git` and `herdr` calls are counted without editing the forty places that spawn them. The file is cut to its newest half past 2 MB, and a line that cannot be written is said on stderr and never changes the tick's exit. Nothing is read from it by the org: it is the instrument for a11ign/a11ign#3566, which asks why a tick takes two to ten minutes.

## 0.29.1

### Patch Changes

- b0db0c3: The "Do it for me" press writes the line `chairman:queue add` accepts as his OK (a11ign/a11ign#3581, D1b of #3409). `answers.mjs` used to answer a `forme` press "not available yet" and write nothing; it now writes ONE ledger line, `{direction: "answer", step: "forme", via: "button", messageRef}` (`FORME_STEP`, the constant `session-queue.mjs` verifies), once per message: a second press on the same message writes nothing and says so. The press is not an answer: the request's label is untouched and nobody is woken, and he is told in plain words that his session was asked and nothing happens until it reads the queue, never what the queue holds. The ask itself is still the liaison's `chairman:queue add`.

## 0.29.0

### Minor Changes

- ce62010: `host:install` puts an `agent-org` command in the host's `binDir`, so a workspace can run `agent-org <cmd>` from any directory without a copy of the tool in the project (a11ign/a11ign#3532). It is `host/agent-org`, a three-line launcher that runs `node <tool>/src/bin.mjs "$@"`, where `<tool>` is `host.json`'s `tool`, rendered at install time like the `@@binDir@@` of the unit templates. It is COPIED, as `gh` is, and not linked: a link into a checkout that is mid-rebase would break the command for the whole org. The tool's checkout is moved only by `update-tool`, so the launcher runs whatever the host runs and holds no version of its own. A host that names no `tool` owns no launcher. `host:check` reports it NOT INSTALLED when absent and DIVERGED when the bytes differ, exactly as for `gh`. From a linked worktree it resolves the project as `pnpm run <alias>` did: with `AGENT_ORG_HOST` unset, the standalone layout now answers the repository the command is run in WHEN IT HOLDS `.agent-org/project.json` (the installed layout's rule, #3068, given to this layout), so the worktree is served and not the main checkout. #3039's refusal stands for every other working directory: the tool's own checkout, the home directory, or any directory not inside a declared repository still refuses naming `AGENT_ORG_HOST` and the file. `AGENT_ORG_HOST`, set, still wins and names the primary's checkout.
- 3b8dbc3: `trace -- --aggregate [--since <ISO>] [--calls <n>] [--store <path>] [--json 1]` prints the token-efficiency tracker, per UTC week (a11ign/a11ign#3513, slice 6 of #3494). Per week: dollars, tokens and wall-clock (first claim to merge) per merged row at p50 and p90 (nearest-rank, each week its own, never pooled); the overhead share of dollars and tokens by standing session, with UNMEASURED turns (a session no order named, a transcript that could not be read) counted apart and never folded into it; the cache-read share of input; the repeat waste in dollars by class (re-delivered orders, preamble reloads at each wake, re-reviews, re-queues, compactions), each turn priced once in the first class that claims it, so the classes add up; CI re-runs as a count and runner time with `dollars: not derivable`; deferred waits as `not held`, never 0, until the deferral log (#3510) is in the store; and the ten dearest merged rows, ties broken by tokens then row number. A row with an unpriced turn is marked as a floor, and a row with no priced turn has no dollar figure. A row with no merge is listed apart (open per GitHub's open-issue list, else "outside": merged before the weeks or closed without a merge) and is in no average. The wake counts are `wakes-per-row`'s, imported: for each week the report prints how many rows its own count of the same rows agrees with and the reason for each that it does not (unmeasured there, the row claimed before the store's ingest window, else printed as UNEXPLAINED). A week the store holds only part of, or that is not over, is marked PARTIAL and left out of the week-over-week comparison. Every definition is printed once at the top. `--calls` (default 1500) is a ceiling on EVERY `gh api` call of one run, the merged-pull-request search and the open-row list included, checked before each call: the run that would make one more stops (with `--calls 0` it makes none, and says the list of merged pull requests cannot be had), so it is never overshot by the several calls one pull request costs. Events are read oldest merge first, skipping what the store holds, so a second run continues; a week with unread rows is PARTIAL, and a budget spent before the open-row list leaves open rows `not asked`. A search that holds more than GitHub's 1000-result cap is refused rather than cut short: narrow `--since`. `--since` is rounded down to its Monday 00:00 UTC; without it the report starts four weeks before the current one. Phase share is the waterfall's (#3511).

### Patch Changes

- d30c3bc: The typecheck covers 44 more files (a11ign/a11ign#3571, follow-up to #3551). `tsconfig.json`'s `exclude` named 48 files that were not type-clean; measured with `tsc --noEmit` and `exclude` emptied at `758ad90`, 44 of them had 147 errors between them (`auto-arm-token.test.ts` had been made clean by #197), and none now do. `exclude` holds four files, the tests that import a sibling living in the project (`merge-guard`, `merge-guard-checks-rule`, `workflow-run-liveness`, `tracker-leak-refusal`), because copying the siblings in would fork a file two repositories must keep identical. The program is 473 files, up from 429, and the CI floor is 440. The fixes are types: JSDoc on the tests' fakes, narrowing assertions, and annotations on six sources whose declared types were narrower than what they accept (`fake-provider`, `listen`, `stall`, `org-retro`, `row-claim` and `poll`, the last two with a hoisted binding that behaves the same). One test (`pr-stall-reason.test.ts`, #3120 (4)) recorded `gh` calls through a seam `stalledPrFacts` no longer has and asserted none, which could not fail; it now asserts what it can.

## 0.28.0

### Minor Changes

- f245fd1: `chairman:queue` (a11ign/a11ign#3427, D1 of #3409): "can you do it for me?" has somewhere to go. For an act the chairman's own Claude session can do with his OK (admin writes, UniFi, switch reads, control-plane reads) the org never takes the credential and never makes him do it by hand: `chairman:queue add --message=<ref> --what=... --why=... --result-wanted=...` appends ONE line (`{id, askedAt, approvedByMessage, what, why, resultWanted}`, a closed schema) to `~/.local/state/agent-org/messaging/chairman-session-queue.jsonl`, mode 0600, and only when the ref is a message the ledger took in from him with his words on stdin matching its hash (as `chairman:record`), or a "Do it for me" press the ledger holds (`answers.mjs` does not write that line yet). One OK is one ask, and a `what`, `why` or `resultWanted` holding a token or key shape is refused with the file unchanged. **There is no executor:** nothing reads the file but a human's session, and a test scans `src/messaging/` for a module that touches it and also spawns a process. His session runs `list`, `take <id>` and `done <id> --result=<one line> [--hand-fix]`; `list` and `take` write `lastRead` to the delivery ledger, so `status` can say `never read` or `not read since <time>` (whether the session is running is not observable, and it never says so). `messaging:measure` prints `hand-fixes by the chairman's session`, counting each `done --hand-fix` in the window its line falls in. A project takes the change by running `pnpm run chairman:queue`; nothing else changes.

## 0.27.0

### Minor Changes

- facdd71: `chairman:reply` refuses text that looks like a flag, and has a `--dry-run`. A `liaison` once typed `--session=liaison` (every other org command asks which session it is) and the chairman was SENT it, as a line of its own. The text arrived by a door `parseArgs` does not guard, a `--` separator or stdin, so the check sits on the text after both are resolved: any word that is `--` and a letter is refused with exit 2, naming the token, and nothing is sent or ledgered (a spaced ` -- ` and a rule of dashes are still prose). `chairman:reply --dry-run` runs the same checks and the same readers, prints the stamped text and what each placeholder resolved to, and builds no provider and appends nothing to the ledger: exit 0 for a text that would send, 2 for one that would be refused, with the refusal printed, and a `--to` no inbound line holds is refused as a send would refuse it. Nothing to take: a command that sent text starting with `--` now refuses it.

## 0.26.4

### Patch Changes

- 889295b: A spawned agent's first prompt is confirmed SUBMITTED, and a refused wake is never logged delivered (a11ign/a11ign#3546, found by the chairman 2026-10-04: `worker-3544` and `worker-3486` sat 10 and 16 minutes with the prompt typed and unsent while the gate had logged `WOKE ... (STARTED ...)`). `deliver` now types nothing into a process it just started until herdr reports it `interactive_ready` and `idle` (30 s bound, else UNDELIVERED with that reason), and after the prompt it reads the agent again: still `idle` after 30 s means the text is in the box, so it sends ONE Enter (`agent send-keys <label> enter`) and waits 10 s more. An agent that never leaves `idle` is UNDELIVERED, never STARTED, never recorded, and the start is undone (the workspace closed, the claim released) so the next tick offers the row again as an order instead of typing a second copy on top of the first. An agent that did start a turn is sent no Enter. Measured live on 2026-10-04: `agent start` returned `interactive_ready: true`, the prompt took the agent to `working` in 1.1 to 1.3 s, and `send-keys enter` on typed-but-unsent text started a turn in 1.3 s, so 30 s is about twenty times the reading. The second half: a refused `/clear` or `/compact` was filed under `refused` (printed UNDELIVERED) with `-- delivered anyway` and the order counted sent, so one order carried two statuses. A refusal that leaves the session reachable now rides on the DELIVERED line (`worker <- key [seat: /clear refused (agent_blocked)]`) and `refused` stays empty; one that says the agent is gone (`agent_not_found`) is UNDELIVERED with herdr's own words and nothing is typed. A context command's refusal now quotes herdr's stderr (`herdrReason`), not the `Command failed: herdr ...` line that named neither code. Existing herdr fakes in the tests answer `agent get` through `src/packaging/started-pane.ts`.

## 0.26.3

### Patch Changes

- 3cc9e00: The trace store is the one source for "how long" on a row or pull request, and the outcome clock is held to it (a11ign/a11ign#3517, #3494's done-when 5). `src/trace/clock-feed.mjs` is a pure read of the store's records (`clockFeedOf`: when a row was filed or a pull request opened, when the clock starts, when a merge or close stopped it; `openMsOf`), and `clock-feed.test.mjs` runs the gate's own facts into `overdueReading` beside it and is RED, naming both numbers, when the clock's `since` or the line it states is not the store's; the same join holds `org-retro`'s median open-to-merge and the backlog age to it. The clock is NOT fed from the store at run time (the gate does not ingest it each tick). The comparison found a real divergence, fixed here: a pull request's ISSUE record (`issues/{n}`) reads a second after its own `created_at`, so the store dated #3575 one second after the clock (1 of 40 merged pull requests); a pull request now asks `pulls/{n}`.

## 0.26.2

### Patch Changes

- 3116290: A pull request whose closing row still has an open `blocked-by` edge is not armed, and the refusal names the blocker. `arm-pr` and `auto-arm-sweep` both ask one decider, `blockerVerdict`, after the authorship and ejection checks and before any write: it reads each `Closes` row's native `blockedBy` (in the row's own repository for `Closes owner/repo#n`), counts only OPEN blockers, and names every blocked row with its open blockers. A list that cannot be read, or whose `totalCount` exceeds the page returned with no open node on it, is `cannot-ask` and arms nothing, as an unreadable label list does. `Closes: none` has no row to read and arms as before. The PR gets one comment, found again by a marker so a tick does not repeat it, saying it arms on the tick after the blocker closes. `refusalBeforeArming` now takes the PR's body (a11ign/a11ign#3544).

## 0.26.1

### Patch Changes

- d85cb24: The tool is now typechecked, and CI runs it (a11ign/a11ign#3551, toolchain row 4a of #3550). `tsc` ran nowhere: 217 of the 244 `.mjs` files carry `// @ts-check` and 226 files are `*.test.ts`, and none of it was checked. Measured with `tsc --noEmit` on a throwaway config at `472ac76`: 206 errors in 68 files (198 in 64 once the target was ES2023, which the sources already needed for `toSorted` and `findLast`). Now a tracked `tsconfig.json`, an `npm run typecheck` script, `@types/node` as a devDependency, and a `typecheck` job in `ci.yml` on every pull request, merge-queue run and push to `main`. The program is 429 files outside `node_modules` and exits 0; its `exclude` names the 48 files (46 tests, 2 entry points) that nothing included imports and that are not yet clean, 150 errors between them, so a new file is checked from its first commit and the list can only shrink. Nineteen source files that the clean ones import were fixed forward, in JSDoc types and casts only: each compiles to byte-identical minified JavaScript before and after (`esbuild --minify`, compared per file). Five of the excluded tests import sibling modules that live in the project the tool is installed in, so they cannot be checked from this repository alone. Making `typecheck` a required check on `main` is a repository setting and is not made by this change.

## 0.26.0

### Minor Changes

- 914d563: `host:check` and the org-health tick read which `agent-org` release every runner actually runs and signal when any is not the newest release tag for longer than one release cycle (a11ign/a11ign#3533). Three readings, each an independent fact about a runner: the tool checkout (the tag it sits at, or "at no release" and its commit), every worktree's resolved `node_modules/agent-org` for each declared project (its `package.json` version through the symlink, or none), and the last completed `ci.yml` run on `main` (the version its lockfile names, else the `agent-org resolved vX.Y.Z` line a resolver step prints; a run that names none is UNKNOWN). The newest tag is read from the tool's remote (`git ls-remote`), not the checkout, which may itself be behind. The cycle is derived from `host/work-tick.timer.in`: the tick's `OnUnitActiveSec` plus the nine-minute tag lag plus one more tick, 13 minutes at the shipped 2-minute tick. The comparison is one pure module, `src/lib/tool-version-agreement.mjs`, which `host:check` (a finding when a runner is behind, a note otherwise) and the new `runner-behind-newest-release` org-health signal both call; an unreadable runner is named as unread and never counted as agreeing. `host:check --json` does not carry it (the tick reads it itself), so a session is not woken twice. The gate's `orgHealthNow` takes a `readToolAgreement` seam that is silent unless the caller passes one, and `work-gate.mjs` passes the real reader, which runs `src/lib/tool-version-agreement.mjs --json` in a child process.

## 0.25.1

### Patch Changes

- 7c585ea: The outcome clock names a claimed row for the two idle shapes it could not tell from a row being worked (a11ign/a11ign#3486, slice 2b): `wait-premise-gone` (its holder idle on a `Not-before:` that is in the past, #3131) and `never-started` (no commit, push or comment, no pull request, its holder idle, #3495). The reading is `idleClaimantReading` over the claim-stall tick's moves (`decideArgs.claimFacts`) and herdr's listing, read only when a claimed row is untouched past `OVERDUE_IDLE_CLAIM_MINUTES` (80, measured). A busy holder, a wait that still holds, a pull request that owns the row and a young claim name nothing; a refused or partial herdr listing is reported unread, never as clear. The rows are still RAISED at the 135-minute row bound: `boundOf` reads one bound per kind and lives in `org-health.mjs`.

## 0.25.0

### Minor Changes

- a62e8a1: `agent-org trace` now holds every actor's turns on the row they were about (a11ign/a11ign#3519, slice 2b of #3494). Why a product-manager's turns on #3406 were missing, measured on the host's own transcripts and ledger: a wake whose ledger key lists several rows (`product-manager/row-call-count-signal/3125,3404`) was left with `row: null`, because the first of the list is a guess, and so were its turns (41 of the 42 product-manager turns on the row); and an order typed by `prompt:session` has no ledger line, so a ruling made in its turn belonged to nothing (1 of the 42). Now a key that lists rows or pull requests puts the wake and its turns on EACH of them (`rows`, `prs`; `row` stays null), and a turn that WROTE to a row or pull request of the primary repository with `gh issue|pr edit|comment|close|reopen|ready|merge|review <n>` is on that one (`touchedRows`, `touchedPrs`, inferred from the command text: a view, a command that names another clone or `--repo`, and a `gh api` write are not read). The Codex reviewers' sessions under `~/.codex/sessions/<year>/<month>/<day>/` are read by a new pure reader (`src/trace/codex-turns.mjs`) into the same turn events, one per model request (`response_id`, so the running `token_count` totals are not counted again), `harness: "codex"`, keyed to the pull request in the session's directory name (`reviewer-<n>`, `reviewer-<repo>-<n>`), with tokens (`input` the uncached part, since Codex counts cached tokens inside `input_tokens`), the model, and `costUsd: null` because `PRICES` has no row for it; the files are only read. The store is now a last-wins append-only log: a corrected copy of an event is appended and supersedes the stored one, an identical copy adds nothing, and nothing on disk is rewritten, which is how the fix reaches the turns already stored (the ingest state is version 2, so the first run after this is a reported cold start). The report prints the totals per actor on the row and, per kind of actor, from when its transcripts are held; `NOT_HELD` no longer lists Codex reviewer turns and now names the subagent transcripts, which are not read.

## 0.24.1

### Patch Changes

- b73710a: A claimed row that holds no code stops reserving its Region (a11ign/a11ign#3541; #3418's holder said "No code is left to write" and the gate went on shelving #3509 behind it for 63 minutes). A claimed row labelled `no-code-left` is dropped from the claimed-row comparison, and the shelving reason names the label as the way out. Its open pull request, if any, still decides by its files. And for a claimed row the fenced block of a Region section is the declaration and the prose around it declares nothing, so a paragraph that names a root-level file to say the row no longer edits it no longer reserves it; a section with no fence is read as before.

## 0.24.0

### Minor Changes

- d655231: A chairman message is never dropped. When the liaison's queue refuses a chat message for any reason (the seat absent from herdr's roster, a full inbox, a queue file that cannot be written, an entry that is not in the file), `converse.mjs` queues it for `ceo` instead (`FALLBACK_RECIPIENT`, written once, the liaison always first), with the same provenance text plus one line saying why it came to `ceo`. The chairman is told in plain words (`The liaison isn't running; I've passed this to ceo.`) and never the queue's refusal text, a handoff, a path or an error class; only when `ceo`'s queue refuses too is the message lost, and he is told that and asked to send it again. The ledger keeps one line per message with verdict `rerouted-to-ceo`, the new `taker` and the first line of each queue's refusal (`refusals`); the listener's `outcome` is `rerouted-to-ceo`. A button's order (`explain`, `stuck`) gets the same fallback and the same plain words in `answers.mjs`, and the listener's "queue would not load" reply is plain too (`notReached()` no longer takes the reason; it stays in the ledger). This reverses the rule of a11ign/a11ign#3416 ("no fallback to `ceo`") on the chairman's order of 2026-10-04 19:55Z (a11ign/a11ign#3538); the scan over `src/messaging/` still finds `converse.mjs` as the one caller of the queue.

## 0.23.0

### Minor Changes

- 51c9080: `agent-org trace` now ingests only what changed since its last run (a11ign/a11ign#3526, first slice of #3494 after the store), so it can run after each merge or over many rows. A new state file beside the store (`<store>.ingest-state.json`, `src/trace/ingest-state.mjs`) keeps, per transcript, the byte offset read, the file's size and mtime at that read, a hash of its first bytes, and the carry a resume needs in the middle of a conversation: the session's name, the wake in force at the offset (a turn takes its row from the wake before it, so without it the first turn after the offset would have `row: null`), the time of the last record, and the ledger lines already paired. A file whose size and mtime are both unchanged is not opened; a grown one is read from its offset; a file that shrank or whose first bytes changed is read again from byte 0 and listed in the report; a missing, unparseable, foreign-version state, or a store smaller than at the last run, is a full ingest and a reported cold start, never an error and never a silent skip. The store is read once per run and appended to as one batch per source (the shipped ingest re-parsed all of it for every transcript). A message written in the last 5 minutes is held back to the next run, because its turn is built from its last block and the store is append-only (measured on 80 transcripts: blocks of one message are sometimes separated by other records, the longest gap between them was 47 s). The report states the bytes read, the transcripts unchanged, the cold start, any re-read, what was held back, and from when the state holds the transcripts; it still names what the store does not hold.

## 0.22.2

### Patch Changes

- 8d77fde: The gate feeds the outcome clock the claimed rows' comments, so a claimed row past its bound is named overdue (a11ign/a11ign#3486, slice 2). `orgHealthNow` had `claimedComments` since slice 1 but the tick's call omitted it, so production clocked PRs and was silent about every claimed row. "No row is claimed" is now `[]` and a refused read of the comments stays `null`, reported as unread and never as nothing overdue. The dead `readHeadCommittedAt` and its `GH_READS.conditionalOnQuietStalledPr` entry are deleted; a Dependabot PR is a fixture of the clock.

## 0.22.1

### Patch Changes

- dfb08c0: Two or more open pull requests that change one file are reported on the tick to the owner of the later one, before either conflicts: the order tells them not to rebase or ask for a review yet, and to hold behind the one ahead (`Waiting-for: merged #m`) until it merges; a pair already held and waiting is not reported again (a11ign/a11ign#3480)

## 0.22.0

### Minor Changes

- fba8ff5: `agent-org trace -- <row-or-pr>` now holds what GitHub saw (a11ign/a11ign#3508, second slice of #3494): when each row was filed, claimed and released (the claim-record comments), when a hold or an `answer:` order was set and lifted, when each pull request was opened, made ready, reviewed (the state, and the head it was posted on), moved to a new head, run through CI (each check-run: name, conclusion, start, end, head), queued, taken out of the queue and merged or closed. Every record is `source: "github"` with a stable id, so a second ingest adds nothing. Only the REST pool is spent (`gh api`), the report states how many calls were made, and a call that fails or a list that would not fit in the pages read throws rather than printing a trace that lacks the reviews. `NOT_HELD` no longer lists GitHub events and still lists the `gh` call ledger, the gate's deferral spans and Codex reviewer turns. A queue exit is `outcome: "merged"` when it falls within five seconds of the merge and `"unmerged"` otherwise, which is how an ejection reads; a head move is dated by its commit, because the timeline carries no push event.

## 0.21.3

### Patch Changes

- 241c16e: A claim whose pull request merged in another tracked repository is released as merged only after the holder's worktrees in THAT repository's clone were read: one with a dirty file or a commit on no remote is held, and an unlisted clone or a failed `git worktree list` refuses the release, in the gate's reading and in the performer's own re-read (a11ign/a11ign#3453)

## 0.21.2

### Patch Changes

- a70b355: `chairman-listen` and `chairman-watch` in tool form now start (a11ign/a11ign#3485). Both took the project root from `process.cwd()`, and a unit in tool form runs from the TOOL's checkout, which holds no `.agent-org/`, so each exited 2 on `<tool>/.agent-org/project.json` and `RestartPreventExitStatus=2` left it stopped; `work-tick` was immune because it resolves its project through `$AGENT_ORG_HOST`. `messaging:listen` and `messaging:watch` now take their root from `HOME_CHECKOUT` (`resolveHomeCheckout`): `$AGENT_ORG_HOST` wins where a unit declares it, and an installed project's `pnpm run messaging:*` still answers the directory it was run in. `messaging-units-start.test.ts` renders each shipped unit with the real `toolForm` and STARTS its `ExecStart` as a child, from its `WorkingDirectory` with its own environment, against a scratch project and HOME (no network, no real `~/.config`); its mutant is the pre-fix tool, which must exit 2. The other messaging commands (`check`, `pair`, `reply`, `record`, `correct`, `ask-ceo`, `watch-list`) still read `process.cwd()`: a person or `pnpm` runs them from the project.

## 0.21.1

### Patch Changes

- 3642d17: A `blocker-cleared` order is dropped, with its reason logged, when its holder already acted on the news (a11ign/a11ign#3451). #3390's worker claimed 101 s AFTER its last blocker closed (a claim is refused while a `blockedBy` edge is open), was deferred 13 ticks, and was told "PICK IT BACK UP" 91 minutes later, 1 min 46 s after it opened its pull request in `a11ign/agent-org`, which the old screen (the home repository's `Closes:` lines) could not see. `claimStallTick` now hands the facts it already builds for every claimed row on to `blockerClearedReading` (`onFacts`), which drops the order for one of three reasons, a closed set: `claimed-after-clearing`, `own-pull-request` (an open, unheld, or since-merged pull request that `ownsPr` says is the claim's own, in any tracked repository) and `moved-since-clearing` (a comment, commit or push after the clearing). Each drop is returned beside the orders as `{causeKey, reason, at}` and printed as a `SHELVED row #n:` line. A refused read (no claim record, the other repository's open list, the closing times) drops nothing and the log names it. `blockerClearedOrders` keeps its signature and returns the orders alone.

## 0.21.0

### Minor Changes

- 6849076: A run in progress can be watched with `chairman:watch add run <id>` (a11ign/a11ign#3502). Its state is the new vocabulary field `{{run:<id>.status}}`: the run's status (`queued`, `in_progress`) while it runs and its conclusion once it has one, so each move is told and the watch ends with the conclusion. Until now the only run field, `{{run:<id>.conclusion}}`, threw for a run that had not concluded, so `add` refused the one case a watch is for; that field is unchanged. The liaison's brief restates the vocabulary, so a project that pins it learns `run:<id>.status` from `PLACEHOLDER_NAMES`.

## 0.20.0

### Minor Changes

- dee0bc9: A project's `beforeTick` can name one of the tool's own commands (`"beforeTick": "agent-org primary:update"`), and the `work-tick` unit in tool form then runs it from the tool checkout (`/usr/bin/node <tool>/src/update-primary.mjs`, through the same command table `agent-org` itself reads) instead of through the project's `node_modules`. A project that declared `pnpm run primary:update` ran the copy its lockfile pins, a second version of the tool on every tick, for the one step that moves the project's own checkout. The words are split on any whitespace, the one way `parseBeforeTick` lets a command through, so a tab or a run of spaces after `agent-org` is the same command. A command that is not the tool's is still the project's own and runs as written; an unknown tool command refuses, and so does one declared by a project that is not the host's primary, because the tool serves the primary only. To take the change, a project edits its `beforeTick` to `agent-org primary:update` AFTER the host runs this release (an older tool would run the word `agent-org` as a program and the primary would stop moving), then reinstalls the unit with `host:install`.

## 0.19.7

### Patch Changes

- 8c05f9e: "Keep me posted on X" is recorded once and told when X changes state. `pnpm run chairman:watch -- add <row|pr|run|unit> <id> --message=<ref>` writes a `direction: "watch"` ledger line naming the thing and a message of the chairman's the ledger took in (an unknown ref, or a thing the placeholder vocabulary's readers cannot read, is refused and writes nothing); `list` and `remove` answer "what are you keeping me posted on" and end a watch without a message. Each tick the new `watched` source reads every active watch through those readers and offers `watch:<thing>` (`<what it is>: now <state>`) when the state differs from the last one told, and a watch ends when its final state (a row closed, a pull request merged or closed) has been told, derived from the ledger, so a final send that failed is offered again. A `run` cannot be watched yet: the vocabulary reads a run only once it has concluded.

## 0.19.6

### Patch Changes

- 0eefc09: `release.yml`'s header and the README's Releases section no longer say the host tracks `main` and a tag is not a deploy, which `update-tool` made false (a11ign/a11ign#3443): they say the host runs the newest release tag, `host.json`'s `toolVersion` pins one as the rollback, a merge with a changeset is live about nine minutes after it lands and a merge with none is never live. Comment and prose only; the release test now requires `toolVersion` in the README's Releases section in place of the retired sentence.

## 0.19.5

### Patch Changes

- 22a29bb: The board report names the agent-org version that produced it, in one line under its header, read from the tool checkout's live release tag by `liveToolVersion` and never from `package.json` (which a host's checkout can disagree with), so a report read later says which version wrote it. A checkout at no release tag prints `agent-org version not read` with the cause, never a version and never a blank (#3468, of #3443).

## 0.19.4

### Patch Changes

- 3dd492f: The tick's version banner (`agent-org vX.Y.Z (<sha>)` and `agent-org vX.Y.Z`, a11ign/a11ign#3443) is an expected repeating line: `repeating-lines.allowlist.json` names it, so the detector stops offering it to `orchestrator` after 30 ticks (a11ign/a11ign#3497). The banner's fault forms, `agent-org (at no release tag: <sha>)` and `agent-org (version unreadable: ...)`, stay offered.

## 0.19.3

### Patch Changes

- 4303124: A pull request is a claim's own by one test the open and merged lookups share (head, row suffix, title reference, session label), so a merge on a branch the claimant did not claim releases the claim as merged and is no longer read as idle (a11ign/a11ign#3445)

## 0.19.2

### Patch Changes

- 7f01e32: A code-only scope no longer runs the tracker readings against the primary's tracker (a11ign/a11ign#3493). `scopeTick` gave such a scope `[]` for every tracker lane but still ran `readings.tracker` inside `inRepo(undefined)`, which is the ambient repository, so one closed row owing an answer became one `answer-owed` order per code scope, three of them telling the session to put `--repo <scope>` on a row that does not exist there. A scope whose `tracker` is `null` now reads nothing from a tracker (the shapes an empty tracker returns), and the primary and a keyed scope with its own tracker are unchanged.

## 0.19.1

### Patch Changes

- 0532579: B4 now compares a row's Region with the Regions of the rows already claimed (`in-progress`), as well as with open pull requests' files, so a claimed row with no pull request yet holds its files (a11ign/a11ign#3475; #3414 was claimed over three files #3423 had held for 27 minutes, and the two rows ran into three conflicting pull requests). `row-claim claim` refuses a row whose Region shares a file with a claimed row's, naming it and the files; `row-claim check` prints the same verdict; and the gate shelves a Ready row behind it with the holder's number in the reason, offering it again by itself once that row closes or is released. Nothing is written: the holders are derived from the open rows on every tick. The exclusions are the pull-request ones: changesets, the asking row, a `blockedBy` edge in either direction, and a claimed row whose own open pull request declares `Closes #<row>`, which is counted once, by its files. A claim that cannot read the list of claimed rows is refused as INCONCLUSIVE rather than passed, and two rows both already `in-progress` do not refuse each other: the lower number proceeds.

## 0.19.0

### Minor Changes

- 316d657: New command `agent-org trace -- <row-or-pr>` (a11ign/a11ign#3494, first slice): one append-only trace store of the org's model turns and wake-ledger deliveries, keyed by row, pull request and repository, and a printout of one row's events in order with tokens, cost and wall-clock. The model-turn source is the Claude transcript (platform-first reading on the row: Claude Code's OpenTelemetry has no file exporter, needs a receiver the host does not run, and cannot reach a running standing seat). A turn is built once per API message id, because a transcript writes a message once per content block; cost is computed from a price table checked against Claude Code's own `cost_usd`, and is `null`, never 0, for a model with no price. It reads `wakes-per-row.mjs`'s parsers by import. GitHub events, waits, the `gh` call ledger and Codex reviewer turns are not in the store yet, and the report says so.

## 0.18.2

### Patch Changes

- 97477b8: A reviewer instance's ending closes EVERY herdr workspace under its label, not only a label held exactly once (a11ign/a11ign#3482; `reviewer-3460` held `w16B` and `w16N` on 2026-10-04, and the teardown said "left running" on every tick for as long as both lived). Each close is tried even after one fails, a failing close keeps the instance registered, and the warning names the count. A duplicate that holds no agent no longer stops the instance's OTHER workspace from being judged between turns, and no longer makes a live reviewer look dead under an open pull request. That duplicate is written once to the `reviewer-absences` ledger (`duplicate-agentless`), so it is seen while the pull request is still open.

## 0.18.1

### Patch Changes

- 979e4f8: A declared milestone coming true is told to the chairman once, with the sentence the project wrote for it. `messaging.milestones` in `.agent-org/project.json` names a file (absent means none) listing moments as `{ key, what, when }`, where `when` is a row closed, a pull request merged or a release tagged; the `milestones` source emits `milestone:<key>` the first time one holds and never again, and does not infer a milestone from a label or from GitHub's own milestones. The first complete read records the moments already true as seen and tells none of them. A condition that cannot be read is `cannot-ask`, never "not yet". `messaging:check` validates the file and refuses an entry with a missing `key`, `what` or `when` by name. This registers the `milestone` event kind in `event.mjs` and `core.mjs` (told once, never reminded, not silent) and admits `gh api` on `issues/<n>`, `pulls/<n>` and `releases` in the read-only allowlist (a11ign/a11ign#3414).

## 0.18.0

### Minor Changes

- 3427864: `org-health`'s seventh signal is now an OUTCOME CLOCK, `overdue`, in place of `pr-not-progressing` (a11ign/a11ign#3486, the chairman's "how do we make sure nothing happens again?"). Every open pull request has an age since it opened and every claimed row an age since its newest claim record; ONLY A MERGE OR A CLOSE STOPS IT, so a comment, a label, a hold, a draft and a push do not restart it and no state exempts an item. Past 100 minutes for a PR (3 x the 33.7 min median of 289 `a11ign/a11ign` PRs merged 2026-09-27..10-04) or 135 minutes for a claimed row (3 x the 44.5 min median of 282 rows closed 2026-10-01..10-04, from the newest claim record) the item is offered to `ceo` as one `org-health` order that names each item with its kind, the gate's own label for its state (`stallReasonOf`: red, conflicted, held-on-purpose, awaiting-author-draft ...) and its owner. The label rides on the alarm and is never a condition for raising it, which is what hid a hold whose reason had gone and an approved draft with no stamp. A refused read, or an item nothing dates, is an unknown and never young. `PR_NOT_PROGRESSING_MINUTES` (180) and `REASONS_THAT_ARE_NOT_A_STALL` are deleted, and the clock costs no `gh api` call where the signal it replaces paid one per quiet PR. `orgHealthNow` takes the claimed rows' comments as `claimedComments`; a caller that omits it clocks the PRs and says nothing about the rows.

## 0.17.1

### Patch Changes

- d31cf97: `pr-hold.mjs` takes, reads and releases a hold on a pull request of any repository the project declares: `--repo-key=<key>` (the key `project.json`'s `code` gives it) or `owner/repo#n`, absent being the first repository so every existing call is unchanged, and a repository the project does not declare is refused naming the declared ones. Every `gh` call, the marker comment and the re-arm read-back are aimed at that repository. The gate lifts a keyed pull request's resolved hold through the same module, released WITH its key, and reads a bare `#n` in a keyed item's `Waiting-for:` as that repository's (a11ign/a11ign#3479).

## 0.17.0

### Minor Changes

- 6327be6: The `gh` routing wrapper (`host/gh`) now records every call in a size-bounded ledger, `gh-calls.tsv` in the account's own config directory, so the caller that drains a GraphQL pool can be named by measurement rather than guessed. Each line carries the time, the account, the pool (`graphql` and `core` where `gh` says so, `graphql?` where it is inferred from the command family), the `rateLimit.cost` a `gh api graphql` response reported, the exit status, `argv[1] argv[2]`, the herdr workspace and the calling command line. The call itself is unchanged: same arguments, stdin, output bytes and exit status, and a ledger that cannot be written never fails it. The wrapper no longer `exec`s `gh`, so it forwards `TERM`, `INT` and `HUP` to it. `A11Y_GH_LEDGER=off` skips the ledger. `node src/gh-ledger.mjs <gh-calls.tsv> [--account <login>] [--resource graphql] [--top <n>]` ranks callers by points. Re-run `host:install` to pick the wrapper up; `host:check` reports `DIVERGED` until then.

## 0.16.0

### Minor Changes

- aa4735f: The liaison can ask `ceo` for a ruling through `chairman:ask-ceo --row=N --message=<ref>` (the question on stdin), and a question that names nothing that clears it is refused (a11ign/a11ign#3490, split from #3417). It is `prompt:session ceo --needs-decision` with two refusals in front, both before anything is queued: a `--message` ref the ledger does not hold, and a question with no `Waiting-for:` line the gate's own parser (`parseWaits`) reads as a condition on a row (`Waiting-for: unlabelled answer:ceo #3490` passes; `soon`, `manual`, a bare `#3490` and a line inside a code fence do not). The target is the constant `ceo`, with no argument that names another session; `prompt:session`'s exit 2 is reported as queued and not retried; the verb set of `chairman:correct` is unchanged. `docs/messaging.md` says what the predicate is and why.

## 0.15.3

### Patch Changes

- 94a1ffe: The work gate no longer asks a reviewer for a first verdict on a pull request that conflicts with its base (a11ign/a11ign#3476). `draftOrder` read red, then a settled green head, and never asked whether the pull request could merge, so a DIRTY one sat in the reviewer lane as a clean one does: #148 was approved 7m42s after #145 made it DIRTY, at a head the rebase had to replace. A `CONFLICTING` pull request now gets no `draft-awaiting-verdict` order; its owner's `pr-merge-conflict` order already says the rebase is owed, and once it is pushed the head is new and the review is asked once, at the head that can merge. An unread merge state (`UNKNOWN`) still asks for the review, and a verdict already given (rework owed, a convinced draft not yet ready) is still acted on: only the request for a first look is withheld.

## 0.15.2

### Patch Changes

- f24cef3: Neither arming path re-queues a pull request the merge queue ejected for `failed_checks` while its head is unchanged (a11ign/a11ign#3487; #3460 was ejected four times on 2026-10-04, about seven minutes of CI each, every pass failing the same way). `arm-pr` logs `NOT arming` with the ejection time and exits `DONE`; `auto-arm-sweep` reports `SKIPPED` with the same reason; both ask the one `ejectionVerdict` in `pr-armed-state.mjs`, which reads `queueEjectionOf`. A push to the head, a dequeue for any other reason and a PR with no queue history arm as before. A queue read that is refused arms nothing and is reported as a lookup that failed (`arm-pr` exits `CANNOT_ASK`, the sweep exits `1`), never read as "not ejected".

## 0.15.1

### Patch Changes

- 42bd79b: The trunk-red order now tells the fixer how to make its fix findable (a11ign/a11ign#3449): label what it opens `incident` and put `Incident: incident:trunk-red` on a line of its own in the body, on both the own path (the fix pull request) and the routed path (the filed row). `readFixRow` accepts an open pull request carrying that label and line, where it skipped pull requests and so reported `nobody has picked this up yet` beside an open fix PR, and returns the item's `session:` label as `holder`. The other incident and stall keys have no standing order that opens a fix and are labelled by hand.

## 0.15.0

### Minor Changes

- 1370868: A finishing order that has waited past the deferral bound goes to a free engineer where its cause allows (a11ign/a11ign#3465, follow-up of #3448). An order now declares `mayRelane: true` when any session can carry it out, and the only declaration today is `draft-convinced-not-ready` with an attributed verdict (the ready-flip the gate also performs itself); a self-signed or unattributed verdict, and every other cause, stays queued for its owner and is raised to `ceo` as before. When a declared order has been deferred for more than `ORDER_STALL_MINUTES` (15) and an engineer is free (`route`'s own test, `ineligibleReason` included), the tick prompts that engineer with the order under a line saying why, and the ledger records the recipient. It never starts a process for it: with nobody free the order stays queued and its refusal says `not re-laned: <why>`, still in the busy-seat shape so its age keeps counting. An unreadable deferral record re-lanes nothing and says so.

## 0.14.3

### Patch Changes

- 124539a: `host:install` no longer starts a timer whose window ended on purpose: a timer systemd reports `disabled` whose window record holds a `stop` row (no newer arm marker) is written like every unit, gets no `enable --now`, and is reported `SKIPPED <unit> -- its window ended (<cause>, <ticks> ticks, <at>); arm it with shadow-window.mjs --arm`. It used to enable it, so the single remedy every message names undid what `host:check` calls `EXPECTED DISABLED -- ITS WINDOW ENDED`. A timer disabled with no stop row, one re-armed after its stop, and an enabled one are enabled as before, and the `host:check` note no longer says `host:install` would restart it (a11ign/a11ign#3484).

## 0.14.2

### Patch Changes

- 4e9fd64: An order to a live instance carries only what changed. A follow-up header no longer says "your first order and its brief still stand", a spawned engineer's first order is its identity, row, worktree, branch and the one line naming `engineer.md` (it no longer repeats the three autonomy and end-of-turn paragraphs that file now says once), and the dated incident stories in order text (`blocker-cleared`, the claim-stalled nudge and fourteen other causes) moved into the comment above the function that builds each order, leaving one clause of reason in the order.
- ad2aac7: A reviewer workspace that herdr brings back after its ending is looked at again, and a pane stopped at an interactive prompt is reported (a11ign/a11ign#3458). The reviewer teardown walked the registry's keys and nothing else, and an ending deletes the key, so when herdr restarted in the same second and restored the closed workspaces of `reviewer-agent-org-35` and `-36` (2026-10-02) they sat at Codex's working-directory picker for two days. The sweep now also takes every workspace on the listing that carries an instance's label and has no registry key, asks its pull request's own repository, and ends it with the same ledger line when that is closed or merged; an open or unreadable state, a working pane, `reviewer-1` and `reviewer-2`, and a label held by two workspaces are left. A new `org-health` signal, `pane-stopped-at-a-prompt`, offers `ceo` any pane that is not working and has shown Codex's picker or a trust prompt for over fifteen minutes, naming the session, the pane and how long; the first sighting is kept in `pane-prompts` beside the ledger because herdr stamps no time on a screen.

## 0.14.1

### Patch Changes

- 03704ef: A SENT `incident:` or `stall:` message now ends with `Impact:` and **`Being done:`** (it was `Doing:`): the newest comment an org account left on the open row whose body carries `Incident: <key>` (label `incident`), quoted with its age, or `nobody has picked this up yet` when no such row is open, or `I could not read it` when the read failed (the event is still sent). A CLEARED message gains `Lasted: at least <span> (counted from the message that told you)`, read from the ledger through the new `readEpisodeStart(key)` reader, and `not known` when it cannot be read. `readFixRow` changes shape (a row and its newest org comment, not a row and its holder) and now makes up to two `gh api` calls; `watch.mjs`'s read-only allowlist admits `issues/<n>/comments`. The hold-down, the key and `firstSeenAt` are unchanged (a11ign/a11ign#3419).

## 0.14.0

### Minor Changes

- a94d56a: The liaison can record what the chairman said on a row and fix what he says is wrong, through two commands and nothing else (a11ign/a11ign#3417). `chairman:record --row=N --message=<ref>` (his words on stdin) writes one row comment, quoted with its HTML comment markers escaped and opening `Recorded by liaison from the chairman's message <ref>; not written by the chairman`: it never carries the listener's `Chairman answered via Telegram` line, which only the listener may write. `chairman:correct --row=N --message=<ref> --as=withdraw|reroute|re-ask` is a closed set: `withdraw --reason=stale|wrongly-labelled|already-done` removes `needs:chairman` with a comment and writes a `withdraw` ledger line; `reroute` sets `answer:product-manager` and no other label; `re-ask` writes a new brief, refused unless the watcher would send an alert for it. Every command refuses a `--message` ref that is not an accepted inbound line in the ledger, and (but for a `re-ask`'s brief) words that are not the ones the ledger hashed, so nothing is written for a message the chairman did not send; a failure between two steps is resumed by the next call and not repeated. An agent with a shell can still write any comment with `gh`: this makes a recorded answer detectable against the chairman's chat, not impossible.

## 0.13.0

### Minor Changes

- 02ded8f: A standing lead (`ceo`, `product-manager`, `orchestrator`) is no longer `/clear`ed before every order: when its previous order landed 30 minutes ago or less and its window reads at or under 100k cache-read tokens (50% of 200k) it keeps the window and is typed the follow-up shape; recent and over that it is `/compact`ed; older, or whenever the previous order's time or the transcript cannot be read, it is cleared and typed the whole first-contact order as before. Both numbers are unmeasured starting constants (`KEEP_WITHIN_MS`, `KEEP_FILL_TOKENS`, `wake.mjs`). `deliver` and `clearThenPrompt` take the one decision (`prepareContext`), the time of each landed order is kept beside the ledger (`last-order/`), and a kept lead's follow-up says what its window holds from earlier turns is a reading at a moment. The batched-wake header and `prompt:session`'s output and queued-order notice say what THIS delivery did (kept, compacted or cleared) instead of the sentence that was true only of a clear. Reviewers, spawned workers and persistent seats are unchanged (a11ign/a11ign#3440).

## 0.12.0

### Minor Changes

- 97222d5: The chairman's request message now carries buttons (a11ign/a11ign#3423). The Telegram provider declares `buttons: true` and draws `actions` as `reply_markup.inline_keyboard`, and `messaging:watch` hands each `needs:chairman` request its options (or Approve), Explain more and Later; the answers path read `callback_data` and the brief offered options, but nothing had ever drawn a button, so the chairman could only type. A button's `callback_data` is a closed vocabulary (`ans:<option id>`, or `act:` plus `approve`, `done`, `stuck`, `later`, `explain`, `forme`): anything else is dropped with a hash and never forwarded. A press resolves the request (an option, `approve`, `done`), snoozes its reminders for 24 hours (`later`; the label stays), or queues one order for the `liaison` (`explain`, `stuck`); a press on an answered message is told so and its keyboard is removed. Events gain an optional `actions` list that the core hands to a provider that declares `buttons`, and never to a cleared notice. `converse.mjs` queues for the `liaison` as well as `ceo`, through the same single call.

## 0.11.1

### Patch Changes

- 4fe9e8f: `chairman:reply` now hands `createGhReaders` the files `{{fleet.workers-up}}`, `{{fleet.workers-down}}` and `{{gate.last-tick.age}}` read: the two `fleet-watch` files under the project's `runs/`, and the work-tick completion record beside the wake ledger (as `messaging:watch` names them). The wake ledger's directory is resolved when asked, so a host that cannot name it costs `{{gate.*}}` alone, with a diagnostic on stderr, and the command still loads outside a configured host (a11ign/a11ign#3446).

## 0.11.0

### Minor Changes

- bdf181c: The host runs ONE agent-org version, the newest release tag (a11ign/a11ign#3443). `update-tool` fetches tags by name and checks out the newest `vX.Y.Z` (numeric order; a pre-release and a name such as `latest` are ignored) instead of `origin/main`, prints `agent-org vX.Y.Z (<sha>)`, and with no matching tag refuses and leaves the checkout where it is, with no fallback to `main`. `host.json`'s new `toolVersion` is `"latest"` (the default) or one `"vX.Y.Z"`, which pins the host there: pinning the previous tag is the whole of a rollback, and any other value is refused by name. A move restarts the long-running units (`systemctl --user try-restart` of the chairman listener) so no process keeps the old modules, `chairman-listen` and `chairman-watch` render `node <tool>/src/messaging/*.mjs` in tool form, and `work-tick` prints `agent-org vX.Y.Z` as the first line of each tick (`liveToolVersion` is the reader a report can call).

## 0.10.0

### Minor Changes

- 433b9c2: A finished draft no longer waits behind a busy session, and a wait is no longer silent (a11ign/a11ign#3448). **The ready-flip**: a `convinced` draft whose verify stamp is RED (typically "no worktree is at this head", because its author works on another host) is marked ready by the gate with no session woken when every REQUIRED check is settled green at its head; the stamp stays the rule when the required list could not be read, when a required check is red, running or absent from the head, and for `pr:open` without `--draft`. The tick now reads the required-check list when a green draft is open as well as when anything is red (`requiredWhenRed` is `requiredWhenNeeded`). **A deferred order is a stall**: the busy-seat deferral limit is 15 minutes (was 60), and an order deferred that long, or a standing seat's queue whose oldest order is that old, is raised to `ceo` as the `order-deferred-too-long` org-health signal (one constant, `ORDER_STALL_MINUTES`, with its measurement beside it). **The GraphQL pool**: the off-board read now asks for `viewer { login }` and `rateLimit` (never charged), and an account's pool below 20% is raised as the `api-pool-low` signal naming the account, the pool and the reset.

## 0.9.1

### Patch Changes

- cb8825d: A release of a declared package is told to the chairman in one line (package, version and the first sentence of its release notes, with the release page last), where before nothing read releases and three in 75 minutes went unheard. The watcher reads each code repository `project.json` declares; the first read of a repository records its existing releases as seen and tells none of them, and a draft or a pre-release is not told. A release with empty notes says no summary was written. This registers the `release` event kind in `event.mjs` and `core.mjs` (told once, never reminded, not silent) and admits `gh api repos/<owner>/<name>/releases` in the read-only allowlist.

## 0.9.0

### Minor Changes

- 1c7f588: The chairman's chat messages are now queued for `liaison` and for no other session (`RECIPIENT`; the scan over `src/messaging/` still finds one caller and one label, and `ceo` is named nowhere in `converse.mjs`). The chairman is told `Got it, looking.` BEFORE the queue is written, in the same words each time and with no model in it; a refused queue, an absent seat or an entry not found in the queue file is told in words (`I could not reach the liaison: <the queue's refusal, verbatim>. Nothing has been done with your message.`), with no fallback to `ceo`. The handoff id stays in the ledger and no longer reaches the chat, and the ledger's inbound line gains `ackAt`. `provenanceText` no longer tells its reader not to answer with `prompt:session`: that is the liaison's brief (a11ign/a11ign#3416). Not to be merged-and-deployed on a host without the liaison seat running (#3415, E2).

## 0.8.5

### Patch Changes

- 8460e7c: `chairman:reply`'s closed vocabulary gains four checked facts for the liaison: `{{fleet.workers-up}}` and `{{fleet.workers-down}}` (worker NAMES only, from the two files `fleet-watch` writes, refused when either is more than 130 minutes old or the roster is empty), `{{gate.last-tick.age}}` (the tick's completion record) and `{{release:OWNER/REPO.latest}}` (the newest published release). Each is stamped by the send's `as of`, a failed read refuses the send and names which, and `PLACEHOLDER_NAMES` exports the list so the liaison's brief can be tested against it. `createGhReaders` takes the file paths from its host; `chairman:reply` does not pass them yet, so the fleet and gate placeholders refuse there until it does (a11ign/a11ign#3420).

## 0.8.4

### Patch Changes

- 2e3d335: The chairman's inbound classifier no longer forwards a credential typed in plain words. `My password is: <value>` was forwarded, written to the handoff queue and reply-quoted in the acknowledgement, because the one key-then-value pattern needed whitespace straight after `is` and the colon ended it; `pw: X`, `here's my password X`, `my password X` and a bare pasted token passed the same way. A credential word (`password`, `passwd`, `passphrase`, `pw`, `pwd`, `secret`, `api key`, `private key`, `credentials`, and the weaker `pass`, `pin`, `token`, `login`) with a value beside it after `is`, `was`, `are`, `:`, `=`, `-`, `->` or whitespace, and the value-first form (`<value> is my password`), are now dropped; so is `ASIA` (temporary AWS) beside the shapes the ledger's redactor already held. A git object name (40 or 64 hex digits) and a lowercase hyphenated slug (a branch name) are no longer dropped by the 32-character catch-all, which took both. A new `withhold` verdict covers one 16+ character token that mixes three of lower, upper, digit and symbol: it is handled as a drop (deleted from the chat, no hash in its ledger line), the chairman is told "That looks like a credential, so I haven't passed it on; send it again with 'not a secret' if it isn't", and a resend containing `not a secret` passes this tier only, never a definite shape. A drop or a withhold is sent without `replyTo` (it already was; a test now pins it), so the chat does not render the message above the reply.

## 0.8.3

### Patch Changes

- 9d12c24: A request alert reaches the chairman as a brief and not as a ticket with a header: the message opens with `What is happening:` and carries `Ask`, `Only you because`, `Checked`, `How long` and `Unblocks`, the row's number and title appear nowhere in it, and the link is its last line. A brief that offers options (a `chairman-options` block, well-formed or not) must also carry `Recommend` and `Trade-off`; one that offers none must carry `Not the chairman's Claude session because`. A brief missing a required line is refused as before (`alert not sent:`, naming each missing label, logged once). The ledger's `text` field now holds the message as sent, link included (a11ign/a11ign#3412).

## 0.8.2

### Patch Changes

- 50ab14b: `createReaders` gains `readFixRow(key)`, so the `Doing` line of a SENT incident or stall can name the open row that holds the fix instead of reading `not known`. A fix row says which incident it fixes by a label named for the event key (`incident:trunk-red`, `stall:no-merge`), and the holder is its `session:<name>` label. The reader returns `null` only when GitHub answered and no open row carries the label, and throws when it could not be asked (a11ign/a11ign#3439, follows #3424).

## 0.8.1

### Patch Changes

- bf64d78: A SENT `incident:` or `stall:` event now carries two more lines after what started: **Impact** (a fixed table keyed by the event's own key: `Nothing can merge.`, `No worker can be woken.`, `Captures are paused.` and so on, `not known` for a key with no entry) and **Doing** (read once through the optional `readFixRow(key)` reader: the open row and its holder, `no row is open for this yet` only when the reader says `null`, and `not known` when the reader is not wired, throws or returns a non-row). The "cleared" text, the event's key, `firstSeenAt` and the core's hold-down and dedupe are unchanged, and a failed fix-row read never withholds the event. `readFixRow` is not wired in `readers.mjs` yet, so Doing reads `not known` until it is (a11ign/a11ign#3424).

## 0.8.0

### Minor Changes

- d055e5c: `messaging:measure` reads how fast the org acknowledges and answers the chairman from the delivery ledger, for a window (`--window=<n>h`, default 24h): per message from the chairman, seconds to acknowledge and seconds to the first reply that names it (or `unanswered`), and asks sent, answered by the chairman, withdrawn (cleared with no answer before it) and refused by the brief rule. It writes nothing and judges nothing; a window with no lines prints `no messages in the window`, never a zero rate. `chairman:reply --to <messageRef>` (the flag was `--reply-to`) now refuses a ref no inbound ledger line holds, so a reply's `replyTo` always names a message that exists; without it `replyTo` is still `null`, and such a reply answers no message in the reading.

## 0.7.9

### Patch Changes

- a8d857e: A claim that names no branch and no worktree (a host act, a fleet or lab reading, a hand-claim) now writes its own claim record, `Claimed-nothing: <reason>` under the marker, instead of nothing. The stall check used to skip such a claim with `claim-stall: #N carries session:S but no claim record names when or where -- not evaluated` on every tick, so an abandoned one could not be told from a live one; it now reads the record's own time and the claimant's comments like any claim, and the nudge applies. A claim with no git object is never released by the stall check: a stalled one stays `nudged`, and the blockedBy and gone-holder releases ("holds nothing built") leave it held. A release is still spelled `released by` with no field, so the two never share a spelling, and releasing a nothing-claim posts the release record so a later claim that wrote nothing does not inherit the old one's time (a11ign/a11ign#3407).
- 31a5608: The daily summary is opt-in and an absent `messaging.summary` means off (chairman, 2026-10-04: "the chairman does not want a daily message"; a11ign/a11ign#3410). It had defaulted to 08:00 London, so a host that never declared one sent `summary:2026-10-03` and `summary:2026-10-04`. `parseMessagingConfig` now returns `summary: null` for an absent key and `runWatch` then constructs no summary source, so nothing is read for it and nothing is sent; a present key (`summary: {}` included, which takes `DEFAULT_SUMMARY`'s fields) works as before, and a malformed one is still refused. `messaging:check` says `no daily summary` rather than a time. `DEFAULT_SUMMARY` is now the field defaults of a declared summary and no longer a default for an absent one.

## 0.7.8

### Patch Changes

- 7105923: The isolation gate's copy skips an `@a11ign/*` dependency that has no sibling directory when it is spelled as a caret or tilde range (`^0.1.0`, `~0.1.0`), because that is how a package consumes one published from another repository and npm fetches it from the registry; a sibling that exists is still packed, and any other spelling with no sibling still fails. This matches the original, which `agent-org-wiring.test.ts` compares (a11ign/a11ign#3403, move 6 of #69).

## 0.7.7

### Patch Changes

- 801ec25: A row labelled `needs:chairman` whose newest chairman-side event (a comment by the chairman's own login, or an answer comment opening with the messaging provenance line) is newer than its newest `labeled` event now orders `ceo` (`chairman-answered`) to take the label off or re-ask, keyed on the row and the event's time so it fires once per new event. Two REST calls per labelled row and none when nothing carries the label; a row whose timeline could not be read is reported on stderr, never counted as unanswered (a11ign/a11ign#3390).

## 0.7.6

### Patch Changes

- 279a54c: The call-count signal leaves out a claimed row that declares a wait (`needs:chairman`, `answer:<session>`, a `blockedBy` edge, a future `Not-before:`, `parked`, `blocked`, `hold:*`), and counts a row whose wait has been lifted from the lifting rather than from the claim, so a standing seat's work elsewhere during the wait is not charged to the row. The lifting is read once, from the row's events, for a row already over the threshold, and a refused read keeps the whole window and says so on stderr (a11ign/a11ign#3384).

## 0.7.5

### Patch Changes

- 61af713: A keyed repository's dependency change no longer costs a reviewer. When the clone's `node_modules` lacks a package the pull request's `package.json` declares, the tick installs into the REVIEW TREE (`pnpm install --frozen-lockfile --ignore-scripts` when the tree has a lockfile, `--no-lockfile` when it has none) instead of refusing; the shared clone is never written. When that install fails the refusal names the first line of pnpm's failure and a hand remedy that works over a clone that already has a `node_modules`: `rm -rf <clone>/node_modules && cp -a <tree>/node_modules <clone>/node_modules`. The old `mv <tree>/node_modules <clone>/node_modules` moved the tree's directory INTO an existing one (`node_modules/node_modules`) and left every package missing.

## 0.7.4

### Patch Changes

- 8f1813f: A `sent` ledger line records `silent`, the flag the provider says it APPLIED (a boolean, or `null` when the provider returned none), so "was the summary silent" is answerable from `ledger.jsonl` and no longer only from a reading of the code path (a11ign/a11ign#3385, found closing #2905). It is the applied flag and not the requested one: a provider that drops `silent` records `false`. Lines already written carry no key and stay so.

## 0.7.3

### Patch Changes

- 00c26a8: The work gate lifts a pull request's `hold:*` itself when every `Waiting-for:` it declares is `merged` or `closed` and true, through `pr-hold.mjs --release` (which re-arms a pull request that carried `rearm-on-release`), instead of ordering a possibly busy session to remove one label. A hold on a row, a label or unreadable condition, `manual`, an `answer:*` and `blocked` stay with a session, and a release that fails falls back to the old order (a11ign/a11ign#3364).

## 0.7.2

### Patch Changes

- 0b02579: `src/merge-guard/merge-ref-staleness-rule.mjs` is deleted, with its test: `fetchMergeRefBehindBy` ran `git fetch origin pull/N/merge`, `rev-parse` and `rev-list` with no `cwd`, so a caller on the tick would have read the tool's own checkout instead of the project's, and nothing called it. `mergeRefIsStale` and `mergeRefStalenessReason` had no caller either (`git grep` at `origin/main` found only the module's own test), so they go too rather than wait for one. (a11ign/a11ign#3367)
- 95e907f: `pr:open create ...` and `pr:edit edit ...` no longer reach `gh` as `gh pr create create` (a11ign/a11ign#3357). The command table already supplies the mode (`FIXED_ARGS`), and the program's own usage text spells it, so an author following the usage text lost a turn to a failure that said "nothing was created". `planInvocation` now drops a leading repeat of the table's fixed arguments, so `pr:open --title ...` and `pr:open create --title ...` are the same command; a `create` later in the arguments (a title) is left alone.

## 0.7.1

### Patch Changes

- e29309d: The gate compares a row with the whole of a pull request of more than 100 files instead of dropping it: `gh pr list --json files` returns the first 100 and `comparablePrFiles` refuses a short list, so a row overlapping the 146-file version PR was offered every tick and refused at the spawn (30 ticks, 2026-10-03). `readPrs` now pages a truncated PR's files through REST, as the claim does, caches the list by PR number and head sha in the state directory (`truncated-pr-files.json`, newest 20), and, when paging fails, leaves the PR out of the comparison as before and says so on stderr.

## 0.7.0

### Minor Changes

- d11317e: A pull request is marked ready only on a green verify stamp for its head (a11ign/a11ign#3215). `pr:open` refuses a create WITHOUT `--draft` when the project's `verify --check` is not green for this head and this body, naming the reasons and the command that makes it green; a draft opens on a passing body alone. The gate's `gh pr ready` after a `convinced` verdict is withheld on the same reading, and the author (not `product-manager`) is told once per patch. The stamp is read through the project's own script, never re-run: a project declares verify by having a `verify` script in `package.json`, and answers `--check [--draft-body=<file>]` with exit 0 or 1 and `  - <reason>` lines. **A project with no `verify` script is not refused**, and `pr:open` says `no verify declared for <name>`. `main` takes the reading as a `verifyStamp` dependency wired in the entry block, so a caller of `main` is unchanged.

## 0.6.1

### Patch Changes

- 113e15e: A refused chairman alert is logged as `alert not sent: …`, no longer under the `chairman-options:` prefix: `messaging:watch` prefixed every request problem with it, so the refusal added in #122 was filed under the name of the malformed options block and a grep for options problems found refusals too. A request problem now names itself where it is made (`requestEvent`), and the watcher adds nothing. A malformed options block is still logged as `chairman-options: …`, and the ledger's note carries the same text.

## 0.6.0

### Minor Changes

- 422f9a2: A `needs:chairman` alert states the act, or is not sent (a11ign/a11ign#3335). The alert is the row title plus three lines read from the newest org brief on the row (`brief for the chairman` from an OWNER, MEMBER or COLLABORATOR): `Ask:` (the one-line act), `Only you because:` (why no session can do it) and `Checked:` (what was read just before the label went on, and when, that shows the act is not already done). A row with the label and no such brief, or a brief missing any of the three, sends nothing; the reason names the missing lines and goes through the same note channel as a malformed `chairman-options` block (written to the ledger once per distinct reason, and logged). The row stays labelled, so a refusal is never read as the label going and nothing "Cleared" is sent for it. **A project that pins this tag must have its sessions write the three lines in the brief**, or its chairman alerts stop; the first line of the brief is no longer quoted, since `Ask:` replaces it. `Checked:` is a claim the source cannot re-read. The `chairman-options` block is unchanged.

## 0.5.0

### Minor Changes

- de971e0: `row-file --board=<n> --lane=<owner> [--session=<name>]` boards a row that already exists (a11ign/a11ign#3330, for #3328's sweep of `regression` rows filed under `github.token`, which cannot resolve Project 1). An OPEN row on no board gets the Project item, Status Ready, then `ready` and `lane:<owner>` ADDED beside the labels it carries, and the read-back confirms all three. A row already on the board in any Status is left alone (exit 0, says so); a closed row, a claimed row, a body `--promote` would refuse, an unreadable board status and an unknown lane each change nothing and exit 1. `--board=` takes no flag but `--lane=` and `--session=`, and a malformed value never falls through to filing. `boardAndVerify` gained `session: null` (skip the Filed-by read-back for a row somebody else filed) and `lead` (its refusals no longer say "FILED as #n" of a row that already existed).

## 0.4.2

### Patch Changes

- e3da32f: The whole-suite resolver follows a script's delegation through the project's pnpm passthrough, `node scripts/pnpm.mjs run <script>`, as well as `pnpm run <script>` (a11ign/a11ign#3151). It matched only the second, so a project whose `test` script chains through the passthrough (to run on a box with `corepack pnpm` and no `pnpm` on PATH) resolved `test` to no `*.test.ts` glob and refused every whole-suite acceptance. The passthrough is recognised by its file name, `pnpm.mjs`; a runner of any other name is not followed.

## 0.4.1

### Patch Changes

- 814c4a9: The reviewers' verdict door resolves and is kept current (a11ign/a11ign#3316, found on #3311). Orders now print `$HOME/reviewer/bin/pr-review-verdict`, the path `install-reviewer-bin.sh` writes to, because `~/reviewer/bin` is on no PATH and the bare name was `command not found` for a reviewer that had finished its review. `host:check` reads the installed door against the shipped one and reports it `DRIFTED` or `NOT INSTALLED` (a clean report says `CURRENT`), and `host:install` runs the installer, which keeps the previous copy as `.bak-<stamp>` and reads the install back byte for byte.

## 0.4.0

### Minor Changes

- f25625f: `MUTATION: MISSING` is a printed line and no longer fails (a11ign/a11ign#3282, decided on #3213). `mutationRecordReport` returns `ok: true` for a diff that changes a test with no `Mutation:` record, so CI's acceptance job and `pr:open` print the omission and go on; a DUPLICATE `Mutation:` header still fails, being a body the parser cannot read as one record. The project posts the survivors of a machine-chosen mutant set as a pull request comment instead.

## 0.3.1

### Patch Changes

- d0a77c2: A keyed repository's first review's refusals each name something that works. When the clone has no `package.json` (the repository's first pull request adds it), the missing-dependency refusal no longer names `pnpm install` there, which answers `ERR_PNPM_NO_PKG_MANIFEST`: it names the install in the review tree and the move of its `node_modules` into the clone, and a clone with a manifest reads as before. A keyed reviewer herdr refuses with `blocked during startup` whose clone has no `trust_level = "trusted"` entry in the reviewer's codex config now says so, naming the file and the `[projects."<clone>"]` entry to add; any other refusal keeps its text.

## 0.3.0

### Minor Changes

- c3d33b3: A lane marked `reviewOnly` in the project's lanes file protects its owner's REVIEW, not authorship (a11ign/a11ign#3254, #1756 Ruling item 7). `row-file` derives no `lane:<owner>` label from such a lane, so a path-only pipeline row is filed `lane:any` and an engineer can claim it; a Region that also touches another lane keeps that lane's label, and `lane:<owner>` for a genuine decision is still set by hand. And the owner's own login (`ROLE_LOGIN`, `ceo` is `a11ign-ai-leads`) may no longer author or arm a pull request touching the lane: `arm-pr` exits `REFUSED` without arming, `auto-arm-sweep` skips it so it cannot undo that one job later, and `pr-open create` refuses before anything is sent. There is no override and no `Lane-exception:` form. A lane without the field behaves exactly as before.

## 0.2.5

### Patch Changes

- d398f12: The tick's `N order(s) had nowhere to go` summary no longer counts a Ready row that is only waiting for a free engineer seat (a11ign/a11ign#3266). A `ready-row-unclaimed` offer refused because every seat in the roster is `working` or holds its one row (#2407), with or without the `MAX_SPAWNS_PER_TICK` tail, is written `DEFERRED ... (waiting <m> min; retried next tick)` and does not make the tick exit 1, as a seat mid-turn already was (#3029). Past `CAPACITY_WAIT_LIMIT_MS` (30 minutes, sized from the 67 capacity waits of 2026-10-01 to 2026-10-03 that ended in a claim: longest 13) it is `UNDELIVERED` with its age. A roster with an idle, drained, B2-skipped, `unknown`, `absent` or `blocked` seat, or a `; no spawn:` fault, is still `UNDELIVERED`, and `org-retro`'s idle-minutes figure counts both forms.

## 0.2.4

### Patch Changes

- 099e59a: `pr:open` and `pr:edit` now run every report CI's acceptance job runs over a body (a11ign/a11ign#3209). `checkBody` composed two (Acceptance, Closes) while the CI entry composed four, so a body with no `Mutation:` record, or a `## Measured` section with no command and output, passed `pr:open` and went red in CI (8 of 9 sampled acceptance failures were `MUTATION: MISSING`). The four are now one exported list, `CI_BODY_REPORTS`, run by `runCiBodyReports` from both the CLI entry and `checkBody`, so a fifth report reaches `pr:open` with no second edit. The diff `mutationRecordReport` needs is read from the local tree with `ACMR` and `--no-renames`, as CI reads it; one that cannot be read is `UNCHECKED` and not a refusal. The acceptance report's whole-suite NOTE now prints from `pr:open` too, because it is part of what CI prints.

## 0.2.3

### Patch Changes

- d599a63: The tick's review tree links each package under the name its `package.json` declares, not its directory's: `@a11ign/x` lands in `node_modules/@a11ign/x` and an unscoped package such as `a11ign` directly in `node_modules/`, so a reviewer's Acceptance can import a renamed package. An entry with no readable manifest is skipped, the unscoped link is the tree's own and never the checkout's, and a link whose package was removed or renamed is removed.

## 0.2.2

### Patch Changes

- ffc165d: A refusal posted for a failing check no longer dead-ends the pull request once the check is green at an equal patch (a11ign/a11ign#3199, from #3154). A verdict is valid for a patch on a base, and the patch id cannot see a defect in the base: when a `CHANGES_REQUESTED` was posted at a commit with a failing check run and the head has none, the reviewer door (`pr-review-verdict`) posts a newer review of either state, and the gate stops reading the refusal as the pull request's verdict, so the reviewer seat is asked for a fresh look instead of the author being told the rework is theirs. One decider, `refusalLifted`, reads check-run conclusions (never the review's prose) for both; an approval, an all-green refused commit, a failing head and an unreadable check all stay refused. The extra reads happen only on the equal-patch refusal path, one check-runs read per commit compared.

## 0.2.1

### Patch Changes

- e8ca25c: A merge to `main` that carries a changeset is tagged and released with no version pull request: `release.yml` builds a release commit on top of the merge (the last tag's version and changelog, the changesets that tag already consumed removed, `changeset version` over the rest) and pushes it as the tag. `main`'s own `package.json` version and `CHANGELOG.md` lag the last tag, and a project pins the tag's tree.

## 0.2.0

### Minor Changes

- 6123fab: `agent-org dora` measures the four DORA metrics (deployment frequency, lead time for changes, change failure rate, time to restore) for each repository the project declares, from the npm registry or a repository's GitHub Releases, its merged pull requests, its `regression` rows and git ancestry, and never from the org's own state. The daily retrospective carries the block and trends each number against the previous reading. A source that cannot be read is `unknown`, a metric with nothing to measure is `undefined`, and neither is ever 0. `.agent-org/project.json` gains an optional `dora` list (`repo`, `release: { kind: "npm", package } | { kind: "tag" }`, `releasablePaths`).

### Patch Changes

- 071fb5c: `agent-org dora` reads a declared repository with no release yet as `no release yet`, not `unknown`: an npm package the registry answers 404 for (never published, told from a network error), a repository with no release and no merged pull request, and a repository whose issues are disabled (no `regression` rows can exist) are answers rather than refusals, while a reader that throws is still `unknown`. The reading also says which npm package it reads: one per repository, so a release of another package in the same repository is not a deployment.
- a1a9070: The work gate tells a pull request's owner when a required check has been running for more than an hour on a non-draft pull request: it used to be classified `progressing` for as long as it ran, and a check that hangs never stops, so a pull request held for review sat four hours with nobody told. The new stall reason `hung-check` is read from the `startedAt` the gate already has (no new API call, no timer), is keyed on that start so a re-run that hangs again is a new order, and is filed under `pr-checks-failing`.
- cf0a47a: A keyed review checkout is refused, not handed over, when the repository's clone lacks a package the pull request's `package.json` declares: the reviewer used to start on a tree that could not run its tests and die on `ERR_MODULE_NOT_FOUND`. The refusal names the missing packages and the `pnpm install --no-lockfile` that supplies them. `package.json` now declares the three packages the tests need (`tsx`, `yaml`, `typescript`) as `devDependencies`.
- 52017dc: `pr:open` run from another repository's worktree without `--repo` now says so on its Region refusal: it read the tree as the first repository's and refused the row's own paths in words that never named the flag, and the remedy it did print (`Outside-Region:` lines) led a session to write false statements into the PR body. The refusal names `--repo <repo>` when `origin` is a code repository the project declares. A Region path written with a trailing parenthetical (`agent-org:src/x.test.ts (new)`) is now read as the path, as `#3134` was filed.
- f852707: `messaging:watch` can now send: the Telegram provider is registered in its default `providers`, built from the token file and the chairman file the `messaging` key names. It was written and never registered, so every run exited 1 with "no implementation of it yet" and the `chairman-watch` unit never sent the chairman anything; every test injected its own provider, so none could see it. A token file at the wrong mode, or a checkout never paired, now ends the run with a line naming that file and exit 1, with no stack trace and no secret. `main` takes an injectable `fetch`, and a provider factory is called with `(config, { fetch, log })`.
- 681637d: The release workflow's version pull request step now fails when `gh pr create` fails. It piped `gh pr create` into `tee` under the runner's default `bash -e`, which has no `pipefail`, so the pipeline took `tee`'s status and a pull request that could not be opened (`GitHub Actions is not permitted to create or approve pull requests`) left the job `success` on four runs. The URL is captured first and then printed. `release-safety.test.ts` ran the steps under `bash -eo pipefail`, stricter than the platform, and so could not see it: it now runs them under `bash -e` and asserts the shell is not `pipefail`.
- 3db20b5: Every remedy, order and usage line the tool prints says `pnpm run ...` where it said `npm run ...` (and `pnpm exec` where it said `npx`), with the `--` dropped because pnpm hands a literal `--` to the script. `host:check` now reports a `pnpm` that is not on the PATH, or whose version differs from the project's `packageManager`, as a finding that `host:install` does not fix. An acceptance written `pnpm test` or `pnpm run test:all` is recognised as the whole-suite form, as `npm`'s spelling always was, and a release-gate record written by `pnpm run` (whose script banner carries the working directory) is read as the stage it names.
- 256e423: A Telegram send whose `fetch` rejects (no response at all) is now a `TelegramSendError` like every other failed send, so it is logged, and on part 2 or later of a split message it says how many parts WERE delivered; it used to pass through unannotated and unlogged, and the core's whole-message retry then sent the chairman a duplicate with no stated cause. Every request now has a 30-second deadline (`deadline`, injectable like `sleep`), after which it is abandoned and reported as a failure rather than holding the send until the process is killed.
- 0746122: The `row-branch-unshipped` order no longer tells `product-manager` to "open its pull request" or "delete the branch" for a row whose branch already carries an OPEN pull request (the second closes it). It names the PR and the `claim --adopt=<previous holder>` route that finishes it, read off the open-PR list the tick already holds, so no API pool is spent. A branch with no open PR gets the order it always did. `claim`'s own refusal of a row whose branch is on `origin` (#2014) is unchanged.

## 0.1.0

### Minor Changes

- First release: agent-org installs as a git dependency (`github:a11ign/agent-org#semver:^0.1.0`) and serves the repository it is run in, with a `bin`, a command table and no registry.
