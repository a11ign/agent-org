A safety prompt that Claude Code raises for a worker's subagent (headed `Bash command · from the general-purpose agent`) is declined on an unattended run the way the main agent's is: one Esc, one message to the run's agent naming the subagent, the command and the warning, and a card line that names the subagent. The reader (`src/ticket-mode/safety-prompt.ts`) was missing both prompts of Claude Code 2.1.310, the main agent's too: that version draws a bare `No` where the reader required `No ... (esc)`. A bare `No` now counts only in a tool's ruled box (a heading with a dashed rule under it), so the start dialogs and question menus stay unrecognised. The `statically-unresolvable target` warning gets the guard advice, and every unattended brief tells the worker its subagents inherit the rule, with an explicit `${VAR:?}`-guarded path and never a bare `*` after `cd`.

Acceptance:
```bash
# AGENT_ORG_HOST must name a host declaration (CI copies src/packaging/fixtures/project-tree/ and points it at its .agent-org/host.json)
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/safety-prompt.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/worker-files.test.ts src/pane-dialog.test.ts --testNamePattern "A11-174|A11-209"
```

Consumer-declaration: `declined.agent` is a new optional field on a queue entry's declined record and on the board's view of it, written by the pool and read by the card line; an entry without it is a main-agent decline, as before.
