#!/usr/bin/env bash
# Installs the reviewers' door -- `pr-review-verdict.sh` -- to the place it RUNS from (#2193).
#
# WHY THIS EXISTS. #2127 made the door reviewable by moving its source into the repository, and left the
# other half undone: the file that executes is a COPY on the host, and nothing copied it. The copy kept
# its pre-#2127 1,260 bytes for a day, no review carried the `review/<session>` status the new source
# writes, and nothing anywhere compared the two -- `review-attribution.test.ts` reads the SOURCE, which is
# exactly right and cannot see the install. This script is the install as a step a reviewer can read, and
# the check in the row's Acceptance runs it into a temporary directory and compares bytes.
#
# WHAT IT CLAIMS, AND WHAT IT CANNOT. It makes the installed file byte-identical to the source, and it
# checks that by reading the installed file back rather than trusting the copy. It cannot see whether the
# reviewers' panes carry `A11Y_REVIEWER_SESSION`; without it the door posts UNATTRIBUTED, which looks the
# same from GitHub as an uninstalled door. So the last thing it prints is the positive control to read.
#
# Usage: install-reviewer-bin.sh [destination]
#   destination  defaults to $A11Y_REVIEWER_BIN/pr-review-verdict, and $A11Y_REVIEWER_BIN defaults to
#                $HOME/reviewer/bin -- the directory the reviewers' execpolicy allows the door from.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_file="$here/pr-review-verdict.sh"
dest="${1:-${A11Y_REVIEWER_BIN:-$HOME/reviewer/bin}/pr-review-verdict}"

[[ -f "$source_file" ]] || { echo "install-reviewer-bin: source '$source_file' is missing" >&2; exit 2; }
dest_dir="$(dirname "$dest")"
mkdir -p "$dest_dir"

# Keep what is being replaced, once per distinct content. Restoring a door that posted reviews is
# cheaper than reconstructing it from a diff, and an identical file has nothing to keep.
if [[ -e "$dest" ]] && ! cmp -s "$source_file" "$dest"; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$dest" "$dest.bak-$stamp"
  echo "install-reviewer-bin: kept the previous door at $dest.bak-$stamp"
fi

# Write beside the target and rename over it, so a reviewer invoking the door mid-install runs either the
# old file or the new one, never half of one. mktemp in the SAME directory keeps the rename atomic.
staged="$(mktemp "$dest_dir/.pr-review-verdict.XXXXXX")"
trap 'rm -f "${staged:?}"' EXIT
cp "$source_file" "$staged"
chmod 755 "$staged"
mv -f "$staged" "$dest"

cmp -s "$source_file" "$dest" || { echo "install-reviewer-bin: '$dest' is NOT identical to the source after install" >&2; exit 1; }
echo "install-reviewer-bin: $dest is byte-identical to $source_file ($(wc -c < "$dest") bytes)"

if [[ -z "${A11Y_REVIEWER_SESSION:-}" ]]; then
  echo "install-reviewer-bin: NOTE A11Y_REVIEWER_SESSION is unset HERE; that says nothing about the reviewers' panes." >&2
fi
echo "install-reviewer-bin: positive control -- the next review posted through the door must carry a review/<session> commit status."
echo "install-reviewer-bin: a review with NO status after this is an unset A11Y_REVIEWER_SESSION in that pane (stderr says so), not an uninstalled door."
