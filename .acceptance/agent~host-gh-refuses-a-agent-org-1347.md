A reviewer's `gh` call is REFUSED when its App's token cannot be minted: non-zero exit, nothing sent, and the role, the App and the mint failure on stderr, instead of posting the review as the account (`host/gh`, `app_refuse`; the incident line is also on the ledger). Every other role keeps the fallback, and the positive control in `src/app-token.test.ts` shows it. `src/packaging/reviewer-app-role.test.ts` #955 is updated to the same ruling (agent-org#1343, ruled by `ceo`).

Acceptance:
```bash
node --test src/app-token.test.ts src/gh-identity.test.ts src/app-role-silent.test.ts
```

Consumer-declaration: none -- a host that declares no `github-apps` reviewer is unchanged; a host that declares one gets a refused review, not an approval as `a11ign-bot`, when its App's token cannot be minted.
