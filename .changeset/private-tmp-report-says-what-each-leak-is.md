---
"@a11ign/agent-org": patch
---

The private-TMPDIR leak report says what each leaked entry is (agent-org#939, from two red `main` runs that ended on one `a11y-git-sandbox-*` left by `region-paths-checkout.test.ts` with every test passing). Each leaking file's line keeps its earlier text and appends, for the first five entries it names, whether the entry is a directory (with how many entries it holds and the first three names), a file, or something else, and how long before the teardown it was last modified. An entry that vanished between the directory read and the `lstat`, or that cannot be read, is reported as such and is still a leak. `findLeaks` reads one `lstat` and at most one `readdir` per named entry, never a walk. The runtime caches stay excluded and a leak stays red by default; only the report changes.
