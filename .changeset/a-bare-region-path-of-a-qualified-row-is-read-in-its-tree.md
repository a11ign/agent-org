---
"@a11ign/agent-org": patch
---

`pr:open --repo <repository>` reads a bare Region path of a row QUALIFIED to that repository (`Closes owner/repo#N`) against that repository's tree, as it already did for a row whose body states the repository (#3083). agent-org#805 lists `src/claim-stall.ts` bare in its Region, and a PR for it opened in agent-org refused both paths as "outside" the Region (a11ign/agent-org#1182). The sentence a body states still wins over the qualifier, and a row of the home repository, or a path keyed to another repository, covers nothing new in another tree.
