#!/usr/bin/env bash
# the fake code host's door installer: it puts the fake door where the host runs it from, keeping what it replaces beside it, as a real code host's installer does.
# Usage: install-reviewer-bin.sh <destination>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_file="$here/pr-review-verdict.sh"
dest="${1:?destination}"
mkdir -p "$(dirname "$dest")"
if [[ -e "$dest" ]] && ! cmp -s "$source_file" "$dest"; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$dest" "$dest.bak-$stamp"
  echo "install-reviewer-bin: kept the previous door at $dest.bak-$stamp"
fi
cp "$source_file" "$dest"
chmod 755 "$dest"
cmp -s "$source_file" "$dest" || { echo "install-reviewer-bin: '$dest' is NOT identical to the source after install" >&2; exit 1; }
echo "install-reviewer-bin: $dest is byte-identical to $source_file"
