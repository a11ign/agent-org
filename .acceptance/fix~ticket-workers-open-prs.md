A ticket-mode worker (`AGENT_ORG_TICKET` set) passes the host `gh` wrapper's `gh pr create` refusal, which still holds for every org workspace (`host/gh`). `agent-org ticket:review <pull request url> [--head <sha>]` starts the atomic reviewer port for one pull request, with the port's refusals (`src/ticket-mode/review-command.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/pr-open-only-creates.test.ts src/ticket-mode/review-command.test.ts
```

Consumer-declaration: none -- an org workspace's `gh pr create` is refused exactly as before; `ticket:review` only starts what the pool already starts.
