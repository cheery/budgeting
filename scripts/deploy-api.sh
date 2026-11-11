#!/usr/bin/env bash
# Deploy the cloud storage API (stack "ennakkoon-api", see infra/ennakkoon-api.yaml).
# Packages server/handler.mjs + core.js, uploads the zip to the artifact bucket (stack
# "ennakkoon-artifacts") and creates or updates the stack. Parameters you don't pass keep their
# previous values (e.g. GoogleSecretArn). Extra args go to `aws cloudformation deploy`, e.g.
#   npm run deploy:api -- --parameter-overrides GoogleSecretArn=arn:aws:secretsmanager:...
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.deploy ] && . ./.env.deploy
export AWS_REGION="${AWS_REGION:-eu-north-1}"
[ -n "${AWS_PROFILE:-}" ] && export AWS_PROFILE
die() { echo "deploy-api: $*" >&2; exit 1; }

npm test --silent >/dev/null || die "tests failed (run npm test)"
aws sts get-caller-identity >/dev/null 2>&1 || die "no AWS credentials: run 'aws login'"

BUCKET=$(aws cloudformation describe-stacks --stack-name ennakkoon-artifacts \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucket'].OutputValue" --output text)
[ -n "$BUCKET" ] || die "artifact bucket not found (stack ennakkoon-artifacts)"

read -r ZIP KEY < <(scripts/package-api.sh)
aws s3 cp --only-show-errors "$ZIP" "s3://$BUCKET/$KEY"
echo "Uploaded $KEY"

OVERRIDES=(CodeBucket="$BUCKET" CodeKey="$KEY")
if [ "${1:-}" = "--parameter-overrides" ]; then shift; OVERRIDES+=("$@"); set --; fi
aws cloudformation deploy --stack-name ennakkoon-api --template-file infra/ennakkoon-api.yaml \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "${OVERRIDES[@]}" "$@"

aws cloudformation describe-stacks --stack-name ennakkoon-api \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
