Doctor's `merge flow` row lists every repository without the merge flow, whatever names it (A11-274, step 4 of 4). It lists each organisation that owns a clone of the host in one paginated GraphQL read as the workers' account (`readOrganisationFlows`, `plugins/github/merge-flow.ts`, 11 rate-limit points a page of 100). So a repository no clone, `code` list or file names is read too, and fails until it is set up. An archived repository is passed over. An owner that is a person's account is never listed. A cloned repository the listing does not hold (a person's, one moved to another owner, or any of an organisation that could not be listed) is read by its own name (`readRepositoryFlows`). A repository has the flow when it allows auto-merge, holds `.github/workflows/auto-arm.yml`, and has an active ruleset with a merge queue that requires `gate`. A private one also passes with the merge bot, as A11-291 decided. A listing or repository that cannot be read fails the row and is never a pass. Run from a checkout, `node plugins/github/merge-flow-command.ts --owner a11ign` prints the row and exits 1 while any repository lacks the flow, 0 once none does.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/merge-flow-checks.test.ts plugins/github/merge-flow.test.ts src/install/doctor.test.ts plugins/github/index.test.ts plugins/github/stack-live-check-command.test.ts
node plugins/github/merge-flow-command.ts --owner a11ign; echo "exit $? (1 while a repository lacks the flow, 0 once none does)"
```

Consumer-declaration: none -- no command, flag or host file key changes for a project: doctor's existing `merge flow` row reads more repositories and more of each.
