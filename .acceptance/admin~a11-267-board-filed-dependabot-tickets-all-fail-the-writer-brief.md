A ticket the board asks the writer for on its own is filed and ends Done. The dependency sweep sets the team of its epic A11-251 on the writer run and in the request. The writer brief has one ordered Team rule for every run (the request's team, else the form's parent; `tickets.pick`; the workspace's only team; else needs-human). The Stop hook judges a new-ticket run by the writer's outcomes, so `created` is accepted for a writer and still refused for a ticket worker.

Acceptance:
```bash
# The stop hook: a writer's created (and decided, and needs-human) is allowed, a worker's created and a writer's working are refused, the refusal is bounded.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/hook-writer-stop.test.ts
# The brief's Team rule for each fallback, on a host with pick: null, and the same words for every run.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/worker-files.test.ts
# The sweep's request carries the epic's team, asks for nothing while the epic is unreadable, and the run it queues reaches the brief and ends Done.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/dependency-updates/sweep.test.ts src/ticket-mode/dependency-updates/ticket-request.test.ts src/ticket-mode/pool.test.ts
```
Run with `AGENT_ORG_HOST` naming a host declaration, as CI's `suite` job does (the fixture project copied to a temporary directory), and with a stand-in `tailscale` first on `PATH` until A11-279 lands.

After merge, on the agents host once the release is installed and the board restarted: `jq -e '.tickets["a11ign/a11ign:transformers@5"].ticket=="A11-262" and .tickets["a11ign/a11ign:@anthropic-ai/sdk@1"].ticket=="A11-265"' ~/.local/state/agent-org/tickets/dependency-tickets.json` holds, then the `failed` entries are dropped from that file while the board is stopped (`jq '.tickets |= with_entries(select(.value.state != "failed"))'`), and after the next sweeps `[.tickets[] | select(.state=="failed")] | length == 0` and no `filed` ticket key is used by two entries.

Consumer-declaration: none -- `WriterRun.team` is read only by `pool-start.ts`, and `teamRule` only by `writerBriefText`.
