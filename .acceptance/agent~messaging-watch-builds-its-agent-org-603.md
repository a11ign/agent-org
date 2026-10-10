`messaging:watch` builds its Telegram provider WITH the announcements channel, so with `messaging.announcementsFile` declared an announcement goes to the channel's chat and not the chairman's (a11ign/agent-org#603, found by #4755).

Closes a11ign/agent-org#603

## What changes, and why

- **`src/messaging/watch.ts`**: `telegramProvider` passes `announcementsChatId: readAnnouncementsChatId(config.announcementsFile)` to `createTelegramProvider`. It was the one place that builds the provider for the unit and it never gave the channel, so `audience.test.ts`'s routing was only ever exercised by a test that supplied it.
- **`src/messaging/state.ts`**: `readAnnouncementsChatId(path)`. `null` is "no channel declared" (`undefined`, the chairman's chat as before). A declared file is read as a secret (mode 600, owned by the user, not a symlink) and must hold one non-zero integer; anything else is a `SecretFileRefusal` naming the file and quoting none of its content, never read as "no channel". It is stricter than the copy it replaces, which was `Number(text)` and so accepted `0`, `1e3` and `0x10`.
- **`src/decision-confidence-post.ts`**: its private `announcementsChatId` is deleted and the shared read is used. A refused secret file there is `cannotPost` (exit 2), which is what the old copy's non-integer case already was; the same `catch` now also covers the token and chairman files, which used to be an uncaught throw.
- **`src/messaging/watch-provider.test.ts`**: `main` with NO `providers` argument and an `announcementsFile`.
- **`.changeset/messaging-watch-gives-the-announcements-channel-603.md`**: patch, so the merge is released.

## How you verified it

```
$ AGENT_ORG_HOST=<a project checkout's .agent-org/host.json> npx rstest run --config scripts/rstest/rstest.config.ts src/messaging/watch-provider.test.ts
VERDICT pass: 11 tests in 1 file
```

Before the change the same file printed `VERDICT fail: 3 of 11 tests failed`: the channel test saw `chat_id` 4242 where `-1001234567890` was expected, and the two refusal tests saw exit 0 where 1 was expected. The control (no `announcementsFile`, goes to the chairman's chat) passed before and after.

Also: `src/messaging` and `src/decision-confidence-post.test.ts` together, `VERDICT pass: 1139 tests in 41 files`; `node .github/scripts/leak-scan.ts` 0 leaks; `node .github/scripts/workflow-paths.ts` clean.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/messaging/watch-provider.test.ts`

Mutation: each restored by `cp` and shown byte-identical with `diff`.
- `telegramProvider` stops passing the channel: the channel test and both refusal tests fail (3 of 11); the control stays green.
- `telegramProvider` passes the chairman's id plus one: the channel test AND the control fail, so the control does compare against the chairman's chat.
- `readAnnouncementsChatId` never refuses a non-integer: only the non-integer test fails (1 of 11).
- the refusal quotes the file's content: only the non-integer test fails (1 of 11).

## Anything a reviewer should be sceptical of

- **The announcement in the test is the daily summary, not a release.** `main` hands `releaseRepos` none when `github` is injected and reads real `gh` when it is not, so a release cannot be produced without the host's `gh`. The summary is an `announcement`-audience kind in `core.ts` and the fixture already sends it; the audience routing is the same code for both. Done-when 2 (a real release quoted on a11ign#928 with the channel's message id) is a live reading after release and is not claimed here.
- **`pnpm run verify` was not run**: this tree has no `node_modules` of its own, and `node_modules` is a symlink to the primary checkout's, which is older than `package.json` (`@a11ign/toolchain` there has no `./mjs-ratchet` export). `npx tsc --noEmit` reports exactly 2 errors, both in `src/packaging/mjs-ratchet.test.ts`, which this diff does not touch and which is that missing export. `src/packaging` has 7 failing tests in 4 files (`mjs-ratchet`, `auto-arm-token`, `live-tree-independence`, `milestone-clock-exact-start`); the same 4 files fail identically in the unmodified primary checkout, measured. CI's own install resolves them.
- **`watch-provider.test.ts` now starts with `// no-token: prepareContext`.** `pr:open`'s acceptance check charged the file a `token` through the static chain `main` → `requestActions` → `converse.ts` → `prompt-session.ts` → `prepareContext`. The chain is real as an import and unreached as a run: `requestActions` builds buttons, and `converse.ts` loads `prompt-session.ts` and `wake.ts` on first use (its own comment, line 36), which only an inbound reply makes and no test here sends. The file passes with no seat and no herdr.
- **`AGENT_ORG_HOST`** was set to a sibling checkout's `host.json` to run the tests (unset, `watch.ts` refuses at import and the file reports 0 tests), as earlier rows did.
- **The diff reaches two files beyond the row's two-file Region** (`state.ts`, `decision-confidence-post.ts`): the row's own Change item 2 names them.
- `.agent-org/roles/engineer.md` is not in this repository; the brief was read from a sibling worktree.
