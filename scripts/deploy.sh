#!/usr/bin/env bash
# Deploy the app shell to AWS (S3 + CloudFront, stack "enno-hosting", see infra/).
# Usage: npm run deploy            (uses AWS_PROFILE from the env or from .env.deploy)
#        npm run deploy -- --force (skip the git checks; still runs tests and the CACHE check)
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.deploy ] && . ./.env.deploy   # local, gitignored: e.g. AWS_PROFILE=myprofile
export AWS_REGION="${AWS_REGION:-eu-north-1}"
[ -n "${AWS_PROFILE:-}" ] && export AWS_PROFILE
STACK="${STACK:-enno-hosting}"
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1
die() { echo "deploy: $*" >&2; exit 1; }

# 1. Only deploy what is on GitHub's main, so AWS and GitHub Pages serve the same code.
if [ $FORCE = 0 ]; then
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "not on main (use --force to override)"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "uncommitted changes (commit and push first)"
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main differs from origin/main (push or pull first)"
fi

# 2. Tests.
npm test --silent >/dev/null || die "tests failed (run npm test)"

# 3. Where to deploy: read from the CloudFormation stack, nothing hard-coded.
aws sts get-caller-identity >/dev/null 2>&1 || die "no AWS credentials: run 'aws login' (and set AWS_PROFILE in .env.deploy)"
out() { aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out BucketName); DIST=$(out DistributionId); URL=$(out SiteUrl)
[ -n "$BUCKET" ] && [ -n "$DIST" ] || die "could not read outputs of stack $STACK"

# 4. Files to upload: the service worker's SHELL list plus sw.js itself.
FILES=$(node -e "
  const s = require('fs').readFileSync('sw.js', 'utf8');
  const list = eval('[' + s.match(/SHELL = \[([\s\S]*?)\]/)[1] + ']');
  console.log(list.filter(f => f !== './').concat('sw.js').join('\n'));")

# 5. CACHE guard: if any shell file changed but CACHE in sw.js did not, installed apps would
#    keep the old code. Compare against what CloudFront serves now.
LIVE_CACHE=$(curl -fsS "${URL}sw.js" 2>/dev/null | grep -o "budget-v[0-9]*" | head -1 || true)
LOCAL_CACHE=$(grep -o "budget-v[0-9]*" sw.js | head -1)
CHANGED=""
for f in $FILES; do
  curl -fsS "${URL}$f" 2>/dev/null | cmp -s - "$f" || CHANGED="$CHANGED $f"
done
[ -n "$CHANGED" ] || { echo "Nothing changed, already live: $URL"; exit 0; }
echo "Changed:$CHANGED"
if [ -n "$LIVE_CACHE" ] && [ "$LIVE_CACHE" = "$LOCAL_CACHE" ]; then
  die "shell files changed but CACHE is still $LOCAL_CACHE: bump it in sw.js"
fi

# 6. Upload. Browsers revalidate every time (max-age=0); CloudFront keeps a copy until the
#    invalidation below (s-maxage). The service worker handles offline use.
CC="public, max-age=0, must-revalidate, s-maxage=31536000"
ctype() { case "$1" in
  *.html) echo "text/html; charset=utf-8" ;;  *.css) echo "text/css; charset=utf-8" ;;
  *.js) echo "text/javascript; charset=utf-8" ;; *.webmanifest) echo "application/manifest+json" ;;
  *.svg) echo "image/svg+xml" ;; *.png) echo "image/png" ;; *) die "unknown type: $1" ;; esac; }
for f in $FILES; do
  aws s3 cp --only-show-errors "$f" "s3://$BUCKET/$f" --content-type "$(ctype "$f")" --cache-control "$CC"
  echo "  uploaded $f"
done

# 7. Clear CloudFront's copy so the new version is served right away.
ID=$(aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" \
  --query Invalidation.Id --output text)
echo "Invalidation $ID started (usually done in under a minute)."
echo "Deployed $LOCAL_CACHE to $URL"
