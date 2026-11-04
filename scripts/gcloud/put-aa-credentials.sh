#!/bin/bash
# One-time (or on-rotation) seeding of your aa.com (American Airlines) login into
# GCP Secret Manager. Reads the values from interactive prompts only — never from
# argv or shell history — and pipes them straight into Secret Manager.
#
# Mirrors put-delta-credentials.sh.
#
# Usage:  sh scripts/gcloud/put-aa-credentials.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/config.sh"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "❌ gcloud not installed. Run scripts/gcloud/auth.sh first."
  exit 1
fi

echo "🔐 Storing aa.com credentials in Secret Manager (project: $GCP_PROJECT)"
echo "   Secrets: $AA_USERNAME_SECRET, $AA_PASSWORD_SECRET"
echo

# Prompt without echoing the password.
printf "aa.com AAdvantage number / username: "
read -r AA_USER
printf "aa.com password: "
stty -echo
read -r AA_PASS
stty echo
printf "\n"

if [ -z "$AA_USER" ] || [ -z "$AA_PASS" ]; then
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

create_or_add "$AA_USERNAME_SECRET" "$AA_USER"
create_or_add "$AA_PASSWORD_SECRET" "$AA_PASS"

# Wipe the plaintext from the shell's memory as best we can.
unset AA_USER AA_PASS

echo
echo "✅ Stored. Verify the pull with:  npm run aa:creds:get"
