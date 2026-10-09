`host/gh` stopped dropping the read cache for calls that write nothing, and a real write now drops only its own repository's entries (a11ign#4616: 561 store-dropping calls in 41.9 minutes, `read-cache/e/` holding 0 entries). Three changes in `call_class` and the drop: `auth git-credential` is neutral; an `api` call is a write by its NAMED METHOD (GET is a read, `-f`/`-F` then being query parameters; a body flag with no method, any other method, and `--input` stay writes); and entries are named `<repository>~<key>`, so a write to X removes `X~*` and `default~*` and leaves Y's, while a write that names no repository removes the whole store (the fail-safe).

Evidence, measured on this branch at agent-org `origin/main` `9f260a4` plus this diff: `gh-read-cache.test.ts` 9/9 pass (the 7 existing, with `auth git-credential get` moved out of the list of writes, and the 2 new `#4148 part 6` cases); the four neighbouring files that read the wrapper (`host-project-paths`, `gh-call-ledger`, `tick-snapshot`, `gh-read-cache`) 40/40 pass. The `grep` half of the Acceptance fails at `origin/main` (no such test). Mutations, each restored byte-identical (`diff` against a copy): `git-credential` classed a write, a named GET classed a write, a write dropping everything, a scoped write dropping nothing, a no-repository write dropping nothing, and the `api` path ignored each failed the `#4148 part 6` case that pins it. NOT run: the whole agent-org suite (33 failures in 11 files on an unmodified checkout in this environment, per agent-org#537's record); `pnpm run typecheck` shows two errors in `mjs-ratchet.test.ts` (`@a11ign/toolchain` is not in the shared `node_modules`), none in a touched file. Done-when 2 (the live store after `host:install`) and 3 (the 24-hour reading) are not claimed here.

Acceptance: `cd /home/agent/repos/agent-org-wt-4148-p6 && grep -q "#4148 part 6" src/packaging/gh-read-cache.test.ts && node --test --test-name-pattern "#4148 part 6" src/packaging/gh-read-cache.test.ts`

Closes: none — Done-when 2 (host:install and a read of the live store) and 3 (a 24-hour live reading) of a11ign/a11ign#4148 cannot be true at merge, so the row stays open.

Outside-Region: .changeset/the-read-cache-survives-a-credential-helper-call.md — agent-org's required `changeset` check needs an entry for any change under `host/`.
Outside-Region: .acceptance/agent~gh-cache-keeps-reads-4148.md — the Acceptance file the PR adds (ADR 0044).
Outside-Region: src/packaging/host-project-paths.test.ts — the recorded digest of the rendered wrapper moves with its text (a11ign#4148 part 6 comment beside the pin), as in #398.

platform: GitHub's own API methods decide a read from a write, so `call_class` now reads the method gh itself would send; nothing in `gh` caches or scopes by repository.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
