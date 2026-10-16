---
"agent-org": patch
---

An open-rows answer that parses but is not a list is read as refused, and now says why on stderr: `NOTE: the open rows could not be read (the answer was not a list: ...); read as refused`, on the same tick as the claim-stall line. Before, it was the one `null` of the open-rows read that wrote nothing (agent-org#1401 had three such ticks). A `null` still means "read as refused" (a11ign/agent-org#1624).
