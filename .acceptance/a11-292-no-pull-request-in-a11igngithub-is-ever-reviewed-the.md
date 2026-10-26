A reviewer of a declared repository whose name starts with a dot (`a11ign/.github`, key `github`) is checked out from the clone the host lists under the repository's name (`clones[".github"]`), and `agent-org doctor` fails any declared repository whose key does not survive a reviewer's label or that has no clone under its key or its name.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/dotted-repo-review.test.ts src/packaging/keyed-repo-review.test.ts plugins/atomic-reviewer/dotted-repository.test.ts src/install/doctor.test.ts
```

Consumer-declaration: none -- no existing host file changes meaning. A clone listed under its key is found first, as before; the repository's name is asked only when the key finds nothing.
