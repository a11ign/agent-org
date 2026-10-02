#!/usr/bin/env bash
# Posts a reviewer's verdict as a GitHub review (#1931; ceo's 2026-09-19 ruling, #1761) AND records
# WHICH SESSION POSTED IT, as a commit status the org can read without parsing prose (#2127).
#
# THE DOOR. The reviewer's own execpolicy on the host forbids `gh pr review` outright, because
# a bare prefix rule cannot tell `--approve` from `--dismiss` or `--comment` once a PR number precedes
# the flag. This script is the one narrow way a review is posted, which is exactly why the attribution
# belongs here: it is the only point in the whole path where the reviewing session's identity is known
# at all. GitHub loses it one line later -- every reviewer instance shares the `a11ign-bot` account,
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
# ONE WRITE PER VERDICT (#3030). The review body is the verdict file's WHOLE text -- opener line, `Acceptance:`,
# `Mutation:`, findings -- and no comment follows it. The door used to post only the first line as the review and
# the brief had the reviewer post the file again as a comment, so the chairman saw two reviews for one head
# (#3020: review 14:05:49Z, 63 characters; comment 14:06:28Z, 505). The gate reads a verdict from a review body as
# well as a comment (`verdictBearers` in review-verdict.mjs), which is what made the second write unnecessary.
#
# Usage: pr-review-verdict <pr-number> <convinced|not-convinced> <verdict-comment-file>
# Exit:  0  the review posted (attribution is best-effort and never changes this)
#        2  a malformed call, or an environment failure offered as a verdict (nothing was sent to `gh` for either)
#        3  REFUSED: the pull request already has a review at an equal patch (a11ign#3050). Nothing was posted, and the
#           message names the review that stands. A refusal that is wrong goes to `product-manager`, never to a second review.
#        4  COULD NOT TELL whether it has one (a `gh` read failed). Nothing was posted; the door is safe to run again.
# Env:   A11Y_REVIEWER_SESSION  the org session name posting this review (`reviewer-<n>` for pull request n, #2401).
#                               Unset, the door derives `reviewer-<n>` from the checkout it runs in when that checkout
#                               IS `.../reviews/reviewer-<n>` for THIS pull request (#2528); where it cannot, the review
#                               still posts, UNATTRIBUTED and loudly.
#        GH_REPO                the repository the pull request lives in, `owner/name` (#2952). Unset or empty, the door
#                               keeps `a11ign/a11ign`, so every existing caller is unchanged. It names the review, the
#                               attribution status and the review read-back alike; anything not `owner/name` is refused.
set -euo pipefail

