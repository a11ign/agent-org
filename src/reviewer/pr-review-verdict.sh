#!/usr/bin/env bash
# Posts a reviewer's verdict as a GitHub review (#1931; ceo's 2026-09-19 ruling, #1761) AND records
# WHICH SESSION POSTED IT, as a commit status the org can read without parsing prose (#2127).
#
# THE DOOR. The reviewer's own execpolicy on the host forbids `gh pr review` outright, because
# a bare prefix rule cannot tell `--approve` from `--dismiss` or `--comment` once a PR number precedes
# the flag. This script is the one narrow way a review is posted, which is exactly why the attribution
# belongs here: it is the only point in the whole path where the reviewing session's identity is known
# at all. GitHub loses it one line later -- every reviewer instance shares the `a11ign-bot` account,
# so `user.login` on the posted review says nothing (see review-attribution.ts for the measurement).
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
# well as a comment (`verdictBearers` in review-verdict.ts), which is what made the second write unnecessary.
#
# Usage: pr-review-verdict <pr-number> <convinced|not-convinced> <verdict-comment-file>
# Exit:  0  the review posted (attribution is best-effort and never changes this)
#        2  a malformed call, or an environment failure offered as a verdict (nothing was sent to `gh` for either)
#        3  REFUSED: the pull request already has a verdict at an equal patch (a11ign#3050) -- an APPROVED or CHANGES_REQUESTED review whose
#           body opens `**Review of #<n> at ` and whose commit is the head or has the head's patch id; a review that opens any other way, such
#           as a code owner's scoped approval, is not counted (a11ign#3087). Nothing was posted, and the
#           message names the review that stands. A refusal that is wrong goes to `product-manager`, never to a second review.
#           A CHANGES_REQUESTED posted while a check run failed at its commit, when none fails at the head, does not stand (a11ign#3199).
#           EXACTLY ONE THING SUPERSEDES A STANDING REVIEW (agent-org#514, ceo's ruling on a11ign#4558): an APPROVE, over a standing
#           CHANGES_REQUESTED that this same account posted, whose body NAMES that review on a line after the verdict line (its id, or
#           `Review of #<n> at <sha8>`). A block is superseded once and by an approve only: a repeat of the same state, a CHANGES_REQUESTED
#           over an APPROVED, an APPROVE that names nothing, and an APPROVE over another account's block are all still refused.
#        4  COULD NOT TELL whether it has one (a `gh` read failed). Nothing was posted; the door is safe to run again.
#        5  REFUSED: the head moved since you reviewed it (#3640). The opener names the commit reviewed and the pull request's head now
#           has a DIFFERENT patch. `gh pr review` has no commit option and attaches to whatever the head is, so posting would hand
#           `reviewDecision` an approval of a patch the text does not describe. Nothing was posted; the message names the head to review.
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
# ONE SPELLING WITH `attributionContext` IN review-attribution.ts. A shell writer and a JS reader cannot
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
# THE LINES AFTER THE OPENER, where a superseding verdict must name the review it supersedes (agent-org#514). Never the opener itself: at an
# unchanged head it already reads `Review of #<n> at <that head>`, so a check that included it would be met by every verdict at all.
after_opener="$(tail -n +2 "$file")"
[[ "$opener" == "**Review of #$n at "* ]] || { echo "pr-review-verdict: first line of '$file' is not the verdict line for #$n" >&2; exit 2; }
# THE COMMIT THE VERDICT IS ABOUT (#3640). The sha after `at`, in backticks, is the spelling `HEAD_AFTER_AT` in review-verdict.ts reads, so the
# door and the gate agree on which commit a verdict names. A verdict that names none cannot be shown to be about the head it will attach to,
# and the gate would never count it, so it is refused here rather than posted unchecked.
NAMED_SHA_PATTERN='(^|[^[:alnum:]_])(at|of)[[:space:]]+`([0-9a-fA-F]{7,40})`'
named_sha_in() { [[ "$1" =~ $NAMED_SHA_PATTERN ]] && echo "${BASH_REMATCH[3]}"; }
named="$(named_sha_in "$opener")" || named=""
[[ -n "$named" ]] || { echo "pr-review-verdict: the verdict line of '$file' names no commit; it must read 'at <sha>' with the sha in backticks (#3640)" >&2; exit 2; }

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
# pull request n runs in `<root>/reviews/reviewer-<n>` (`reviewCheckoutPath` in wake.ts). Prints the name, or nothing.
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

