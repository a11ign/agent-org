The After-merge comment poster finds a Linear ticket whether or not Linear has archived it (A11-209 was archived on 2026-10-25), and a lookup that matches nothing says which filter it asked with instead of "has no ticket". Every sweep that lists open pull requests per clone (reviewers, dependency updates) resolves a clone to its repository from the declaration or the clone's git remote, never from its key in `clones`, so a `.github` clone behind the key `github` is swept as `a11ign/.github` and `a11ign/github` is never listed. `agent-org doctor` fails a `clones` entry that names no real repository.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/linear/linear.test.ts src/declared-clone.test.ts src/install/doctor.test.ts
```

Consumer-declaration: none -- no host file changes meaning. A `clones` key that is a declared key or a repository's name resolves exactly as before; a key that is neither is resolved by the clone's `origin` and no longer turned into a repository name.
