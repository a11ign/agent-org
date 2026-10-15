---
"@a11ign/agent-org": patch
---

The daily reading on #928 can quote the count of hand-filed pin or bump rows and of stuck Renovate PRs, behind the machinery flag `retro.pinBump`, which is OFF by default and switched with `machinery:flag`. With it OFF the report is unchanged. With it ON, the home repository's issues are read as a plain list (never a search) and each population repository's open PRs are read, and one line quotes both figures; a refused read shows as `unknown`, never 0 (agent-org#1245, after the leaf of agent-org#1172).
