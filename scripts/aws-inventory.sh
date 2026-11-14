#!/usr/bin/env bash
# Read-only inventory of everything in the AWS project: the CloudFormation stacks and their
# resources, plus resources outside the stacks (the ACM certificate in us-east-1, budgets) and
# anything that should not be there (extra buckets, functions, tables, user pools).
# Only describe/list calls; it changes nothing.
# Usage: npm run inventory   (uses AWS_PROFILE from the env or from .env.deploy)
set -uo pipefail
cd "$(dirname "$0")/.."

[ -f .env.deploy ] && . ./.env.deploy   # local, gitignored: e.g. AWS_PROFILE=myprofile
[ -n "${AWS_PROFILE:-}" ] && export AWS_PROFILE
R="${AWS_REGION:-eu-north-1}"   # the project's selected Region
G=us-east-1                     # only global-service bits live here (ACM for CloudFront)
export AWS_PAGER=""

ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || { echo "inventory: no valid AWS session: run 'aws login --profile \$AWS_PROFILE'" >&2; exit 1; }

h() { printf '\n== %s\n' "$*"; }
run() { "$@" 2>&1 | sed '/^$/d'; }

h "Project $ACCOUNT, Region $R"
run aws freetier get-account-plan-state \
  --query '[accountPlanType,accountPlanStatus,accountPlanRemainingCredits.amount,accountPlanExpirationDate]' --output text

h "Budgets"
run aws budgets describe-budgets --account-id "$ACCOUNT" \
  --query 'Budgets[].[BudgetName,BudgetLimit.Amount,BudgetLimit.Unit]' --output text

STACKS=$(aws cloudformation list-stacks --region "$R" --query 'StackSummaries[?StackStatus!=`DELETE_COMPLETE`].StackName' --output text)
h "CloudFormation stacks ($R)"
run aws cloudformation list-stacks --region "$R" \
  --query 'StackSummaries[?StackStatus!=`DELETE_COMPLETE`].[StackName,StackStatus,LastUpdatedTime||CreationTime]' --output table

for s in $STACKS; do
  h "Stack $s"
  run aws cloudformation list-stack-resources --region "$R" --stack-name "$s" \
    --query 'StackResourceSummaries[].[ResourceType,LogicalResourceId,PhysicalResourceId,ResourceStatus]' --output table
done

h "ACM certificates ($G, used by CloudFront; not in a stack)"
run aws acm list-certificates --region "$G" \
  --includes keyTypes=EC_prime256v1,EC_secp384r1,RSA_2048,RSA_3072,RSA_4096 \
  --query 'CertificateSummaryList[].[DomainName,KeyAlgorithm,Status,NotAfter,RenewalEligibility]' --output text

h "CloudFront (global)"
run aws cloudfront list-distributions \
  --query 'DistributionList.Items[].[Id,DomainName,join(`,`,Aliases.Items||`[]`),Status]' --output text
run aws cloudfront list-functions --query 'FunctionList.Items[].Name' --output text

h "Route 53 hosted zones (global)"
run aws route53 list-hosted-zones --query 'HostedZones[].[Name,Id,ResourceRecordSetCount]' --output text

# Everything below should match the stacks above; anything extra was made by hand.
h "S3 buckets"
run aws s3api list-buckets --query 'Buckets[].[Name,CreationDate]' --output text

h "Lambda, DynamoDB, API Gateway, Cognito ($R)"
run aws lambda list-functions --region "$R" --query 'Functions[].[FunctionName,Runtime,LastModified]' --output text
for t in $(aws dynamodb list-tables --region "$R" --query 'TableNames[]' --output text); do
  run aws dynamodb describe-table --region "$R" --table-name "$t" \
    --query 'Table.[TableName,BillingModeSummary.BillingMode,ItemCount,TableSizeBytes,DeletionProtectionEnabled]' --output text
done
run aws apigatewayv2 get-apis --region "$R" --query 'Items[].[Name,ApiId,ApiEndpoint]' --output text
run aws cognito-idp list-user-pools --region "$R" --max-results 60 --query 'UserPools[].[Name,Id]' --output text

h "Log groups ($R and $G)"
for r in "$R" "$G"; do
  run aws logs describe-log-groups --region "$r" \
    --query "logGroups[].[\`$r\`,logGroupName,retentionInDays||\`never-expires\`,storedBytes]" --output text
done

h "WAF web ACLs for CloudFront ($G)"
run aws wafv2 list-web-acls --scope CLOUDFRONT --region "$G" --query 'WebACLs[].Name' --output text

h "IAM roles (excluding AWS-managed service roles)"
run aws iam list-roles \
  --query 'Roles[?!starts_with(Path,`/aws-service-role/`) && !starts_with(Path,`/aws-reserved/`)].RoleName' --output text

echo
echo "Done. Costs: Billing and Cost Management > Cost Explorer in the console."
