#!/bin/bash
# Authenticate the local machine to Google Cloud and prepare the project so the
# credential-vault scripts can pull delta.com login secrets from Secret Manager.
#
# Usage:  sh scripts/gcloud/auth.sh
# This is interactive (opens a browser). In a Claude Code session run it with
# the leading `!` so the OAuth output lands in the conversation:
#     ! sh scripts/gcloud/auth.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/config.sh"

echo "🔐 Google Cloud auth for project: $GCP_PROJECT"

# --- 1. Ensure gcloud is installed -----------------------------------------
if ! command -v gcloud >/dev/null 2>&1; then
  echo "❌ gcloud (Google Cloud SDK) is not installed."
  echo
  echo "   macOS (Homebrew):"
  echo "     brew install --cask google-cloud-sdk"
  echo
  echo "   Or the official installer:"
  echo "     https://cloud.google.com/sdk/docs/install"
  echo
  echo "   Then re-run:  sh scripts/gcloud/auth.sh"
  exit 1
fi

echo "✅ gcloud found: $(gcloud --version | head -1)"

# --- 2. User login (for gcloud CLI commands) -------------------------------
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
  echo "👤 No active account — launching login..."
  gcloud auth login
else
  echo "✅ Active account: $(gcloud auth list --filter=status:ACTIVE --format='value(account)')"
fi

# --- 3. Pin the project ----------------------------------------------------
gcloud config set project "$GCP_PROJECT"

# --- 4. Application Default Credentials (for client libraries) --------------
# This is the credential the Node Secret Manager client reads. It is written to
#   ~/.config/gcloud/application_default_credentials.json
echo "🔑 Setting up Application Default Credentials..."
gcloud auth application-default login

# Pin the quota/billing project used by ADC requests.
gcloud auth application-default set-quota-project "$GCP_PROJECT"

# --- 5. Make sure Secret Manager is enabled --------------------------------
echo "🧩 Ensuring Secret Manager API is enabled..."
gcloud services enable secretmanager.googleapis.com --project "$GCP_PROJECT" || \
  echo "⚠️  Could not enable secretmanager.googleapis.com automatically — enable it in the console if the next step fails."

echo
echo "✨ Done. You are authenticated to '$GCP_PROJECT' and ADC is ready."
echo "   Next:"
echo "     1. Seed your delta.com login:   sh scripts/gcloud/put-delta-credentials.sh"
echo "     2. Verify the pull works:        npm run delta:creds:get"
