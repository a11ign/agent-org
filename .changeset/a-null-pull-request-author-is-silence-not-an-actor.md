---
"agent-org": patch
---

The hand-fix ledger no longer counts a pull request whose GraphQL author is null as an unread actor. An Actions token opens such a pull request, and its null author was judged `unknown`, so a change whose every carried commit named an automation or org account was reported UNREAD (39 of them in the 2026-10-17 retrospective). A null pull-request author is now silence: the carried commits' own logins decide the change. A change with no resolvable carried login stays UNREAD (agent-org#1672).
