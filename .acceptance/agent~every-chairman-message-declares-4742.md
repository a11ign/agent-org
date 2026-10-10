Each messaging kind now declares an `audience` (`ask` for `request` and `stall`, `announcement` for the other five), the plan carries it, and the Telegram provider holds one chat id per audience: `messaging.announcementsFile` (optional, a secret reference like `chairmanFile`) names the channel, and with it absent both audiences reach the chairman chat exactly as before. A kind with no audience is refused at send with `alert not sent: kind "<kind>" declares no audience`, and never defaulted. An announcement carrying `actions` is refused by the provider, and one carrying `replyTo` INTO THE CHANNEL is too; with no channel an incident's "cleared" threads under the original as it always did. `runProviderConformance` gains `audience-is-honoured`, `unknown-audience-is-refused`, `announcement-refuses-actions` and `announcement-reply-to-follows-its-destination`, and `capabilities.destinations` reports one destination or two.

Evidence (this branch, agent-org worktree, `AGENT_ORG_HOST` pointed at the host file so the 12 files that need one load): the Acceptance below passes, 150 tests in 5 files; `src/messaging` as a whole passes, 1052 tests in 37 files; `tsc --noEmit` reports only the pre-existing `mjs-ratchet.test.ts` missing-module error. Nine source mutations each turn named tests red and restore byte-identical (`cp` and `diff`): Telegram ignoring the audience (2 red), Telegram sending the ask to the channel too (5), the core never refusing an undeclared kind (2), the core always refusing (39), Telegram never refusing actions on an announcement (4), Telegram refusing `replyTo` with no channel (4), Telegram never refusing `replyTo` into the channel (2), the core threading a clear into the channel (1), the core never threading an announcement's clear (2, one of them the existing core test).

Acceptance: `cd /home/agent/repos/agent-org && npx rstest run --config scripts/rstest/rstest.config.* src/messaging/audience.test.ts src/messaging/core.test.ts src/messaging/config.test.ts src/messaging/provider-contract.test.ts src/messaging/providers/telegram/send.test.ts`

Closes a11ign/a11ign#4742

platform: n/a (no GitHub, pnpm, systemd or git feature declares who a message is for, or splits one bot's messages across two chats)

Net lines: positive, in the audience declaration, the destination routing and its tests; no function was added where an existing one could take the field.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
