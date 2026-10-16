Acceptance: `node --test src/packaging/outside-arm.test.ts src/packaging/outside-arm-refusals.test.ts` (26 tests). Measured in the worktree: `ℹ pass 26`, `ℹ fail 0`. The new test, `agent-org#1626: an arm-pr that writes the arm and then exits nonzero is READ BACK ...` in `outside-arm.test.ts`, drives `outsideArmPass` with a fake `arm-pr` that flips the armed state and then exits 1, 3 and 4: each is in `result.armed`, not in `result.failed`, logs `armed -- read back: ... BUT arm-pr exited <code> (<its last line>)`, and never logs `COULD NOT ARM`. Controls in the same test: an exit 1 before any write (authorship) stays `failed` with `read back: NOT ARMED`, and a read-back that throws after exit 3 is `failed` naming the exit.

Mutation: source backed up with `cp`, one edit, run, restored by `cp` with `diff` clean.
- A, a nonzero exit is `failed` with no read-back (the old behaviour): 1 fails, the new test.
- B, the not-armed-after-nonzero branch removed: 1 fails, the new test (its authorship control).

Design (a judgment, since exits 1, 3 and 4 differ): the pass does not branch on the exit code, because exit 1 is both a post-write refusal (label) and a pre-write one (authorship). It reads every exit back and lets GitHub decide; the exit is named beside the answer. Armed on the read-back after a nonzero exit counts as `armed` (it is), with the exit in the log so the red `arm` job and the missing labels stay visible.

Not tested: exit 2 after a stuck disarm of a red cross-repo leg (`src/arm-pr.ts` L1214): it takes the same read-back path, and is not driven.

Closes a11ign/agent-org#1626

platform: linux, Node v24.21.0; the pass takes an injected `run`, so no host state or `gh` is read by the tests except through the fake.
