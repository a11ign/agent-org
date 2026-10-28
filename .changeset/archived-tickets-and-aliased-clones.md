---
"agent-org": patch
---

The board finds a Linear ticket by its key whether or not Linear has archived it: an After-merge comment for a closed ticket (A11-209 and four others) was refused as "Linear has no ticket", because Linear leaves archived tickets out of a lookup unless it asks for them. A lookup that still matches nothing now names its filter (team key, number, archived tickets included). The sweeps that list open pull requests per clone (reviewers and dependency updates) resolve a clone to its repository from the declaration or the clone's git remote and no longer make a repository name from the clone's key, so the clone of `a11ign/.github` listed under the key `github` is swept as `a11ign/.github` and `a11ign/github`, which is no repository, is not asked for. `agent-org doctor` fails a `clones` entry that names no real repository.
