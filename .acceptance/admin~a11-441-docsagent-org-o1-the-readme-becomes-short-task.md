The README (835 lines on `4afb7952c`) is split into task pages under `docs/guide/`, and is now 51 lines that link to them (A11-441, step 1 of 2). The text is moved, not rewritten: headings go up one level, relative links get `../../` because they are now two folders down, and the three "see ... above/below" references that now point to another page are links to it. The host-file key table moved to `docs/guide/configuration.md`, so `src/ticket-mode/readme-keys.test.ts` reads that page and expects the `../../src/ticket-mode/config-schema.ts` link. `src/ticket-mode/readme-pages.test.ts` is new: the README is under 150 lines and links to install, onboard, services, ticket mode, plugins and troubleshooting, and every relative link in the README and in `docs/guide/*.md` names a file that exists.

Acceptance:
```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/readme-keys.test.ts src/ticket-mode/readme-pages.test.ts src/packaging/installed-layout.test.ts
test "$(wc -l < README.md)" -lt 150
test "$(npm pack --dry-run 2>&1 | grep -c 'docs/guide/')" -eq 9
```

Fails on the base: with both test files copied onto `4afb7952c`, `readme-keys.test.ts` cannot open `docs/guide/configuration.md`, and `readme-pages.test.ts` says `README.md is 836 lines` and cannot list `docs/guide`.

Mutation: delete the `tickets.max` row from `docs/guide/configuration.md`, and the first `readme-keys` test names `docs/guide/configuration.md: tickets.max has no row in the key table`. Point a README row at `docs/guide/instal.md`, and `readme-pages` names both the missing task page and the broken link.

Consumer-declaration: none. No host file key, command or contract changes; only where the documentation lives.

Review round 1: `package.json` `files` ships `docs/guide`, so the README's links resolve in an installed copy. `readme-pages.test.ts` checks that every README link target is under a `files` entry; against the previous `files` it names the nine guide pages. `src/packaging/installed-layout.test.ts` installs the package from a tag and asserts `docs/guide/install.md` is there; against the previous `files` it fails with `docs/guide/install.md is not installed`.
