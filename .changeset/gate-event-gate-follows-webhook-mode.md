---
"agent-org": patch
---

In `webhook` mode the gate applies its event gate without `gate.graphqlPacing`: a repository no event named and read within the 15-minute sweep is not re-read, and is reported unread. The flag was absent from the canary state, so the gate took a whole read every tick and its GitHub calls per hour did not fall at the webhook switch (agent-org#1353). The revert is `"source": "poll"`.
