---
"agent-org": patch
---

`host/gh` no longer empties the whole read cache about every 5 seconds. A call counts as a write only when it writes: `auth git-credential` (the helper behind every `git fetch` and `git push`) and an `api` call whose named method is GET (`--method GET`, `-X GET`, `-XGET`; `-f`/`-F` are then query parameters) leave the store alone, while a method that is not GET, a body flag with no method, and `--input` still drop it. A real write drops only the repository it names (`-R`, `$GH_REPO`, or the `repos/<owner>/<repo>` of an `api` path) and the reads that named none; a write that names no repository still drops the whole store. Entries are now named `<repository>~<key>`. a11ign/a11ign#4148 part 6, from the measurement in #4616 (561 store-dropping calls in 41.9 minutes, `read-cache/e/` holding 0 entries).
