Every exact `@a11ign/toolchain@x.y.z` install in `.github/workflows/` names `0.15.0`, the version `package.json` now declares (`^0.15.0`), so the `suite` job installs a toolchain that satisfies `bootstrap-copies-match-toolchain.test.ts`. Closes A11-426.

## What changes, and why

- `ci.yml` (lines 106, 108, 204), `request-thread-repeat.yml` (61, 63) and `sandbox-repeat.yml` (52, 54): `"@a11ign/toolchain@0.14.0"` becomes `"@a11ign/toolchain@0.15.0"`. The pin stays exact (a11ign/a11ign#4308).
- **No changeset:** a workflow edit ships nothing (`no-release`).

## How you verified it

With 0.15.0 installed, `bootstrap-copies-match-toolchain.test.ts` reports the toolchain satisfies `^0.15.0` and all six `COPIED FROM` copies in `src/lib/` match it (no drift, so no copy changed).

Acceptance: `bash -c 'test "$(git grep -h -o "@a11ign/toolchain@[0-9][0-9.]*" -- .github/workflows | sort -u)" = "@a11ign/toolchain@0.15.0" && grep -q "\"@a11ign/toolchain\": \"^0.15.0\"" package.json'`

platform: n/a (a pin in a workflow file)
