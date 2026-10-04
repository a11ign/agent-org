---
"agent-org": patch
---

`release.yml`'s header and the README's Releases section no longer say the host tracks `main` and a tag is not a deploy, which `update-tool` made false (a11ign/a11ign#3443): they say the host runs the newest release tag, `host.json`'s `toolVersion` pins one as the rollback, a merge with a changeset is live about nine minutes after it lands and a merge with none is never live. Comment and prose only; the release test now requires `toolVersion` in the README's Releases section in place of the retired sentence.
