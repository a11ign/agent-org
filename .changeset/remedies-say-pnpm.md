---
"agent-org": patch
---

Every remedy, order and usage line the tool prints says `pnpm run ...` where it said `npm run ...` (and `pnpm exec` where it said `npx`), with the `--` dropped because pnpm hands a literal `--` to the script. `host:check` now reports a `pnpm` that is not on the PATH, or whose version differs from the project's `packageManager`, as a finding that `host:install` does not fix. An acceptance written `pnpm test` or `pnpm run test:all` is recognised as the whole-suite form, as `npm`'s spelling always was, and a release-gate record written by `pnpm run` (whose script banner carries the working directory) is read as the stage it names.
