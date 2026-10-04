---
"agent-org": patch
---

The daily summary is opt-in and an absent `messaging.summary` means off (chairman, 2026-10-04: "the chairman does not want a daily message"; a11ign/a11ign#3410). It had defaulted to 08:00 London, so a host that never declared one sent `summary:2026-10-03` and `summary:2026-10-04`. `parseMessagingConfig` now returns `summary: null` for an absent key and `runWatch` then constructs no summary source, so nothing is read for it and nothing is sent; a present key (`summary: {}` included, which takes `DEFAULT_SUMMARY`'s fields) works as before, and a malformed one is still refused. `messaging:check` says `no daily summary` rather than a time. `DEFAULT_SUMMARY` is now the field defaults of a declared summary and no longer a default for an absent one.
