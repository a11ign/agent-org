# The board, the health and retro readings, the DORA reader, the trace and the chairman's watch are named operations of the code host's `rows`, and a caller that runs `gh` itself asks the code host for a runner with its policy

## Context

ADRs 0007 to 0010 moved the ticket port's operations, the callers that arm, guard and queue a merge, the work gate, and wake, the claim and the filing of rows. Step 8 of A11-160 moves the callers that READ GitHub to report on it, or post a report to it: the board (`src/board-*.ts`: the issue listing, the edition as a Discussion, the PDF as a draft release, the report's flow readings, the schedule's liveness, the summary check, the truth audit and the board snapshot), the org-health sweep readings (`src/org-health/sweep-readings.ts`), the org retro (`src/org-retro/`), the DORA reader (`src/dora.ts`), the trace (`src/trace/`), the chairman's watch and answers (`src/messaging/`) and the tmp prune. They are 24 files of the baseline, and they differ from the earlier steps in one way.

- **Most of them START `gh` themselves**, with a policy of their own: the board's `gh` runs in the checkout, with the git variables of a hook taken off, 32 MiB of buffer and the leak guard (#1053); the truth audit allows 256 MiB; the retro cuts a read at its bound and throws away stderr; the DORA reader cuts every call at what is left of a repository's read budget; the trace posts a body on standard input and reads a `304` off the status line; the chairman's watch runs `gh` as a promise behind a read-only allowlist. Earlier steps' callers were handed a `run` and the code host ran `gh` itself; these held a spawn and a policy together.

## Decision

1. **Each question these callers ask of GitHub is a named operation of the code host's `rows` (contract 1.11).** Five sections of the contract, by caller: the trace, the chairman's watch and answers, the health and retro readings, the DORA reader, the board. Each takes the `run` its caller hands it, builds the argument list the caller built and reads the answer as it did, throwing, or answering `null` where its name says so; what the caller DECIDES (a refused read is `unknown` and never zero, a page that stops advancing is a refusal, a release that is published is not replaced) stays in core. The board's GraphQL documents moved into the plugin with their reasons (`plugins/github/rows/board-rows.ts`), because a document is GitHub's language.
2. **A caller that runs `gh` asks the code host for a runner with its policy.** `runnerWith(request)`, `asyncRunnerWith(request)`: where it runs (`cwd`), how long it may take, how much it may print, whether a hook's git variables are taken off, whether stderr goes through, and a `guard` that refuses an argument list before a process is started. The guard is CORE's rule applied to what the operations build: the leak guard of the board, the read-only allowlist of the chairman's watch. The process is the plugin's (`plugins/github/rows/runners.ts`, over `deps.exec`, and over the new `deps.execAsync` for the chairman's listener, which must not hold the process still while GitHub answers). `rows.command` names the program core's leak guard judges argument lists under, so core does not spell it. Two operations start a program of their own, because their caller needs a thing no runner offers: `commentOnRowByInput` (a body on standard input, not in an argument list) and `conditionalGetOf` (a GET whose response headers are read by the caller; it never throws).
3. **The tests of these callers use the fake.** The fake code host's world models what they read (`FakeRowsWorld.reports`, one piece per group: `board`, `health`, `dora`, `trace`, `messaging`, `snapshot`): rows, comments and their commenters' association, the label history, pull requests, the project's items, workflow runs, releases, Discussions. Where the answer is GitHub's own text (a conditional GET's status line, a timeline page), the fake throws by name and the test is the plugin's. A test of what an operation sends, or how it reads GitHub's answer, is the plugin's (`plugins/github/rows/*.test.ts`).
4. **Nothing in these 24 files names `gh` as a command.** The baseline of `docs/gh-call-baseline.json` loses all 24 and rises nowhere. The three timers that still ran row-era code (`a11ign-trace-ingest`, `a11ign-trace-publish`, `a11ign-tmp-prune`) run these files directly with `node`, not through `bin.ts`: they reach the code host through the accessor that loads the host's code host on its own, so the acceptance block runs each of the three entries once over a stub `gh`.

## Why

It takes every `gh` argument list, every GraphQL document and every parse of GitHub's answer out of the board, the readings, the trace and the watch without moving their decisions into a package that cannot import them (the plugin imports core's types only, ADR 0001), and without changing a command the live org sends: the runner keeps the directory, the buffer, the bound and the guard each caller had. A generic `gh(args)` in the contract would have left GitHub's command language in core and the ratchet counting its arguments; a runner with a policy leaves only the policy in core.

## Considered

- **A `run(program, args)` that core's callers keep, with the code host naming the program** (`argumentsRunOf`, ADR 0010): rejected for these callers. Their defaults ARE the spawn (`execFileSync("gh", ...)`); naming the program from the plugin and spawning it from core would leave the spawn in core and only hide it from the ratchet.
- **Moving the chairman's read-only allowlist (`assertReadOnlyGh`) into the plugin**: not this step. It is the watch's rule about what it may ask, written over argument lists, and it applies to the runner the operations are given; A11-162 moves the messaging code and takes it with it.
- **Keeping `ghJson` and the retro's `read` seam as they were, parsed JSON in and out**: kept. The retro's `read` is its own abstraction (a refused read is `null`, a tally of reads is kept); the operations take `runThrough(read)`.

## Paths

- `agent-org:plugins/github/rows/`
- `agent-org:src/plugins/`
- `agent-org:src/board-data.ts`
- `agent-org:src/dora.ts`
- `agent-org:src/trace/`
- `agent-org:src/messaging/`
