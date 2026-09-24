#!/usr/bin/env bash
# Publish a signed xpi to the GitHub Pages update channel and create the
# GitHub release. Shared by the Release and Publish approved version workflows.
#
#   bash .github/scripts/publish-site.sh <version> <signed.xpi>
#
# GitHub Releases reject .xpi as an asset, so the signed xpi is hosted on
# GitHub Pages (alongside updates.json) instead. Pages serves the docs/
# directory from the main branch (Settings → Pages → Deploy from a branch →
# main → /docs). docs/ becomes the site root, so the URLs in updates.json and
# the manifest's update_url stay root-relative. update_hash lets Firefox
# verify the downloaded xpi before installing it.
#
# Idempotent: a version already in docs/ on main is not committed again, and
# an existing GitHub release is left alone, so both workflows can race safely.
# Needs GH_TOKEN for `gh`.
set -euo pipefail

VERSION="$1"
XPI="$2"
SITE="$(mktemp -d)"

cp "$XPI" "$SITE/tarara-${VERSION}.xpi"
HASH="$(sha256sum "$SITE/tarara-${VERSION}.xpi" | cut -d' ' -f1)"
cat > "$SITE/updates.json" <<EOF
{
  "addons": {
    "tarara@tararafox": {
      "updates": [
        {
          "version": "${VERSION}",
          "update_link": "https://knezovic.github.io/TararaFox/tarara-${VERSION}.xpi",
          "update_hash": "sha256:${HASH}"
        }
      ]
    }
  }
}
EOF
cat > "$SITE/index.html" <<EOF
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tarara</title>
</head>
<body>
<h1>Tarara</h1>
<p>Self-hosted update channel for the Tarara Firefox extension (unlisted on AMO).</p>
<h2>Latest release &mdash; v${VERSION}</h2>
<ul>
<li><a href="tarara-${VERSION}.xpi">Signed xpi (tarara-${VERSION}.xpi)</a></li>
<li><a href="updates.json">Update manifest (updates.json)</a></li>
</ul>
<p>To install: open the xpi in Firefox (drag it into a tab, or use <code>about:addons</code> &rarr; gear icon &rarr; &ldquo;Install Add-on From File&rdquo;). Updates are delivered automatically via the manifest.</p>
</body>
</html>
EOF

# Commit onto the latest main (never onto a tag checkout), so pushes made to
# main meanwhile are kept. Retry if main moves between fetch and push.
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
published=""
for attempt in 1 2 3; do
  git fetch origin main
  git checkout -B publish origin/main
  if [ -f "docs/tarara-${VERSION}.xpi" ]; then
    echo "v${VERSION} is already in docs/ on main; not committing it again."
    published=yes
    break
  fi
  mkdir -p docs
  cp "$SITE/tarara-${VERSION}.xpi" "$SITE/updates.json" "$SITE/index.html" docs/
  git add "docs/tarara-${VERSION}.xpi" docs/updates.json docs/index.html
  git commit -m "Publish v${VERSION}: signed xpi + updates.json + index.html to docs/ (GitHub Pages)"
  if git push origin HEAD:main; then
    published=yes
    break
  fi
  echo "main moved while publishing (attempt ${attempt}), retrying"
  sleep 5
done
if [ -z "$published" ]; then
  echo "::error::Could not push the docs/ update to main after 3 attempts"
  exit 1
fi

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  echo "GitHub release v${VERSION} already exists."
else
  gh release create "v${VERSION}" \
    --title "v${VERSION}" \
    --notes "Tarara v${VERSION}. Signed xpi: https://knezovic.github.io/TararaFox/tarara-${VERSION}.xpi" \
    --verify-tag
fi