# The names of the check runs that concluded `failure` at a commit, one per line, nothing when none did. Non-zero when the read failed: an unread
# check is not a green one. An abbreviated sha resolves, as it does in the compare read above.
failing_checks_at() {
  gh api "repos/$REPO/commits/$1/check-runs?per_page=100" --paginate \
    --jq '.check_runs[] | select(.conclusion == "failure") | .name'
}

# A REFUSAL THAT NO LONGER APPLIES IS A NEW QUESTION (a11ign#3199, from #3154). A verdict is valid for a patch ON A BASE, and the patch id hashes only
# what the pull request adds and removes: #3154 was refused for `ts / run` failing on a defect in `main`, `main` was fixed, Dependabot rebased, the
# patch was byte-for-byte the same and this door refused the follow-up for 18 minutes, until a human dismissed the review. The fact that tells that
# case from #3033 (a merge of `main`, nothing failing) is in check runs the door can already read, never in the review's prose: LIFTED when the review
# is a CHANGES_REQUESTED, a check run concluded `failure` at its commit, and none does at the head. `refusalLifted` in review-verdict.ts is the same
# rule for the gate, and `door-refuses-second-review.test.ts` runs one table through both so they cannot drift. One read per commit compared, and none
# unless an equal-patch refusal is found; a read that fails is COULD-NOT-TELL, never green.
LIFTED=" "
STANDING=" "
head_failing=""
head_read=""
refusal_lifted() {
  local commit="$1" head="$2" failed_then
  [[ "$STANDING" != *" $commit "* ]] || return 1
  [[ "$LIFTED" != *" $commit "* ]] || return 0
  failed_then="$(failing_checks_at "$commit")" || undetermined "the check runs at ${commit:0:8} would not read"
  if [[ -n "$failed_then" && -z "$head_read" ]]; then
    head_failing="$(failing_checks_at "$head")" || undetermined "the check runs at the head would not read"
    head_read=1
  fi
  if [[ -n "$failed_then" && -z "$head_failing" ]]; then LIFTED+="$commit "; return 0; fi
  STANDING+="$commit "
  return 1
}

# Whether two spellings of a commit are one commit: a full sha and its abbreviation, either way round, as `headMatches` in review-verdict.ts.
same_commit() {
  local a="${1,,}" b="${2,,}"
  # AN EMPTY SPELLING IS A PREFIX OF EVERYTHING, so it must never be read as a match: absence of a commit is not equality with one.
  [[ -n "$a" && -n "$b" ]] || return 1
  [[ "$a" == "$b"* || "$b" == "$a"* ]]
}

PR_HEAD=""
PR_BASE=""
HEAD_PID=""
read_pull_request() {
  local pr
  pr="$(gh api "repos/$REPO/pulls/$n" --jq '[.head.sha, .base.ref] | @tsv')" || undetermined "the pull request would not read"
  IFS=$'\t' read -r PR_HEAD PR_BASE <<<"$pr"
}

# Sets HEAD_PID to the head's patch id, reading it once however many of the checks below ask. NEVER CALLED INSIDE `$( )`: the cache and the
# `undetermined` exit would both be lost in the subshell.
read_head_patch_id() {
  [[ -n "$HEAD_PID" ]] || HEAD_PID="$(patch_id_of "$PR_BASE" "$PR_HEAD")" || undetermined "the head's diff would not read"
}

