---
"agent-org": minor
---

The chairman's chat messages are now queued for `liaison` and for no other session (`RECIPIENT`; the scan over `src/messaging/` still finds one caller and one label, and `ceo` is named nowhere in `converse.mjs`). The chairman is told `Got it, looking.` BEFORE the queue is written, in the same words each time and with no model in it; a refused queue, an absent seat or an entry not found in the queue file is told in words (`I could not reach the liaison: <the queue's refusal, verbatim>. Nothing has been done with your message.`), with no fallback to `ceo`. The handoff id stays in the ledger and no longer reaches the chat, and the ledger's inbound line gains `ackAt`. `provenanceText` no longer tells its reader not to answer with `prompt:session`: that is the liaison's brief (a11ign/a11ign#3416). Not to be merged-and-deployed on a host without the liaison seat running (#3415, E2).
