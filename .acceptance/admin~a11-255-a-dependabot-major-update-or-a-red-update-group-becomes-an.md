Closes A11-255

The board's feedback sweeps gain one: it turns a Dependabot major update, or a Dependabot group whose `gate` stays red after one rerun, into one ticket by the writer path (`queueWriter`, a quick run of the create-ticket skill, never a worker), and queues the ticket the run made. The code host contract is 1.19 with one optional read, `openDependencyPulls(repository)`, which lists the open pull requests the dependency bot opened, filtered by author (the GitHub plugin answers it with a plain `gh pr list` and keeps the pull requests whose author is the bot). The sweep is `src/ticket-mode/dependency-updates/` (`classify.ts` sorts a pull request, `ticket-request.ts` is the ticket's template, `red-group.ts` reruns once and asks on a second red, `request.ts` and `settle.ts` ask the writer and queue its ticket, `filed.ts` is `dependency-tickets.json`), registered in `startFeedbackSweeps` in `src/ticket-mode/server.ts`.

Acceptance:
```bash
# A major creates one ticket (its request names the package, from, to, the repository, the pull request and the changelog); a repeat does not create a second (the same pull request, a new pull request of the same major, a restart); a red patch group creates one after the rerun; the edges.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/dependency-updates/sweep.test.ts src/ticket-mode/dependency-updates/classify.test.ts src/ticket-mode/dependency-updates/ticket-request.test.ts
# The code host read: the GitHub plugin asks with no search-backed flag and filters by author itself; the fake and GitHub both pass the contract suite.
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/dependency-pulls.test.ts plugins/github/conformance.test.ts src/plugins/fakes/code-host.test.ts
# The board schedules the sweep with the feedback sweeps, keeps its file beside the queue, and queues the ticket the writer made.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/server.test.ts
```
Run with `AGENT_ORG_HOST` naming a host declaration, as CI's `suite` job does (the fixture project copied to a temporary directory).

After merge, the chairman session checks the next major update arrives as a ticket: the board's log says `dependency updates: asked the ticket writer for <owner/name>:<package>@<major>`, and the ticket is in `dependency-tickets.json` beside `queue.json` as `filed`.
