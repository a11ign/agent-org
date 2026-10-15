---
"@a11ign/agent-org": patch
---

The GraphQL pacing gate (`gate.graphqlPacing`, still off by default) now reports what its webhook event gate drops. A repository no event named is listed as unread, with its reason, instead of being skipped silently. On an event-gated tick that names neither the home repository nor a due sweep, the primary's tracker lanes and `orgHealth` are skipped and reported unread, as a paced skip already is.
