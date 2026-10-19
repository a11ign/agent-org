Adds the core `max-lines-per-function` rule at error (70 counted lines, comments and blank lines skipped) to `eslint.config.ts`, and brings the 58 functions it flagged under 70 lines by moving code out of them, with no behaviour change. The one function that was 1128 lines (`createPool`) is now a 17-line wrapper over `src/ticket-mode/pool-*.ts`.

Acceptance:
```bash
npm run lint
npm run typecheck
npx eslint src scripts --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).reduce((a,r)=>a+r.messages.filter(m=>m.ruleId==="max-lines-per-function").length,0);console.log("max-lines-per-function messages:",n);process.exit(n?1:0)})'
grep -n 'max-lines-per-function' eslint.config.ts
AGENT_ORG_HOST="${AGENT_ORG_HOST:?set to a host declaration, as scripts/test-entry.ts says}" npx rstest run --config scripts/rstest/rstest.config.ts src/host-kernel.test.ts src/messaging/answers.test.ts src/messaging/asks.test.ts src/messaging/config.test.ts src/messaging/converse.test.ts src/messaging/core.test.ts src/messaging/correct.test.ts src/messaging/github-writer.test.ts src/messaging/inbound.test.ts src/messaging/listen.test.ts src/messaging/record.test.ts src/messaging/reply.test.ts
AGENT_ORG_HOST="${AGENT_ORG_HOST:?set to a host declaration, as scripts/test-entry.ts says}" npx rstest run --config scripts/rstest/rstest.config.ts src/messaging/sources/incidents.test.ts src/messaging/sources/milestones.test.ts src/messaging/sources/readers.test.ts src/messaging/sources/releases.test.ts src/messaging/sources/requests.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui-server.test.ts src/ticket-mode/reviewer-port.test.ts src/ticket-mode/linear.test.ts src/ticket-mode/remote.test.ts
```

Consumer-declaration: none -- no exported name, signature, title or assertion changed, and no config outside the rule's own line changed.
