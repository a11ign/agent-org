---
"agent-org": minor
---

`host:check` now names a clone declared in `host.json`'s `clones` that the reviewers' Codex does not trust: a `CLONE NOT TRUSTED BY CODEX` finding per clone with no `[projects."<path>"]` table whose `trust_level` is `"trusted"` in `~/.codex/config.toml`. An absent or unreadable config is a finding that says which, never "trusts everything". The check READS ONLY and its remedy says so: a trust grant is a ruling per repository, so `host:install` writes nothing here. Without it a new clone left its keyed reviewer refused at startup on every tick, and the pull request behind it unreviewed. a11ign/a11ign#3702.