# THE VERDICT IS ABOUT THE COMMIT ITS OPENER NAMES, AND `gh pr review` ATTACHES IT TO THE HEAD (#3640, found on #3623). `gh pr review` has no
# commit option, so a review posted after the author pushed lands on the NEW head while its text describes the old one: #3623's approval, headed
# `61389c15`, was recorded on `0af5fe4a`, two commits that are not the same patch, and `reviewDecision` counted it for a changeset its text never
# described. THE SAME TEST AS THE SECOND-REVIEW REFUSAL, BY PATCH AND NOT BY SHA: a merge of `main` moves the head and leaves the work (#3033), and
# refusing that would send a reviewer back to re-read nothing. A read that fails is COULD-NOT-TELL, never "unchanged".
EXIT_HEAD_MOVED=5
refuse_stale_head() {
  same_commit "$named" "$PR_HEAD" && return 0
  local named_pid; named_pid="$(patch_id_of "$PR_BASE" "$named")" || undetermined "the diff at ${named:0:8}, the commit the verdict names, would not read"
  read_head_patch_id
  [[ "$named_pid" != "$HEAD_PID" ]] || return 0
  echo "pr-review-verdict: NOT POSTED. The head moved since you reviewed it: your verdict names ${named:0:8}, #$n's head is now ${PR_HEAD:0:8} and" \
       "its patch differs. \`gh pr review\` would attach this verdict to ${PR_HEAD:0:8}, a change it does not describe. Review \`${PR_HEAD}\`," \
       "name it in the verdict line, and run the door again." >&2
  exit "$EXIT_HEAD_MOVED"
}

# WHETHER THE VERDICT FILE NAMES THE REVIEW IT SUPERSEDES (agent-org#514): its id as a whole number, or the standing review's own opener
# `Review of #<n> at <sha8>`, on a line AFTER the verdict line. This is the audit line without being a gate on anything but this one path.
names_review() {
  local rid="$1" commit="$2"
  [[ -n "$after_opener" && -n "$commit" ]] || return 1
  if grep -qF -- "Review of #$n at \`${commit:0:8}" <<<"$after_opener"; then return 0; fi
  [[ "$rid" =~ ^[0-9]+$ ]] && grep -qE "(^|[^0-9])$rid([^0-9]|\$)" <<<"$after_opener"
}

# A CORRECTION IS THE ONE SECOND REVIEW AT AN EQUAL PATCH THE DOOR POSTS (agent-org#514, from a11ign#4558). `reviewer` read the head COMMIT's diff
# against its parent, not the pull request's against `main`, and its CHANGES_REQUESTED stood at an unchanged head with no way for its own reviewer
# to supersede it: the repeat rule could not tell a correction from a repeat, and `reviewDecision` stayed CHANGES_REQUESTED until somebody with admin
# dismissed it. The ruling is narrow so #3050's six-reviews-for-one-commit bound holds: only an APPROVE (the caller checks the verdict and the
# standing review's state), only over a block THIS ACCOUNT posted, only when the body names it. The account is read from `gh` and only on this
# path, so the common path costs no call; a read that fails is COULD-NOT-TELL, never "yours".
# EVERY REVIEWER INSTANCE SHARES ONE ACCOUNT (see the header), so "the same reviewer" is the account and not the session: the door has no
# session-level fact for a review that is not its own to read back. Sets SUPERSEDE_HINT to what the refusal should add.
SUPERSEDE_HINT=""
supersedes_block() {
  local rid="$1" commit="$2" standing_user="$3" me
  if ! names_review "$rid" "$commit"; then
    SUPERSEDE_HINT=" If this APPROVE corrects that block, name it on a line AFTER the verdict line: its id ($rid) or \`Review of #$n at ${commit:0:8}\`."
    return 1
  fi
  me="$(gh api user --jq .login)" || undetermined "the reviewing account would not read"
  [[ -n "$me" && "$me" == "$standing_user" ]] && return 0
  SUPERSEDE_HINT=" That block was posted by $standing_user, not by this account (${me:-unknown}), so it is not yours to supersede."
  return 1
}

