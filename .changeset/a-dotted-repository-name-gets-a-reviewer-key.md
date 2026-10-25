---
"agent-org": patch
---

A repository whose name has a dot (any GitHub Pages repository, `<org>.github.io`) is reviewed. The atomic reviewer used to refuse a clone whose name was not already a reviewer key ("its name `a11ign.github.io` cannot be a reviewer key"), every tick, so the repository's pull requests waited for review for ever. The key is now made from the name: dots and other characters a key cannot hold become `-` (`a11ign-github-io`), a name ending in `-<digits>` gets a `-repo` suffix, and two clones that make the same key, or a clone that makes a key the project declares, are told apart by `-h<7 hex>` of the real name. A clone whose name is already a key keeps it, so no running reviewer is renamed. The seat's label is the only machine name; the reviewer still posts to the repository by its real name. herdr's agent names are made by the same function, and come out as before.
