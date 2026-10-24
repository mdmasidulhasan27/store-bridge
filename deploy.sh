#!/bin/sh
# Deploy StoreBridge to Cloud Run.
#
# Required environment:
#   PROJECT_ID               GCP project id
#   SERVICE_REGION           e.g. asia-south1
#   INSTANCE_CONNECTION_NAME Cloud SQL instance connection name
#   SHOPIFY_APP_URL          public service URL (use a placeholder on the first run)
#   SCOPES                   comma-separated scopes (`shopify app info --web-env`)
#
# If the KENO_* secrets exist, append them to --set-secrets:
#   ,KENO_SHOP=keno-shop:latest,KENO_CLIENT_ID=keno-client-id:latest,KENO_CLIENT_SECRET=keno-client-secret:latest
#
# --set-env-vars is prefixed with `^|^` to switch gcloud's key/value separator off
# the comma, because SCOPES is itself a comma-separated list.
set -e

: "${PROJECT_ID:?set PROJECT_ID}"
: "${SERVICE_REGION:?set SERVICE_REGION}"
: "${INSTANCE_CONNECTION_NAME:?set INSTANCE_CONNECTION_NAME}"
: "${SHOPIFY_APP_URL:?set SHOPIFY_APP_URL}"
: "${SCOPES:?set SCOPES}"
SERVICE_NAME="${SERVICE_NAME:-storebridge}"

gcloud run deploy "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --source . \
  --region "$SERVICE_REGION" \
  --port 3000 \
  --allow-unauthenticated \
  --add-cloudsql-instances "$INSTANCE_CONNECTION_NAME" \
  --min-instances 1 \
  --max-instances 3 \
  --memory 1Gi \
  --timeout 300 \
  --set-env-vars "^|^SCOPES=${SCOPES}|SHOPIFY_APP_URL=${SHOPIFY_APP_URL}|INSTANCE_CONNECTION_NAME=${INSTANCE_CONNECTION_NAME}" \
  --set-secrets "SHOPIFY_API_KEY=shopify-api-key:latest,SHOPIFY_API_SECRET=shopify-api-secret:latest,DATABASE_URL=database-url:latest,BELWARI_SHOP=belwari-shop:latest,BELWARI_CLIENT_ID=belwari-client-id:latest,BELWARI_CLIENT_SECRET=belwari-client-secret:latest"
