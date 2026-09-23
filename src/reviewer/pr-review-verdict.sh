#!/usr/bin/env bash
# Posts a reviewer's verdict as a GitHub review (#1931; ceo's 2026-09-19 ruling, #1761) AND records
# WHICH SESSION POSTED IT, as a commit status the org can read without parsing prose (#2127).
#
# THE DOOR. The Codex execpolicy forbids `gh pr review` outright (~/.codex/rules/default.rules), because
# a bare prefix rule cannot tell `--approve` from `--dismiss` or `--comment` once a PR number precedes
# the flag. This script is the one narrow way a review is posted, which is exactly why the attribution
# belongs here: it is the only point in the whole path where the reviewing session's identity is known
# at all. GitHub loses it one line later -- `reviewer` and `reviewer-2` share the `a11ign-bot` account,
# so `user.login` on the posted review says nothing (see review-attribution.mjs for the measurement).
#
# THIS FILE IS THE SOURCE; the host copy at the reviewer's `bin/` is an install of it. It lived only on
# the host until #2127, which is how a change to the posting path could not be reviewed or tested.
#
# ATTRIBUTION NEVER FAILS THE REVIEW. A review that posted and was not attributed is today's state and
# is survivable; a verdict that did not post because a bookkeeping call failed stalls a pull request and
# costs a reviewer's turn. So the attribution runs after the review, cannot abort it, and says on stderr
# exactly what it could not record.
#
# Usage: pr-review-verdict <pr-number> <convinced|not-convinced> <verdict-comment-file>
# Env:   A11Y_REVIEWER_SESSION  the org session name posting this review (`reviewer`, `reviewer-2`).
#                               Without it the review still posts, UNATTRIBUTED and loudly.
set -euo pipefail

REPO=a11ign/a11ign
# ONE SPELLING WITH `attributionContext` IN review-attribution.mjs. A shell writer and a JS reader cannot
# share a constant, so `review-attribution.test.ts` reads this line and compares the two.
ATTRIBUTION_CONTEXT_PREFIX=review/

n="${1:-}"; verdict="${2:-}"; file="${3:-}"
[[ "$n" =~ ^[0-9]+$ ]] || { echo "pr-review-verdict: PR number must be digits, got '$n'" >&2; exit 2; }
case "$verdict" in
  convinced) flag=--approve ;;
  not-convinced) flag=--request-changes ;;
  *) echo "pr-review-verdict: verdict must be convinced or not-convinced, got '$verdict'" >&2; exit 2 ;;
esac
[[ -s "$file" ]] || { echo "pr-review-verdict: verdict comment file '$file' is missing or empty" >&2; exit 2; }
body="$(head -n 1 "$file")"
[[ "$body" == "**Review of #$n at "* ]] || { echo "pr-review-verdict: first line of '$file' is not the verdict line for #$n" >&2; exit 2; }

# Records who posted the review that carries `$body`. Returns non-zero when it could not, having said why.
attribute() {
  local session="${A11Y_REVIEWER_SESSION:-}"
  if [[ -z "$session" ]]; then
    echo "pr-review-verdict: A11Y_REVIEWER_SESSION is unset -- review on #$n posted UNATTRIBUTED." \
         "Nothing but the review's own prose can say which session reviewed it (#2127)." >&2
    return 1
  fi
  # THE NEWEST REVIEW, THEN PROVED TO BE OURS BY EXACT BODY EQUALITY. `gh pr review` prints no identifier,
  # so the review just posted has to be found again. The equality check is an ECHO of the string this
  # script sent one line ago, not a reading of what the sentence means -- if another review landed in
  # between, this refuses to attribute rather than labelling somebody else's.
  local latest url sha posted
  latest="$(gh api "repos/$REPO/pulls/$n/reviews" --jq '.[-1] | [.html_url, .commit_id, .body] | @tsv')" || {
    echo "pr-review-verdict: could not read back #$n's reviews; review posted UNATTRIBUTED (#2127)." >&2
    return 1
  }
  IFS=$'\t' read -r url sha posted <<<"$latest"
  if [[ "$posted" != "$body" ]]; then
    echo "pr-review-verdict: #$n's newest review is not the one just posted; not attributing it (#2127)." >&2
    return 1
  fi
  # ALWAYS `success`, WHATEVER THE VERDICT: this status says WHO reviewed, never whether the review
  # passed. A `failure` context would turn the pull request's checks summary red and make a refusal
  # indistinguishable from a broken build. The verdict is the review object's own state.
  gh api --method POST "repos/$REPO/statuses/$sha" --silent \
    -f state=success \
    -f "context=${ATTRIBUTION_CONTEXT_PREFIX}${session}" \
    -f "target_url=$url" \
    -f "description=$verdict" || {
    echo "pr-review-verdict: could not record the attribution status for #$n; review posted UNATTRIBUTED (#2127)." >&2
    return 1
  }
}

gh pr review "$n" --repo "$REPO" "$flag" --body "$body"
attribute || true
