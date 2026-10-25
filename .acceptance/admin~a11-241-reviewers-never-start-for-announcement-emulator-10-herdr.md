Every herdr agent name is made by one function, `herdrAgentName` (`src/herdr-agents.ts`): a name herdr accepts comes back unchanged, and a longer one is shortened to 32 characters or fewer with 8 hex characters of a hash of the full name, so `reviewer-announcement-emulator-11` is started and prompted as one agent while its workspace keeps the full label. Every `herdr agent <verb> <name>` call passes its label through it, and a refusal that herdr answers on stdout reaches the reviewer start's refusal (A11-241, step 1 of 2).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/herdr-agent-name.test.ts plugins/atomic-reviewer/long-seat-name.test.ts plugins/atomic-reviewer/port.test.ts
```
