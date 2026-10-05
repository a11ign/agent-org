---
"agent-org": patch
---

The gate reads each code repository's open pull-request list 20 at a time and asks again at 100 only when the first page came back full. A GraphQL request is priced by the page it asks for times the nested connections each pull request carries, so the same query costs 7 points at 100 and 1 at 20 (measured by replaying what `gh` sends with `rateLimit { cost }`). The gate asked for 100 of each of six repositories every two minutes, for lists holding 0 or 1 pull request: 42 of the 49 points its 13 `pr list` calls cost per run, now 6 of 13. The answer is the same list: a page with room left is the whole list, a full one is read again at 100, and a refused second read is `null`, never the first page standing in. `GH_READS` states the three `pr list` reads per non-primary repository. a11ign/a11ign#3674.
