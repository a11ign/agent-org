The DORA reading answers a repository's ancestry from its declared clone when the clone holds both commits, so a repository releasing ~70 times a day reads its lead time as a number. `dora-ancestry-from-the-clone.test.ts` builds a real 160-commit git repository, injects a `range` reader that THROWS, and requires `leadTime.medianMinutes === 0.5` with `ancestry === "clone"`; its positive controls are the same fixture with no clone declared (the reader IS called and the fallback is named) and a clone lacking the newest release commit (falls back, names the commit and the failed fetch).

Mutation: forcing the clone's `range` to answer `null` fails the clone-answers and the lacks-the-commit tests; forcing `status` to `ahead` fails the diverged-release test; each leaves the other tests green.

Acceptance: `cd ~/repos/agent-org && node --import tsx --test src/dora-ancestry-from-the-clone.test.ts src/dora-lead-time-reads-are-bounded.test.ts`

Closes a11ign/a11ign#4690

platform: n/a (reads git)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
