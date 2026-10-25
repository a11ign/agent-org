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

After merge, run by the chairman session on the agents host (the board's own host; no fleet and no other person is involved), once the release is installed. The board is stopped for the one edit, because it replaces the file whole by rename. `STATE` is the state file; a pass is every line below printing `ok` and the sweeps after it ending with no failed entry. The same commands run against a copy of the file before merge (`STATE=<copy>`; skip the `systemctl` lines), with this cleanup: `rm -f "${COPY:?}" "${COPY:?}.bak"`.

```bash
STATE=~/.local/state/agent-org/tickets/dependency-tickets.json
# 1. The two filed before the fix stay filed, and no ticket key is used by two entries (nothing is filed twice).
jq -e '.tickets["a11ign/a11ign:transformers@5"].ticket=="A11-262" and .tickets["a11ign/a11ign:@anthropic-ai/sdk@1"].ticket=="A11-265"' "$STATE" >/dev/null && echo ok-kept
jq -e '[.tickets[] | select(.state=="filed") | .ticket] | (length == (unique|length))' "$STATE" >/dev/null && echo ok-unique
# 2. Drop only the failed entries, writing the file back (a backup first, then the new file moved over it).
cp "$STATE" "$STATE.bak" && jq '.tickets |= with_entries(select(.value.state != "failed"))' "$STATE.bak" > "$STATE.next" && mv "$STATE.next" "$STATE"
jq -e '[.tickets[] | select(.state=="failed")] | length == 0' "$STATE" >/dev/null && echo ok-cleared
jq -e '.tickets["a11ign/a11ign:transformers@5"].ticket=="A11-262" and .tickets["a11ign/a11ign:@anthropic-ai/sdk@1"].ticket=="A11-265"' "$STATE" >/dev/null && echo ok-still-kept
# 3. After the next sweeps (the board restarted): the remaining majors and red groups are filed with no failed entry, and none twice.
jq -e '[.tickets[] | select(.state=="failed")] | length == 0' "$STATE" >/dev/null && echo ok-no-failed
jq -e '[.tickets[] | select(.state=="filed") | .ticket] | (length == (unique|length))' "$STATE" >/dev/null && echo ok-no-duplicates
```

Consumer-declaration: none -- `WriterRun.team` is read only by `pool-start.ts`, and `teamRule` only by `writerBriefText`.
