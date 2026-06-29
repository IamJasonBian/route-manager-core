#!/bin/bash
# One-time (or on-rotation) seeding of your delta.com login into GCP Secret
# Manager. Reads the values from interactive prompts only — never from argv or
# shell history — and pipes them straight into Secret Manager.
#
# Usage:  sh scripts/gcloud/put-delta-credentials.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/config.sh"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "❌ gcloud not installed. Run scripts/gcloud/auth.sh first."
  exit 1
fi

echo "🔐 Storing delta.com credentials in Secret Manager (project: $GCP_PROJECT)"
echo "   Secrets: $DELTA_USERNAME_SECRET, $DELTA_PASSWORD_SECRET"
echo

# Prompt without echoing the password.
printf "delta.com username/email: "
read -r DELTA_USER
printf "delta.com password: "
stty -echo
read -r DELTA_PASS
stty echo
printf "\n"

if [ -z "$DELTA_USER" ] || [ -z "$DELTA_PASS" ]; then
  echo "❌ Username and password are both required."
  exit 1
fi

# create_or_add <secret-name> <value>
create_or_add() {
  name="$1"; value="$2"
  if gcloud secrets describe "$name" --project "$GCP_PROJECT" >/dev/null 2>&1; then
    printf "%s" "$value" | gcloud secrets versions add "$name" \
      --project "$GCP_PROJECT" --data-file=-
    echo "  ↻ added new version of $name"
  else
    printf "%s" "$value" | gcloud secrets create "$name" \
      --project "$GCP_PROJECT" --replication-policy="automatic" --data-file=-
    echo "  ＋ created $name"
  fi
}

create_or_add "$DELTA_USERNAME_SECRET" "$DELTA_USER"
create_or_add "$DELTA_PASSWORD_SECRET" "$DELTA_PASS"

# Wipe the plaintext from the shell's memory as best we can.
unset DELTA_USER DELTA_PASS

echo
echo "✅ Stored. Verify the pull with:  npm run delta:creds:get"
