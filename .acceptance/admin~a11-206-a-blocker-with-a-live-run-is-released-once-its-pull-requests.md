A blocker whose ticket has a live run (queued, planning, running, parked on a question, or in a review round) holds the run it blocks, whatever its pull requests so far did, and the card says why, such as "Waits for A11-183 (running)". A blocker whose merged pull request declared `Partial:` holds until a pull request with the closing keyword merges or the ticket is Done. A merged pull request whose body the tracker sweep has not read yet holds the run for one sweep. A11-154's rule stays for the case it was written for: no live run, every pull request merged and read as complete, and the run goes even with the ticket In Progress. The tracker's Done and the canceled/duplicate refusal are unchanged.

Acceptance:
```bash
# AGENT_ORG_HOST must name a host declaration (CI copies src/packaging/fixtures/project-tree/ and points it at its .agent-org/host.json)
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/board-view.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/queue.test.ts --testNamePattern "A11-206|A11-154|A11-77|A11-116"
```

Consumer-declaration: `blockersDeclared` is a new optional field on a queued run, written by the tracker sweep and read by the board's blocker check; a queue file written before it has none, and its merged blocker pull requests are read on the next sweep.
