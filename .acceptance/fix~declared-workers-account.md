`declaredIdentities` in `src/review-trust.ts` reads the workers' and leads' accounts from their `gh` config directories (`<dir>/gh`), so a same-repository pull request by the workers' account is INSIDE and a stranger's stays OUTSIDE.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/review-trust.test.ts
```

Consumer-declaration: none -- only an account the host already declares in a role's `gh` directory becomes INSIDE; every other login is read as before.
