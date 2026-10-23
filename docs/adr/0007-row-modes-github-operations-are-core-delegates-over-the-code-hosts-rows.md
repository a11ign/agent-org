# Row mode's GitHub operations are core's delegates over the code host's `rows`, which core loads synchronously

## Context

ADR 0002 made row mode's GitHub operations an optional `rows` group of the codeHost contract. Step 4 of A11-160 moves them: the GitHub adapter of the ticket port (`TicketPort` over GitHub issues) and the 24 files of reads and writes that `src/ticket-port/` held, which about 70 files of row mode call from about 150 programs. Three facts shape how.

- **The callers run their own `gh`.** The gate's `defaultRun` carries a timeout, the tick's read memo and GraphQL metering, a repository aim and the call census; wake, the claim path and org-health have runners of their own. Those callers move into the plugin in steps 5 to 9 of A11-160, and an operation that spawned its own `gh` here would skip every one of those policies for the reads it replaced.
- **The loader is async and the programs are not.** `import()` is how a plugin loads, and a row-mode program is synchronous from its first line with no deps chain to carry a code host. Activating in each of the 150 entry points, or in a preload that every unit and every test that spawns a program would need, is a change as large as the move.
- **Some programs load no project.** Ticket mode on a laptop, `doctor`, `onboard` and `provider-low-confidence --question` run on a host with no project declaration, and the modules that hold the project's vocabulary and board refuse that when they load.

## Decision

1. **The operations move unchanged into `plugins/github/rows/` and are the `rows` of the codeHost contract (version 1.7).** An operation still takes the `run` its caller hands it: the caller's executor, with its policy. The plugin owns what is asked of GitHub and how its answer is read; core owns how a command is run until the caller moves. `run` is dropped from an operation when the last caller that hands one has moved.
2. **`src/ticket-port/<file>.ts` keeps a delegate of each operation, with its old name and signature, and the delegate calls the code host's `rows`.** No caller's import changed. `src/ticket-port/` holds no `gh` call, so the ratchet's exemption for it is removed and a call there is refused like any other outside the plugin. Pure values the callers use at load stay core's (`TRACKER`, `isRollUpCheck`, `WindowCutShort`).
3. **What core owns that the operations read reaches the plugin as `deps.rows`**, in two parts so a program that needs only the first does not load the second: how GitHub's rate-limit answers are read, the claim label and the error a window read throws (`rows-light-helpers.ts`, registered by `rows.ts`), and the project's vocabulary and board and how a row declares its waits (`rows-helpers.ts`, registered by `row-mode.ts`, which only the delegates whose operations read the project import).
4. **Core loads the code host for row mode by `require` when nothing activated one** (`activate-host-sync.ts`, `code-host-slot.ts`). Node 24 requires an ES module graph that has no top-level `await`, and the GitHub plugin's has none (`app-token.ts` no longer awaits its `main` at the top). It is the loader's own check and `create`, for the code host block alone, with the host file's text read by the caller; a process that activated its plugins uses that code host, and a test substitutes one.
5. **A code host with no `rows` serves ticket mode only, and a row-mode program that reaches for one is refused by name:** `row mode needs a code host that implements rows: <plugin> does not`. The fake code host has none, so the contract suite skips its checks of `rows` with the reason, and core's row-mode tests run the plugin's `rows` over their stubbed `run`.

## Why

It moves every shape and every parse out of core in one step without changing what a gate tick spends, and it leaves each later step a smaller job: a caller that moves drops its `run`, and the delegates it used go with it. Loading by `require` costs the 150 entry points nothing, and it keeps the host file the only thing that says which code host runs.

## Considered

- **Operations that spawn their own `gh`**: rejected for this step. They would bypass the gate's memo, metering and census, which changes the quota a tick spends. They are the end state, and each later step gets there for the callers it moves.
- **A top-level `await` that activates when the delegates load**: rejected. The activation's module graph holds the gate, which imports the delegates, so the load deadlocks.
- **A preload (`--import`) in every unit, in `bin.ts` and in every test that spawns a program**: rejected. A unit or a test left out fails with no code host, and the live timers are among the units.
- **A fake `rows` over an in-memory GitHub**: left for the step that gives the gate and wake their fakes. Row mode's tests are written against GitHub's own answers, and a model of GitHub that answers them is a rewrite of the suite.
- **One accessor that registers the project's helpers**: rejected. `repo-args` is reached from `onboard` and the conventions install, which run before a project exists, and `provider-low-confidence --question` reads rows with none; both would refuse at import.

## Paths

- `agent-org:plugins/github/rows/`
- `agent-org:src/plugins/`
- `agent-org:src/ticket-port/`
