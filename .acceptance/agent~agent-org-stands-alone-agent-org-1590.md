Sizes agent-org's dependency on a project tree, for agent-org#1590. `docs/project-tree-dependency.md` holds the method, the failing-subtest classification for three configurations (no project; fixture project; fixture project with a11ign's role briefs), the per-file table, SIZE, and the proposed split. No code, CI, workflow, or pin changes. The build rows are filed in agent-org's tracker, chained (agent-org#1600 to #1604), and each blocks agent-org#1593 (PROJECT_REF deletion).

Acceptance: `bash -c 'cd /home/agent/repos/wt-agent-org-1590 && node -e "const r=require(\"child_process\").spawnSync(\"git\",[\"ls-files\",\"docs/project-tree-dependency.*\"],{encoding:\"utf8\"});process.exit(r.stdout.trim()?0:1)"'`

Measured (rstest, from the saved runs named in the doc): configuration 1, no project, 720 files; 514 fail at import (347 "REFUSED: it is unset", 167 TDZ), 3167 tests, 19 failing. Configuration 3, fixture with role briefs: 2363 tests in 98 files, 378 failing in 76 files. The row's "158 of 464 subtests" does not reproduce under rstest and is not used for sizing; the doc says why.

Not here, and named: the fixture tree and its declaration (agent-org#1600); the per-family switches (#1601 to #1603); the 43 unresolved files and the 10 tests-the-project and 14 needs-real-project subtests (#1604). The 10 subtests that read a11ign's packages are not filed in a11ign's tracker from here.

Closes a11ign/agent-org#1590

🤖 Generated with [Claude Code](https://claude.com/claude-code)
