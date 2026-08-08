#!/usr/bin/env bash
# Publishes the version main carries, exactly once: npm publish via
# trusted publishing, the vX.Y.Z tag, and the GitHub release with that
# version's CHANGELOG section. Tagging is done here, not by changeset
# publish, because the workspace makes this repository a monorepo in
# changesets' eyes and its tags would be agent-koans@X.Y.Z instead of
# the vX.Y.Z form this repository uses.
set -euo pipefail

version=$(node -p "require('./package.json').version")

if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  echo "v$version already released; nothing to do."
  exit 0
fi
if npm view "agent-koans@$version" version >/dev/null 2>&1; then
  echo "agent-koans@$version is on npm but untagged. Backfill the v$version tag by hand."
  exit 0
fi
if ls release-drafts/*.md >/dev/null 2>&1; then
  echo "release-drafts/ still holds unpolished notes; refusing to publish." >&2
  echo "Rewrite them into .changeset/*.md, delete the drafts, and merge that PR." >&2
  exit 1
fi

npm publish
git tag "v$version"
git push origin "v$version"
notes=$(awk -v ver="$version" '$0 == "## " ver {flag=1; next} /^## / {flag=0} flag' CHANGELOG.md)
gh release create "v$version" --title "v$version" --notes "${notes:-See CHANGELOG.md}"
