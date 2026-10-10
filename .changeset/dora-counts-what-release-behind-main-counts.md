---
"agent-org": patch
---

The DORA reading and the release-behind-main detector now agree on what a releasable change is: a test file or a changeset under a releasable path is not one, and a pull request whose body carries a `no-release:` reason is not either. A test-only merge to a repository whose tests live under its releasable path (`documents`, `screenreader-fleet`) no longer reads as a missed release or inflates the lead time. a11ign/a11ign#4688.