# ONE REPOSITORY FOR ALL THREE `gh` CALLS, FROM THE SAME ENVIRONMENT VARIABLE `gh` ITSELF READS. The org now opens pull
# requests in `a11ign/agent-org` as well, and a door that posts to a literal could only ever review the first
# repository (#2952). REFUSED BEFORE ANY `gh` CALL when it is not `owner/name`: a typo here would post an approval
# to a repository nobody meant, and a review cannot be taken back.
REPO="${GH_REPO:-a11ign/a11ign}"
[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || {
  echo "pr-review-verdict: GH_REPO must be owner/name, got '$REPO'" >&2; exit 2; }
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
body="$(<"$file")"
# THE OPENER IS STILL THE FIRST LINE, and it is the only part validated: the clock and the authors' timers parse it.
opener="$(head -n 1 "$file")"
[[ "$opener" == "**Review of #$n at "* ]] || { echo "pr-review-verdict: first line of '$file' is not the verdict line for #$n" >&2; exit 2; }

# AN ENVIRONMENT FAILURE IS NOT A VERDICT (a11ign#3050, from #3033). A reviewer whose own checkout, toolchain or token is broken has learned
# nothing about the author's change, and a request-changes made of that sends the author to fix what is not theirs. Refused HERE, before any
# `gh` call, because the door is the one place every review passes. ONLY a refusal is held: `convinced` that names its evidence, as in
# `(CI run <id>)`, is a verdict, and so is `convinced` that merely uses the word.
if [[ "$verdict" == not-convinced ]] && grep -qiF '(environment)' <<<"$opener"; then
  echo "pr-review-verdict: an environment failure is not a verdict: hand the row to orchestrator" >&2; exit 2
fi

# THE NAME, WHEN THE PANE WAS NOT GIVEN ONE (#2528). A pane herdr restores itself is not started by the tick, so it holds
# no `A11Y_REVIEWER_SESSION` (`herdr.service` restarted at 12:01:57Z on 2026-09-25 and `reviewer-2485`'s `codex resume`
# began a second later). The one place every path converges is this door, so the name is closed here. DERIVED FROM THE
# CHECKOUT, NEVER FROM THE PR NUMBER ALONE: any session can be handed a pull request number, but only the instance for
# pull request n runs in `<root>/reviews/reviewer-<n>` (`reviewCheckoutPath` in wake.mjs). Prints the name, or nothing.
derive_session() {
  local dir; dir="$(pwd -P)"
  while [[ "$dir" != / && -n "$dir" ]]; do
    if [[ "$(basename "$dir")" == "reviewer-$n" && "$(basename "$(dirname "$dir")")" == reviews ]]; then
      echo "reviewer-$n"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
}

# Records who posted the review that carries `$body`. Returns non-zero when it could not, having said why.
attribute() {
  local session="${A11Y_REVIEWER_SESSION:-}"
  if [[ -z "$session" ]]; then
    session="$(derive_session)"
    [[ -z "$session" ]] || echo "pr-review-verdict: A11Y_REVIEWER_SESSION is unset; derived \`$session\` from the checkout" \
      "$(pwd -P) (#2528). The read-back below still has to prove the review is ours before it is labelled." >&2
  fi
  if [[ -z "$session" ]]; then
    echo "pr-review-verdict: A11Y_REVIEWER_SESSION is unset -- review on #$n posted UNATTRIBUTED." \
         "Nothing but the review's own prose can say which session reviewed it (#2127)." >&2
    return 1
  fi
  # THE NEWEST REVIEW, THEN PROVED TO BE OURS BY EXACT BODY EQUALITY. `gh pr review` prints no identifier,
  # so the review just posted has to be found again. The equality check is an ECHO of the string this
  # script sent one line ago, not a reading of what the sentence means -- if another review landed in
  # between, this refuses to attribute rather than labelling somebody else's.
  local latest url sha posted expected
  # `--paginate` AND `tail -n 1`, NOT `.[-1]`: a review list past 30 entries pages, and `.[-1]` would then
  # answer about the last review of the FIRST page. It would fail safe -- the body check below refuses --
  # but it would refuse for ever on a long-running pull request, and silently.
  latest="$(gh api "repos/$REPO/pulls/$n/reviews?per_page=100" --paginate \
      --jq '.[] | [.html_url, .commit_id, .body] | @tsv' | tail -n 1)" || {
    echo "pr-review-verdict: could not read back #$n's reviews; review posted UNATTRIBUTED (#2127)." >&2
    return 1
  }
  IFS=$'\t' read -r url sha posted <<<"$latest"
  # `@tsv` writes a backslash, a newline, a tab and a carriage return as `\\`, `\n`, `\t` and `\r`, so the whole body is
  # compared in that spelling. Comparing the raw text would never match a multi-line body and nothing would be attributed.
  expected="${body//\\/\\\\}"
  expected="${expected//$'\n'/\\n}"
  expected="${expected//$'\t'/\\t}"
  expected="${expected//$'\r'/\\r}"
  if [[ "$posted" != "$expected" ]]; then
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

# THE LAST PLACE A SECOND REVIEW AT ONE PATCH CAN BE STOPPED (a11ign#3050). #3033 took six reviews for ONE authored commit: three approvals
# at one head, two refusals at another that differed from it by a merge of `main`. The gate orders reviewers (a11ign#3045); this holds
# even when it re-orders, because a review cannot be taken back and a reviewer's turn cannot be returned.
EXIT_SECOND_REVIEW=3
EXIT_UNDETERMINED=4

# NOTHING WAS POSTED, AND "COULD NOT TELL" IS NOT "THERE IS NONE": a failed read refuses rather than posting, because the one outcome the door
# cannot undo is the wrong write. The reviewer runs the door again.
undetermined() {
  echo "pr-review-verdict: could not tell whether #$n already has a review at this patch ($1); nothing was posted." \
       "Run the door again, and if it keeps failing hand the row to product-manager." >&2
  exit "$EXIT_UNDETERMINED"
}

# The patch id of the diff `merge-base(base, commit)..commit`, from the compare API's own diff, so no checkout is needed.
# `--stable` ignores line numbers and whitespace, which is what lets a merge of `main` into the branch leave the id equal.
patch_id_of() {
  local diff pid
  diff="$(gh api -H 'Accept: application/vnd.github.diff' "repos/$REPO/compare/$1...$2")" || return 1
  pid="$(git patch-id --stable <<<"$diff" | cut -d' ' -f1)"
  [[ -n "$pid" ]] || return 1  # an EMPTY diff has no id, and two empty diffs are not shown equal by saying nothing
  echo "$pid"
}

refuse_second_review() {
  local pr head base reviews when state commit url head_pid pid differing=" "
  pr="$(gh api "repos/$REPO/pulls/$n" --jq '[.head.sha, .base.ref] | @tsv')" || undetermined "the pull request would not read"
  IFS=$'\t' read -r head base <<<"$pr"
  # ONLY THE TWO STATES THIS DOOR POSTS. A DISMISSED review no longer stands, and a COMMENTED one is not a verdict.
  reviews="$(gh api "repos/$REPO/pulls/$n/reviews?per_page=100" --paginate \
      --jq '.[] | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED") | [.submitted_at, .state, .commit_id, .html_url] | @tsv' \
      | sort -r)" || undetermined "its reviews would not read"
  [[ -n "$reviews" ]] || return 0
  while IFS=$'\t' read -r when state commit url; do
    if [[ "$commit" != "$head" ]]; then
      [[ "$differing" != *" $commit "* ]] || continue
      head_pid="${head_pid:-$(patch_id_of "$base" "$head")}" || undetermined "the head's diff would not read"
      pid="$(patch_id_of "$base" "$commit")" || undetermined "the diff at ${commit:0:8} would not read"
      [[ "$pid" == "$head_pid" ]] || { differing+="$commit "; continue; }
    fi
    echo "pr-review-verdict: NOT POSTED. #$n already has a review at an equal patch: $state at $when ($url, commit ${commit:0:8}," \
         "head ${head:0:8}). A second review at one patch is refused whatever its verdict; if this refusal is wrong, escalate to" \
         "product-manager rather than posting again." >&2
    exit "$EXIT_SECOND_REVIEW"
  done <<<"$reviews"
}

refuse_second_review

gh pr review "$n" --repo "$REPO" "$flag" --body "$body"
attribute || true
