---
"agent-org": patch
---

A stuck cause about a pull request is no longer filed as "`main` is red" (a11ign/a11ign#4360). `fileRepositoryRow` read nothing of the cause's kind, so `worker-4305/pr-checks-failing/pr-lab#39/fe4dce88` (a red pull request waiting on a native chain) was filed as "Stuck trunk-red: lab#39 -- `main` of a11ign/lab is red", and `ceo` spent a read proving lab `main` green. The wording now comes from the key's middle segment: `trunk-red` keeps its title and body; `pr-checks-failing` is titled "Stuck pr-checks-failing: lab#39 -- a pull request of a11ign/lab is red and nothing has fixed it" and asks whether the pull request is waiting on something; any other kind is worded by its own name. Each kind has its own title, so the dedupe by title is unchanged. Open `Stuck trunk-red:` rows are not re-titled.
