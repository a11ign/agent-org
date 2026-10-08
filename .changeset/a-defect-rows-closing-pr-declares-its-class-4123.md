---
"agent-org": patch
---

A pull request whose `Closes` names a row labelled `defect` must carry exactly one `Class:` line, or it does not pass `pr:open` or CI's acceptance job: `Class: <id> — <where else it can occur>; guard: <what stops it everywhere>`, or `Class: none — <reason>` (em dash required, both halves non-empty, `<id>` kebab-case; a duplicated line is malformed). A refused label read is `UNKNOWN`, never a pass; a caller with no reader of labels prints `CLASS: NOT CHECKED`. `row-file --kind defect` adds the `defect` label (made in the repository first, and read back), and any other `--kind` is refused before anything is filed. CI's acceptance step is tracker-less by design, so it reads the labels from `ACCEPTANCE_ROW_LABELS` when a step before it supplies them. a11ign/a11ign#4123, child A of #4122.
