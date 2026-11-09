The Copilot coding agent's login, `app/copilot-swe-agent` (also spelled `copilot-swe-agent[bot]`), is a declared identity in `src/review-trust.ts`, so `reviewTrustOf` reads its same-repository pull requests as INSIDE and the tickets' reviewer starts for them (a11ign/agent-org#2023). A fork is still OUTSIDE, and an App whose name merely starts with it is not declared.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/review-trust.test.ts
```

Mutation: drop `COPILOT_AGENT_LOGIN` from the `pattern` list in `declaredIdentities`, and the agent-org#2023 test fails on the first assertion.

Consumer-declaration: none -- no host file key or contract changes. One more login is declared, beside octo-sts and the dependency bots.
