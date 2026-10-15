---
"@a11ign/agent-org": patch
---

`pr:open create --repo <owner/repo>` with no `--head` no longer leaves the pull request unarmed and unlabelled. The arm and the `session:*` label named no pull request, so gh refused them with `argument required when using the --repo flag` after the create had landed. A create made from a tree now names that tree's branch in both steps when `--repo` is given; `--head` still wins, and a create without `--repo` is armed and labelled as before. a11ign/agent-org#952.