refuse_second_review() {
  local reviews lapsed when state user commit url kind rid pid differing=" "
  # ONLY A REVIEW THE DOOR COULD HAVE POSTED: one of the two states it posts, AND a body that opens as a verdict (the same opener the
  # door itself requires above). A DISMISSED review no longer stands, a COMMENTED one is not a verdict, and a code owner's hand-written
  # approval of one path (agent-org#66: "approved for the workflow change only") opens some other way and is not the duplicate
  # a11ign#3050 exists to stop. `$n` is digits by now, so it is safe inside the jq program.
  #
  # AN APPROVAL THE SAME ACCOUNT'S LATER DISMISSAL SUPERSEDED DOES NOT STAND (#4029, found on agent-org#358). GitHub decides `reviewDecision` from each
  # account's LATEST non-COMMENTED review. The door posted APPROVED at head H, the reviewer then ran `gh pr review --approve` by hand (a duplicate) and
  # dismissed it: GitHub read REVIEW_REQUIRED and BLOCKED while a door that still saw a standing approval refused the one post that clears it, and only
  # a push did, which voids the verdict already given. So a DISMISSED review of ANY body is read as well, and a verdict by an account whose newest review
  # it is does not stand. The `kind` column carries the opener test out of jq, because `--paginate` runs the program once per page and "an account's
  # newest review" is a fact about all of them.
  #
  # THE COMMIT A REVIEW IS AT IS THE ONE ITS BODY NAMES (#3640), the same reading as `named` above and as the gate's `verdictAtHead`; `commit_id`
  # is only where GitHub attached it, which is the HEAD at the moment of posting and so says nothing about what the reviewer read. It is the
  # fallback for a body that names none. The named one may be an abbreviation; the compare and check-run reads below resolve it.
  reviews="$(gh api "repos/$REPO/pulls/$n/reviews?per_page=100" --paginate \
      --jq '.[] | .body //= "" | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "DISMISSED") | [.submitted_at, .state, (.user.login // "-"), ((.body | split("\n")[0] | capture("(^|[^A-Za-z0-9_])(at|of)\\s+`(?<sha>[0-9a-fA-F]{7,40})`")? | .sha) // .commit_id), .html_url, (if .state != "DISMISSED" and (.body | startswith("**Review of #'"$n"' at ")) then "verdict" else "other" end), ((.id // "-") | tostring)] | @tsv' \
      | sort -r)" || undetermined "its reviews would not read"
  lapsed=" $(awk -F'\t' '!seen[$3]++ && $2 == "DISMISSED" { printf "%s ", $3 }' <<<"$reviews")"
  [[ -n "$reviews" ]] || return 0
  while IFS=$'\t' read -r when state user commit url kind rid; do
    [[ "$kind" == verdict && "$lapsed" != *" $user "* ]] || continue
    if ! same_commit "$commit" "$PR_HEAD"; then
      [[ "$differing" != *" $commit "* ]] || continue
      pid="$(patch_id_of "$PR_BASE" "$commit")" || undetermined "the diff at ${commit:0:8} would not read"
      read_head_patch_id
      [[ "$pid" == "$HEAD_PID" ]] || { differing+="$commit "; continue; }
      # An equal patch at ANOTHER commit: a refusal posted for a check that has since cleared no longer applies. An approval always does (#3033).
      if [[ "$state" == CHANGES_REQUESTED ]] && refusal_lifted "$commit" "$PR_HEAD"; then continue; fi
    fi
    SUPERSEDE_HINT=""
    if [[ "$verdict" == convinced && "$state" == CHANGES_REQUESTED ]] && supersedes_block "$rid" "$commit" "$user"; then
      echo "pr-review-verdict: superseding $state at $when ($url, commit ${commit:0:8}) with this APPROVE, which names it (agent-org#514)." >&2
      return 0
    fi
    echo "pr-review-verdict: NOT POSTED. #$n already has a review at an equal patch: $state at $when ($url, commit ${commit:0:8}," \
         "head ${PR_HEAD:0:8}). A second review at one patch is refused; the one exception is an APPROVE that names this account's" \
         "own standing CHANGES_REQUESTED.$SUPERSEDE_HINT If this refusal is wrong, escalate to" \
         "product-manager rather than posting again." >&2
    exit "$EXIT_SECOND_REVIEW"
  done <<<"$reviews"
}

read_pull_request
refuse_stale_head
refuse_second_review

gh pr review "$n" --repo "$REPO" "$flag" --body "$body"
attribute || true
