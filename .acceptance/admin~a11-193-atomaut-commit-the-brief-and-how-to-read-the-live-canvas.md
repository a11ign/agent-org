Commits the Atomaut brief word for word as `docs/design/atomaut/BRIEF.md`, and a `docs/design/atomaut/README.md` that gives the live canvas URL, how to read it with the Artifact tool (`project/<Board>.dc.html`, `project/canvas.json`, not WebFetch, not `claude -p`), and an index of the canvas's 49 boards by its six sections. No board file is copied. Docs only, so no code or behaviour changes.

Acceptance:
```bash
set -e
D=docs/design/atomaut
head -1 $D/BRIEF.md | grep -qx '# Atomaut UI redesign: the brief (from the chairman, 2026-10-24)'
grep -qx '## Before a page is done' $D/BRIEF.md
grep -q 'https://claude.ai/artifact/S7AMyTJ3wSDk7s342DzcVD' $D/README.md
grep -q 'project/<Board>.dc.html' $D/README.md
grep -q 'project/canvas.json' $D/README.md
grep -q 'Not WebFetch' $D/README.md
grep -q 'claude -p' $D/README.md
grep -q 'greatest `y`' $D/README.md
test "$(grep -c '^| .* | `project/Atomaut[A-Za-z]*\.dc\.html` |$' $D/README.md)" = 49
test "$(grep -c '^### ' $D/README.md)" = 6
test "$(git diff --name-only origin/main...HEAD | grep -v '^\.acceptance/' | sort | tr '\n' ' ')" = "$D/BRIEF.md $D/README.md "
```
