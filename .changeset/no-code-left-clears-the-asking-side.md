---
"agent-org": patch
---

A row labelled `no-code-left` asks B4 for no file, so a reopened verify-only row is no longer refused on its stale Region (a11ign/agent-org#727, #732). The label (#3541) was read only for a CLAIMED row's reservation (`claimedRegionsOf`); `lookupMyRegionFiles`, the asking side, read the body alone, so a chairman row whose build had merged and whose only item left was a host read was refused against an unrelated open pull request on the files that build edited, and woke `ceo` with `CHAIRMAN ROW REFUSED`. `lookupMyRegionFiles` and `lookupIssueBody` now both ask `--json body,labels`, one argv, so the claim's batched pre-write read still serves them from one `gh issue view` (no new call); `lookupMyRegionFiles` answers `[]`, a real comparable "no files", for a row carrying the label; a failed lookup is still `null`, and the same row without the label still asks for what its Region names.
