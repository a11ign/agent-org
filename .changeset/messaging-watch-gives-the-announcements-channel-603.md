---
"agent-org": patch
---

`messaging:watch` gives its Telegram provider the announcements channel. `telegramProvider` built the provider without `announcementsChatId`, so with `messaging.announcementsFile` declared every release, milestone, summary and watch announcement still landed in the chairman's chat. It now reads the file (a secret file holding one integer; anything else is a `SecretFileRefusal` naming the file, never "no channel") through `readAnnouncementsChatId` in `messaging/state.ts`, which `decision-confidence-post.ts` now uses in place of its own copy. a11ign/agent-org#603.
