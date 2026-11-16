# Eval sets

Each file is a set the worker eval replays (`docs/run-eval.md`). `first.json` holds ten small agent-org tickets, each completed by one merged pull request on a single plan step, picked on 2026-11-16 (A11-431): two `doctor` and `github` fixes, five ticket-mode fixes, one test fix and one feature. Each `baseSha` is the merge base of the pull request's base and head, the commit its merged diff starts from.
