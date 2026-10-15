---
"@a11ign/agent-org": patch
---

`row-file` files a row whose Region entries all carry the key of a declared code repository other than the tool's (`control:ansible/...`, the lab) in the home tracker, not the org tracker. Those repositories are `adopterFacing: false`, so `rowKind` reads such a row `org` for the product share and still does, but the work is not the tool's and its pull request opens in that repository: a11ign/agent-org#771 and #772 were filed in a11ign/agent-org for a `control:` Region and refiled by hand with `--tracker=`. A Region naming the tool's own key, an empty Region, a bare path, an undeclared key or a mix still files in the org tracker, and `--tracker=` still overrides. a11ign/agent-org#773.
