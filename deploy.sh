#!/bin/sh
LAMBDA_VERSION="2"
export AWS_PROFILE=ratingsuite
cd channel-api && rm .deploy* ; touch .deploy_$LAMBDA_VERSION && sudo sam build && sam deploy
cd ../contact-api && rm .deploy* ; touch .deploy_$LAMBDA_VERSION && sudo sam build && sam deploy
cd ../notification-api && rm .deploy* ; touch .deploy_$LAMBDA_VERSION && sudo sam build && sam deploy
cd ../productchannel-api && rm .deploy* ; touch .deploy_$LAMBDA_VERSION && sudo sam build && sam deploy
cd ../review-api && rm .deploy* ; touch .deploy_$LAMBDA_VERSION && sudo sam build && sam deploy
cd ../subscription-api && rm .deploy* ; touch .deploy_$LAMBDA_VERSION && sudo sam build && sam deploy
cd ../user-api && rm .deploy* ; touch .deploy_$LAMBDA_VERSION && sudo sam build && sam deploy
cd ../user-preference-api && rm .deploy* ; touch .deploy_$LAMBDA_VERSION && sudo sam build && sam deploy
aws lambda publish-version --function-name channel-api
aws lambda publish-version --function-name contact-api
aws lambda publish-version --function-name notification-api
aws lambda publish-version --function-name productchannel-api
aws lambda publish-version --function-name review-api
aws lambda publish-version --function-name subscription-api
aws lambda publish-version --function-name user-api
aws lambda publish-version --function-name user-preference-api
aws lambda add-permission   --function-name "arn:aws:lambda:us-east-1:996427988132:function:channel-api:$LAMBDA_VERSION"   --source-arn  "arn:aws:execute-api:us-east-1:996427988132:fm1l6yqvdg/*" --region us-east-1  --principal apigateway.amazonaws.com   --statement-id lambda_version_up   --action lambda:InvokeFunction
aws lambda add-permission   --function-name "arn:aws:lambda:us-east-1:996427988132:function:contact-api:$LAMBDA_VERSION"   --source-arn  "arn:aws:execute-api:us-east-1:996427988132:fm1l6yqvdg/*" --region us-east-1  --principal apigateway.amazonaws.com   --statement-id lambda_version_up   --action lambda:InvokeFunction
aws lambda add-permission   --function-name "arn:aws:lambda:us-east-1:996427988132:function:notification-api:$LAMBDA_VERSION"   --source-arn  "arn:aws:execute-api:us-east-1:996427988132:fm1l6yqvdg/*" --region us-east-1  --principal apigateway.amazonaws.com   --statement-id lambda_version_up   --action lambda:InvokeFunction
aws lambda add-permission   --function-name "arn:aws:lambda:us-east-1:996427988132:function:productchannel-api:$LAMBDA_VERSION"   --source-arn  "arn:aws:execute-api:us-east-1:996427988132:fm1l6yqvdg/*" --region us-east-1  --principal apigateway.amazonaws.com   --statement-id lambda_version_up   --action lambda:InvokeFunction
aws lambda add-permission   --function-name "arn:aws:lambda:us-east-1:996427988132:function:review-api:$LAMBDA_VERSION"   --source-arn  "arn:aws:execute-api:us-east-1:996427988132:fm1l6yqvdg/*" --region us-east-1  --principal apigateway.amazonaws.com   --statement-id lambda_version_up   --action lambda:InvokeFunction
aws lambda add-permission   --function-name "arn:aws:lambda:us-east-1:996427988132:function:subscription-api:$LAMBDA_VERSION"   --source-arn  "arn:aws:execute-api:us-east-1:996427988132:fm1l6yqvdg/*" --region us-east-1  --principal apigateway.amazonaws.com   --statement-id lambda_version_up   --action lambda:InvokeFunction
aws lambda add-permission   --function-name "arn:aws:lambda:us-east-1:996427988132:function:user-api:$LAMBDA_VERSION"   --source-arn  "arn:aws:execute-api:us-east-1:996427988132:fm1l6yqvdg/*" --region us-east-1  --principal apigateway.amazonaws.com   --statement-id lambda_version_up   --action lambda:InvokeFunction
aws lambda add-permission   --function-name "arn:aws:lambda:us-east-1:996427988132:function:user-preference-api:$LAMBDA_VERSION"   --source-arn  "arn:aws:execute-api:us-east-1:996427988132:fm1l6yqvdg/*" --region us-east-1  --principal apigateway.amazonaws.com   --statement-id lambda_version_up   --action lambda:InvokeFunction
