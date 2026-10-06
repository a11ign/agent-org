---
"agent-org": patch
---

`src/private-tmp.test.ts`'s `LIVE` test is skipped, with its reason stated, when it is not reading a run of agent-org's own rstest config, instead of failing the file: under `tsx --test` (what `pnpm run verify`'s `agentOrg` step runs) `A11Y_PRIVATE_TMP_RUN` is never published, and in ci.yml's `agentOrg` layout `scripts/` is not copied, so the file's static import of the config died at load. The config is now imported only when it is on disk, and `liveSkipReason` is pinned both ways (each reason, and no skip when the config and the run root are both present). Under agent-org's own rstest run the `LIVE` test still runs and passes.
