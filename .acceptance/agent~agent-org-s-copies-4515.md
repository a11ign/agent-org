The copy headers of `src/lib/product-home.mjs` and `src/lib/fixture-symbols.ts` named `scripts/*.mjs` originals the core renamed to `.ts` (a11ign/a11ign#4274), so `readDeclaredCopies` read nothing and `copyDriftReading` answered `unknown` for them (a11ign/a11ign#4515).

- Both headers now name the `.ts` original, with `at d9ea0c438`, the core commit that renamed them.
- `fixture-symbols.ts`: the original gained the same two type annotations the copy carried, so the copy is now identical to it (`diff` empty after the header). Header: `CHANGED FROM THE ORIGINAL: NOTHING`.
- `product-home.mjs`: the original also gained a typed `productHome` signature, which this plain-JS `.mjs` copy keeps untyped. The header names it as a fourth changed line (`4 NAMED LINES`, as `judgePair` allows) instead of changing the copy.
- Files: the two copies and a changeset.

Acceptance:
```bash
bash -c '! git -C ~/repos/agent-org show origin/main:src/lib/product-home.mjs | grep -q "COPIED FROM .scripts/product-home.mjs."'
bash -c '! git -C ~/repos/agent-org show origin/main:src/lib/fixture-symbols.ts | grep -q "COPIED FROM .scripts/fixture-symbols.mjs."'
```

Note: both commands read `origin/main` of agent-org, so they exit 0 only after this merges; before, they exit 1 as the row's Open-check says.

Closes: none -- a11ign/a11ign#4515 also asks for a release tag after the merge, which the lab's CI resolves; posted on the row once cut.

Verified (measured, this worktree at this head, `AGENT_ORG_HOST` at a11y-witness's host.json): `readDeclaredCopies({ root: <core checkout> })` + `copyDriftReading` over the two pairs read `clear` (both originals readable, allowed lines 0 and 4). `org-health-fleet-and-copies`, `modules-find-the-project`, `row-reachability`, `remedies-say-pnpm` tests: 67 pass in 4 files. `node -e "import('./src/lib/product-home.mjs')"` prints ok. `tsc` shows 3 errors, all in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` not resolvable from the borrowed `node_modules`); not touched here. Not run: the full suite (it queued for over 40 minutes and was stopped).

platform: checked that git and GitHub hold no cross-repository copy pin; the header is the pin, as ADR 0040 decision 4 has it. Net lines: +5/-4 in two headers; nothing to delete.

Mutation: n/a -- a comment-only change; the guard is `copyDriftReading`, whose positive case (a header naming an unreadable original reads `unknown`) is the state before this change, per the row's Open-check.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
